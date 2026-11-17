import { useEffect, useState, type ReactElement } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Drawer,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Typography,
} from 'antd';
import type { AcpClient } from '@trinity-harness/client-acp';
import {
  llmConfigurationSchema,
  newId,
  type User,
  type Role,
  type LlmConfiguration,
  type LlmConfigurationState,
  type LlmHealthSnapshot,
  type LlmProbeResult,
  type LlmActivity,
  type LlmProfilesResponse,
  type LlmSessionSettings,
  type LlmSessionSettingsResponse,
} from '@trinity-harness/shared';

const empty: LlmConfiguration = {
  connections: [],
  deployments: [],
  profiles: [],
  defaultProfileId: '',
};
const explain = (error: unknown): string =>
  error instanceof Error ? error.message : 'Operation unavailable';

export function LlmAdministration({
  client,
  onClose,
}: {
  client: AcpClient;
  onClose: () => void;
}): ReactElement {
  const { modal } = App.useApp();
  const [form] = Form.useForm<LlmConfiguration>();
  const config = Form.useWatch([], form) as LlmConfiguration | undefined;
  const [state, setState] = useState<LlmConfigurationState | null>(null);
  const [health, setHealth] = useState<LlmHealthSnapshot[]>([]);
  const [tests, setTests] = useState<LlmProbeResult[]>([]);
  const [activity, setActivity] = useState<LlmActivity[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [keyFor, setKeyFor] = useState<string>();
  const [key, setKey] = useState('');
  const [restore, setRestore] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void client
      .getLlmConfiguration(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setState(value);
          form.setFieldsValue(value.draft ?? empty);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(explain(cause));
      });
    return () => {
      controller.abort();
    };
  }, [client, form]);
  async function run(action: () => Promise<LlmConfigurationState>): Promise<boolean> {
    setBusy(true);
    setError('');
    try {
      setState(await action());
      return true;
    } catch (cause) {
      setError(explain(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }
  function close(): void {
    if (dirty) modal.confirm({ title: 'Discard unsaved AI configuration edits?', onOk: onClose });
    else onClose();
  }
  async function save(): Promise<void> {
    if (!state) return;
    const value = llmConfigurationSchema.safeParse(form.getFieldsValue(true));
    if (!value.success) {
      setError(value.error.issues.map((issue) => issue.message).join('; '));
      return;
    }
    if (await run(() => client.saveLlmConfiguration(state.version, value.data))) setDirty(false);
  }
  async function publish(): Promise<void> {
    if (!state?.draft) return;
    if (dirty) {
      setError('Save your current edits before reviewing publication.');
      return;
    }
    setBusy(true);
    setError('');
    let impact;
    try {
      impact = await client.getLlmImpact(state.version);
    } catch (cause) {
      setError(explain(cause));
      return;
    } finally {
      setBusy(false);
    }
    const total = impact.bindings.reduce((count, binding) => count + binding.sessions, 0);
    const pins = impact.bindings.reduce((count, binding) => count + binding.pins, 0);
    modal.confirm({
      title: 'Publish AI routing?',
      content: `Revision ${state.version}: ${total} bound conversations, including ${pins} pins; ${impact.unboundSessions} conversations have no binding. Counts reflect this review. Bound conversations follow their profile on the next model request. Pins remain pinned. New conversations use the selected default. Current streams and tools continue. Existing conversations without a profile must select one before continuing.`,
      onOk: () =>
        run(() =>
          client.publishLlmConfiguration(
            state.version,
            reason || 'Publish reviewed AI configuration',
          ),
        ),
    });
  }
  function backup(profileId: string, deploymentId: string): void {
    if (!state?.published) return;
    const published = state.published;
    modal.confirm({
      title: 'Switch this profile to its prepared backup?',
      content:
        'This saves a draft from the current publication and publishes it. Other draft changes are replaced. Bound conversations switch on their next request; pinned conversations keep their deployment. Restore the primary explicitly when ready.',
      onOk: async () => {
        const next = structuredClone(published);
        const profile = next.profiles.find((row) => row.id === profileId)!;
        const old = profile.primary;
        profile.primary = deploymentId;
        profile.backups = [old, ...profile.backups.filter((id) => id !== deploymentId)].slice(0, 3);
        await run(async () => {
          const draft = await client.saveLlmConfiguration(state.version, next);
          const result = await client.publishLlmConfiguration(
            draft.version,
            `Emergency switch: ${profile.name}`,
          );
          form.setFieldsValue(next);
          setDirty(false);
          return result;
        });
      },
    });
  }
  const deploymentOptions =
    config?.deployments?.map((row) => ({ value: row.id, label: row.name })) ?? [];
  return (
    <Drawer
      open
      title="Administration · AI configuration"
      width={860}
      onClose={busy ? undefined : close}
      maskClosable={!busy}
      autoFocus={false}
    >
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
      {!state ? (
        <Spin />
      ) : (
        <>
          <Alert
            type="info"
            message={`Source: ${state.source} · Draft version ${state.version} · Published revision ${state.activeRevision ?? 'none'}`}
            description="Keys stay on the server and cannot be read back. Publishing activates database configuration. Future configuration or key-service failures block requests until repaired."
          />
          <Form
            form={form}
            layout="vertical"
            disabled={busy}
            onValuesChange={() => setDirty(true)}
            style={{ marginTop: 16 }}
          >
            <Tabs
              items={[
                {
                  key: 'connections',
                  label: 'Connections',
                  children: (
                    <>
                      <Form.List name="connections">
                        {(fields, { add, remove }) => (
                          <Space direction="vertical" style={{ width: '100%' }}>
                            {fields.map((field) => (
                              <Card
                                key={field.key}
                                size="small"
                                title={config?.connections?.[field.name]?.name || 'Connection'}
                                extra={
                                  <Button onClick={() => remove(field.name)}>
                                    Remove from draft
                                  </Button>
                                }
                              >
                                <Form.Item name={[field.name, 'id']} hidden>
                                  <Input />
                                </Form.Item>
                                <Form.Item label="Connection name" name={[field.name, 'name']}>
                                  <Input maxLength={100} />
                                </Form.Item>
                                <Form.Item label="Protocol" name={[field.name, 'adapter']}>
                                  <Select
                                    options={['anthropic', 'openai'].map((value) => ({
                                      value,
                                      label: value,
                                    }))}
                                  />
                                </Form.Item>
                                <Form.Item label="Endpoint" name={[field.name, 'endpoint']}>
                                  <Input
                                    maxLength={2048}
                                    placeholder="https://provider.example/v1"
                                  />
                                </Form.Item>
                                <Form.Item
                                  label="Enabled"
                                  name={[field.name, 'enabled']}
                                  valuePropName="checked"
                                >
                                  <Switch />
                                </Form.Item>
                                <Space wrap>
                                  <Typography.Text>
                                    {state.credentials.some(
                                      (row) =>
                                        row.connectionId ===
                                          config?.connections?.[field.name]?.id && !row.revoked,
                                    )
                                      ? 'Key configured'
                                      : 'Key unavailable'}
                                  </Typography.Text>
                                  <Button
                                    disabled={
                                      busy ||
                                      !state.draft?.deployments.some(
                                        (row) =>
                                          row.connectionId ===
                                          config?.connections?.[field.name]?.id,
                                      )
                                    }
                                    onClick={() =>
                                      modal.confirm({
                                        title: 'Run a synthetic connection test?',
                                        content:
                                          'This sends a short synthetic prompt to each enabled saved deployment on this connection, one at a time. It may incur provider charges and consumes tenant quota. It does not send conversation content or certify tool/image support. Tests are limited to ten per hour per tenant.',
                                        onOk: async () => {
                                          setBusy(true);
                                          setError('');
                                          try {
                                            for (const deployment of state.draft!.deployments.filter(
                                              (row) =>
                                                row.connectionId ===
                                                  config!.connections[field.name]!.id &&
                                                row.enabled,
                                            )) {
                                              const result = await client.testLlmConnection(
                                                deployment.connectionId,
                                                deployment.id,
                                                state.version,
                                              );
                                              setTests((current) => [result, ...current]);
                                            }
                                          } catch (cause) {
                                            setError(explain(cause));
                                          } finally {
                                            setBusy(false);
                                          }
                                        },
                                      })
                                    }
                                  >
                                    Test saved connection
                                  </Button>
                                  <Button
                                    onClick={() => {
                                      setKey('');
                                      setKeyFor(config?.connections?.[field.name]?.id);
                                    }}
                                  >
                                    Replace key
                                  </Button>
                                  <Button
                                    danger
                                    onClick={() =>
                                      modal.confirm({
                                        title: 'Revoke credentials for this connection?',
                                        content:
                                          'Future requests using this connection will be blocked, including older publications. Configuration rollback cannot undo revocation.',
                                        onOk: () =>
                                          run(() =>
                                            client.revokeLlmCredential(
                                              config!.connections[field.name]!.id,
                                              state.version,
                                            ),
                                          ),
                                      })
                                    }
                                  >
                                    Revoke key
                                  </Button>
                                </Space>
                                <Typography.Paragraph type="secondary">
                                  Save the connection draft before replacing its key. Health is
                                  Unknown until a separately recorded test or request.
                                </Typography.Paragraph>
                              </Card>
                            ))}
                            <Button
                              onClick={() =>
                                add({
                                  id: newId(),
                                  name: 'New connection',
                                  adapter: 'anthropic',
                                  endpoint: 'https://api.anthropic.com/v1',
                                  enabled: true,
                                })
                              }
                            >
                              Add connection
                            </Button>
                          </Space>
                        )}
                      </Form.List>
                      <Form.List name="deployments">
                        {(fields, { add, remove }) => (
                          <Space direction="vertical" style={{ width: '100%', marginTop: 16 }}>
                            {fields.map((field) => (
                              <Card
                                key={field.key}
                                size="small"
                                title="Model deployment"
                                extra={
                                  <Button onClick={() => remove(field.name)}>
                                    Remove from draft
                                  </Button>
                                }
                              >
                                <Form.Item name={[field.name, 'id']} hidden>
                                  <Input />
                                </Form.Item>
                                <Form.Item label="Deployment name" name={[field.name, 'name']}>
                                  <Input maxLength={100} />
                                </Form.Item>
                                <Form.Item label="Connection" name={[field.name, 'connectionId']}>
                                  <Select
                                    options={config?.connections?.map((row) => ({
                                      value: row.id,
                                      label: row.name,
                                    }))}
                                  />
                                </Form.Item>
                                <Form.Item label="Upstream model ID" name={[field.name, 'modelId']}>
                                  <Input maxLength={256} />
                                </Form.Item>
                                <Form.Item
                                  label="Pricing catalog key"
                                  name={[field.name, 'pricingKey']}
                                  tooltip="Must match the operator's fixed pricing catalog for cost-limited tasks."
                                >
                                  <Input maxLength={200} />
                                </Form.Item>
                                <Flex gap={12} wrap>
                                  <Form.Item
                                    label="Context tokens"
                                    name={[field.name, 'contextTokens']}
                                  >
                                    <InputNumber min={1024} max={10000000} />
                                  </Form.Item>
                                  <Form.Item
                                    label="Output tokens"
                                    name={[field.name, 'outputTokens']}
                                  >
                                    <InputNumber min={1} max={1000000} />
                                  </Form.Item>
                                  <Form.Item
                                    label="Enabled"
                                    name={[field.name, 'enabled']}
                                    valuePropName="checked"
                                  >
                                    <Switch />
                                  </Form.Item>
                                </Flex>
                                <Flex gap={16} wrap>
                                  {['tools', 'images', 'files', 'reasoning'].map((capability) => (
                                    <Form.Item
                                      key={capability}
                                      label={capability}
                                      name={[field.name, 'capabilities', capability]}
                                      valuePropName="checked"
                                    >
                                      <Switch />
                                    </Form.Item>
                                  ))}
                                </Flex>
                                <Form.Item
                                  label="Anthropic thinking"
                                  name={[field.name, 'settings', 'thinkingType']}
                                >
                                  <Select
                                    allowClear
                                    options={['adaptive', 'enabled', 'disabled'].map((value) => ({
                                      value,
                                      label: value,
                                    }))}
                                  />
                                </Form.Item>
                                <Form.Item
                                  label="Anthropic reasoning budget"
                                  name={[field.name, 'settings', 'reasoningBudgetTokens']}
                                >
                                  <InputNumber min={1} max={1000000} />
                                </Form.Item>
                                <Form.Item
                                  label="OpenAI reasoning effort"
                                  name={[field.name, 'settings', 'reasoningEffort']}
                                >
                                  <Select
                                    allowClear
                                    options={[
                                      'none',
                                      'minimal',
                                      'low',
                                      'medium',
                                      'high',
                                      'xhigh',
                                    ].map((value) => ({ value, label: value }))}
                                  />
                                </Form.Item>
                              </Card>
                            ))}
                            <Button
                              onClick={() =>
                                add({
                                  id: newId(),
                                  name: 'New model',
                                  connectionId: config?.connections?.[0]?.id ?? '',
                                  modelId: '',
                                  pricingKey: '',
                                  enabled: true,
                                  contextTokens: 200000,
                                  outputTokens: 8192,
                                  capabilities: {
                                    tools: true,
                                    images: false,
                                    files: false,
                                    reasoning: false,
                                  },
                                  settings: {},
                                })
                              }
                            >
                              Add model deployment
                            </Button>
                          </Space>
                        )}
                      </Form.List>
                    </>
                  ),
                },
                {
                  key: 'routing',
                  label: 'Routing',
                  children: (
                    <>
                      <Form.Item
                        label="Default profile for new conversations"
                        name="defaultProfileId"
                      >
                        <Select
                          options={config?.profiles?.map((row) => ({
                            value: row.id,
                            label: row.name,
                          }))}
                        />
                      </Form.Item>
                      <Form.List name="profiles">
                        {(fields, { add, remove }) => (
                          <Space direction="vertical" style={{ width: '100%' }}>
                            {fields.map((field) => (
                              <Card
                                key={field.key}
                                size="small"
                                title="Routing profile"
                                extra={
                                  <Button onClick={() => remove(field.name)}>
                                    Remove from draft
                                  </Button>
                                }
                              >
                                <Form.Item name={[field.name, 'id']} hidden>
                                  <Input />
                                </Form.Item>
                                <Form.Item label="Profile name" name={[field.name, 'name']}>
                                  <Input maxLength={100} />
                                </Form.Item>
                                <Form.Item
                                  label="Approved destinations and deployments"
                                  name={[field.name, 'allowedDeployments']}
                                  tooltip="Conversation data may be sent to these deployments. Only approve destinations permitted for this profile."
                                >
                                  <Select mode="multiple" options={deploymentOptions} />
                                </Form.Item>
                                <Form.Item
                                  label="Primary deployment"
                                  name={[field.name, 'primary']}
                                >
                                  <Select options={deploymentOptions} />
                                </Form.Item>
                                <Form.Item
                                  label="Ordered backups (up to three)"
                                  name={[field.name, 'backups']}
                                >
                                  <Select
                                    mode="multiple"
                                    maxCount={3}
                                    options={deploymentOptions}
                                  />
                                </Form.Item>
                                <Form.Item label="Fallback" name={[field.name, 'mode']}>
                                  <Select
                                    options={[
                                      { value: 'manual', label: 'Manual switch' },
                                      {
                                        value: 'automatic',
                                        label: 'Automatic · before any output',
                                      },
                                    ]}
                                  />
                                </Form.Item>
                                <Form.Item
                                  label="Maximum output tokens"
                                  name={[field.name, 'maxOutputTokens']}
                                >
                                  <InputNumber min={1} max={1000000} />
                                </Form.Item>
                                <Form.Item
                                  label="Permitted OpenAI reasoning efforts"
                                  name={[field.name, 'reasoningEfforts']}
                                >
                                  <Select
                                    mode="multiple"
                                    maxCount={6}
                                    options={[
                                      'none',
                                      'minimal',
                                      'low',
                                      'medium',
                                      'high',
                                      'xhigh',
                                    ].map((value) => ({ value, label: value }))}
                                  />
                                </Form.Item>
                                <Form.Item
                                  label="Maximum Anthropic reasoning tokens"
                                  name={[field.name, 'maxReasoningTokens']}
                                >
                                  <InputNumber min={1024} max={1000000} />
                                </Form.Item>
                              </Card>
                            ))}
                            <Button
                              onClick={() =>
                                add({
                                  id: newId(),
                                  name: 'New profile',
                                  primary: config?.deployments?.[0]?.id ?? '',
                                  backups: [],
                                  mode: 'manual',
                                  allowedDeployments: config?.deployments?.[0]
                                    ? [config.deployments[0].id]
                                    : [],
                                  maxOutputTokens: 8192,
                                })
                              }
                            >
                              Add profile
                            </Button>
                          </Space>
                        )}
                      </Form.List>
                      {state.published?.profiles.map((profile) => (
                        <Card
                          key={profile.id}
                          size="small"
                          title={`Published · ${profile.name}`}
                          style={{ marginTop: 16 }}
                        >
                          <Space wrap>
                            {profile.backups.map((id) => (
                              <Button
                                key={id}
                                disabled={busy}
                                onClick={() => backup(profile.id, id)}
                              >
                                Use backup:{' '}
                                {state.published!.deployments.find((row) => row.id === id)?.name}
                              </Button>
                            ))}
                          </Space>
                        </Card>
                      ))}
                    </>
                  ),
                },
                {
                  key: 'users',
                  label: 'Users and roles',
                  children: <TenantUserRoles client={client} />,
                },
                {
                  key: 'activity',
                  label: 'Activity',
                  children: (
                    <Space direction="vertical">
                      <Button
                        onClick={() => {
                          void Promise.all([
                            client.getLlmActivity(),
                            client.getLlmTests(),
                            client.getLlmHealth(),
                          ])
                            .then(([rows, probes, snapshots]) => {
                              setActivity(rows);
                              setTests(probes);
                              setHealth(snapshots);
                            })
                            .catch((cause) => setError(explain(cause)));
                        }}
                      >
                        Refresh activity
                      </Button>
                      {state.published?.deployments.map((deployment) => {
                        const key = state.credentials.find(
                          (row) => row.connectionId === deployment.connectionId,
                        );
                        const snapshot = health.find(
                          (row) =>
                            row.deploymentId === deployment.id &&
                            row.credentialVersionId === key?.versionId,
                        );
                        return (
                          <Typography.Paragraph key={deployment.id}>
                            {deployment.name} ·{' '}
                            {snapshot
                              ? `Circuit ${snapshot.state} · ${snapshot.observedAt}`
                              : 'Health unknown'}
                            {snapshot?.credentialBlocked ? ' · Credential needs attention' : ''}
                            {snapshot?.retryAt ? ` · Retry after ${snapshot.retryAt}` : ''}
                          </Typography.Paragraph>
                        );
                      })}
                      {tests.map((row) => (
                        <Typography.Paragraph key={row.operationId}>
                          {row.at} · Synthetic test ·{' '}
                          {state.draft?.deployments.find(
                            (deployment) => deployment.id === row.deploymentId,
                          )?.name ?? 'Deployment'}{' '}
                          · {row.status} · configuration v{row.version}
                        </Typography.Paragraph>
                      ))}
                      {activity.map((row) => (
                        <Typography.Paragraph key={row.id}>
                          {row.at} · {row.action} · v{row.version} · {row.reason}
                        </Typography.Paragraph>
                      ))}
                      <InputNumber
                        aria-label="Revision to restore"
                        min={1}
                        value={restore}
                        onChange={setRestore}
                      />
                      <Button
                        disabled={!restore || busy}
                        onClick={() => {
                          setBusy(true);
                          void client
                            .getLlmRevision(restore!)
                            .then((target) => {
                              modal.confirm({
                                title: `Publish revision ${restore} as a new revision?`,
                                content: `Profiles: ${target.profiles.map((profile) => profile.name + ': ' + (target.deployments.find((deployment) => deployment.id === profile.primary)?.name ?? 'unavailable')).join('; ')}. Current credential revocations, disabled destinations and operator policy still apply.`,
                                onOk: () =>
                                  run(async () => {
                                    const value = await client.publishLlmConfiguration(
                                      state.version,
                                      reason || 'Restore reviewed configuration',
                                      restore!,
                                    );
                                    form.setFieldsValue(value.draft ?? empty);
                                    setDirty(false);
                                    return value;
                                  }),
                              });
                            })
                            .catch((cause) => setError(explain(cause)))
                            .finally(() => setBusy(false));
                        }}
                      >
                        Restore revision
                      </Button>
                    </Space>
                  ),
                },
              ]}
            />
            <Form.Item label="Publication reason" htmlFor="llm-publication-reason">
              <Input
                value={reason}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
              />
            </Form.Item>
            <Flex gap={8} wrap>
              <Button loading={busy} onClick={() => void save()}>
                Save draft
              </Button>
              <Button type="primary" disabled={!state.draft || busy} onClick={() => void publish()}>
                Review and publish saved draft
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  modal.confirm({
                    title: 'Reload and discard local edits?',
                    onOk: () =>
                      run(async () => {
                        const value = await client.getLlmConfiguration();
                        form.resetFields();
                        form.setFieldsValue(value.draft ?? empty);
                        setDirty(false);
                        return value;
                      }),
                  })
                }
              >
                Reload
              </Button>
            </Flex>
          </Form>
        </>
      )}
      {keyFor && (
        <Modal
          open
          title="Replace server-side key"
          onCancel={() => {
            setKey('');
            setKeyFor(undefined);
          }}
          destroyOnHidden
          onOk={() => {
            const connectionId = keyFor;
            const secret = key;
            setKey('');
            setKeyFor(undefined);
            if (state && connectionId)
              void run(() => client.replaceLlmCredential(connectionId, state.version, secret));
          }}
          okButtonProps={{ disabled: !key || busy }}
        >
          <Alert
            type="info"
            message="Write-only replacement. The key cannot be recovered from the application."
          />
          <Input.Password
            aria-label="Provider API key"
            value={key}
            maxLength={16384}
            autoComplete="new-password"
            onChange={(event) => setKey(event.target.value)}
          />
        </Modal>
      )}
    </Drawer>
  );
}

export function LlmSessionSettings({
  client,
  sessionId,
  readOnly,
}: {
  client: AcpClient;
  sessionId: string;
  readOnly: boolean;
}): ReactElement | null {
  const [profiles, setProfiles] = useState<LlmProfilesResponse>();
  const [current, setCurrent] = useState<LlmSessionSettingsResponse>();
  const [settings, setSettings] = useState<LlmSessionSettings>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      client.getLlmProfiles(controller.signal),
      client.getLlmSessionSettings(sessionId, controller.signal),
    ])
      .then(([catalog, saved]) => {
        if (controller.signal.aborted) return;
        setProfiles(catalog);
        setCurrent(saved);
        if (saved.settings) setSettings(saved.settings);
        else if (catalog.defaultProfileId) setSettings({ profileId: catalog.defaultProfileId });
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(explain(cause));
      });
    return () => controller.abort();
  }, [client, sessionId]);
  const profile = profiles?.profiles.find((row) => row.id === settings?.profileId);
  if (profiles && !profiles.available)
    return (
      <Alert
        type="info"
        message="AI profiles are not configured. This conversation uses the deployment's existing model configuration."
      />
    );
  return (
    <Space direction="vertical" style={{ width: '100%', marginTop: 16 }}>
      <Typography.Title level={5}>AI profile</Typography.Title>
      {error && <Alert type="error" message={error} />}
      <Select
        aria-label="AI profile"
        style={{ width: '100%' }}
        disabled={readOnly || busy}
        value={settings?.profileId}
        options={profiles?.profiles.map((row) => ({ value: row.id, label: row.name }))}
        onChange={(profileId) => setSettings({ profileId })}
      />
      {profiles?.canTune && settings && (
        <>
          <Typography.Text>Advanced settings</Typography.Text>
          {!!profile?.reasoningEfforts?.length && (
            <Select
              aria-label="Session reasoning effort"
              allowClear
              style={{ width: '100%' }}
              placeholder="Published reasoning settings"
              value={settings.reasoningEffort}
              options={profile.reasoningEfforts.map((value) => ({ value, label: value }))}
              onChange={(value) => {
                const next = { ...settings };
                if (value) next.reasoningEffort = value;
                else delete next.reasoningEffort;
                setSettings(next);
              }}
            />
          )}
          {!!profile?.maxReasoningTokens && (
            <InputNumber
              aria-label="Session reasoning budget tokens"
              min={1024}
              max={profile.maxReasoningTokens}
              value={settings.reasoningBudgetTokens}
              onChange={(value) => {
                const next = { ...settings };
                if (value) next.reasoningBudgetTokens = value;
                else delete next.reasoningBudgetTokens;
                setSettings(next);
              }}
            />
          )}
          <Select
            aria-label="Pinned deployment"
            style={{ width: '100%' }}
            allowClear
            placeholder="Follow the published profile"
            disabled={busy}
            value={settings.pinnedDeploymentId}
            options={profile?.deployments?.map((row) => ({ value: row.id, label: row.name }))}
            onChange={(pinnedDeploymentId) => {
              const next = { ...settings };
              if (pinnedDeploymentId) next.pinnedDeploymentId = pinnedDeploymentId;
              else delete next.pinnedDeploymentId;
              setSettings(next);
            }}
          />
          <InputNumber
            aria-label="Maximum session output tokens"
            min={1}
            max={profile?.maxOutputTokens}
            value={settings.maxOutputTokens}
            disabled={busy}
            onChange={(value) => {
              const next = { ...settings };
              if (value) next.maxOutputTokens = value;
              else delete next.maxOutputTokens;
              setSettings(next);
            }}
          />
          <Select
            aria-label="Session backup order"
            mode="multiple"
            style={{ width: '100%' }}
            placeholder="Published backup order"
            disabled={busy}
            value={settings.backups}
            options={profile?.backups?.map((id) => ({
              value: id,
              label: profile.deployments?.find((row) => row.id === id)?.name ?? id,
            }))}
            onChange={(backups) => setSettings({ ...settings, backups })}
          />
        </>
      )}
      {!readOnly && (
        <Flex gap={8}>
          <Button
            disabled={!settings || !current || busy}
            loading={busy}
            onClick={() => {
              if (!settings || !current) return;
              setBusy(true);
              setError('');
              void client
                .setLlmSessionSettings(sessionId, current.expectedLastSeq, settings)
                .then(() => client.getLlmSessionSettings(sessionId))
                .then(setCurrent)
                .catch((cause) => setError(explain(cause)))
                .finally(() => setBusy(false));
            }}
          >
            Save AI settings
          </Button>
          <Button
            disabled={!settings || busy}
            onClick={() => settings && setSettings({ profileId: settings.profileId })}
          >
            Reset advanced settings
          </Button>
        </Flex>
      )}
      <Typography.Text type="secondary">
        Changes apply at the next model request. Changing the tenant default does not move a bound
        conversation. A pin disables automatic fallback.
      </Typography.Text>
    </Space>
  );
}

function TenantUserRoles({ client }: { client: AcpClient }): ReactElement {
  const { modal } = App.useApp();
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void client
      .listTenantUsers()
      .then((value) => {
        if (live) setUsers(value);
      })
      .catch((cause) => {
        if (live) setError(explain(cause));
      });
    return () => {
      live = false;
    };
  }, [client]);
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Alert
        type="info"
        message="Admin manages tenant configuration. Expert has advanced session controls. Member has full assistant access. Viewer is read-only. Roles never bypass tool approval or session access."
      />
      {error && <Alert type="error" message={error} />}
      {users.map((user) => (
        <Flex key={user.id} gap={16} wrap align="center">
          <Typography.Text>{user.email}</Typography.Text>
          <Select
            aria-label={`Role for ${user.email}`}
            style={{ width: 150 }}
            disabled={busy}
            value={user.role}
            options={['admin', 'expert', 'member', 'viewer'].map((role) => ({
              value: role,
              label: role[0]!.toUpperCase() + role.slice(1),
            }))}
            onChange={(role: Role) =>
              modal.confirm({
                title: `Change ${user.email} to ${role}?`,
                content:
                  'Current authorization is checked again for future operations. Downgrading Expert settings requires resetting them. The final tenant Admin is protected.',
                onOk: async () => {
                  setBusy(true);
                  setError('');
                  try {
                    await client.setTenantUserRole(user.id, role);
                    setUsers(await client.listTenantUsers());
                  } catch (cause) {
                    setError(explain(cause));
                  } finally {
                    setBusy(false);
                  }
                },
              })
            }
          />
        </Flex>
      ))}
    </Space>
  );
}
