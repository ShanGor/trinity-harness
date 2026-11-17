import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  Alert,
  App,
  Button,
  Collapse,
  Drawer,
  Flex,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popover,
  Select,
  Space,
  Spin,
  Switch,
  Typography,
} from 'antd';
import type { AcpClient } from '@trinity-harness/client-acp';
import {
  newId,
  type User,
  type Role,
  type LlmProviderSettings,
  type LlmProviderSettingsResponse,
  type LlmModelsResponse,
  type LlmSessionSettings,
  type LlmSessionSettingsResponse,
} from '@trinity-harness/shared';

const explain = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'Operation unavailable';
const presets = {
  kimi: {
    name: 'Kimi Code · China',
    adapter: 'openai' as const,
    endpoint: 'https://api.kimi.com/coding/v1',
    model: 'k3-256k',
    context: 262144,
    reasoning: true,
  },
  minimax: {
    name: 'MiniMax · China',
    adapter: 'anthropic' as const,
    endpoint: 'https://api.minimax.cn/anthropic/v1',
    model: 'MiniMax-M3.1-Flash',
    context: 1000000,
    reasoning: true,
  },
  anthropic: {
    name: 'Anthropic',
    adapter: 'anthropic' as const,
    endpoint: 'https://api.anthropic.com/v1',
    model: '',
    context: 200000,
    reasoning: false,
  },
  openai: {
    name: 'OpenAI',
    adapter: 'openai' as const,
    endpoint: 'https://api.openai.com/v1',
    model: '',
    context: 128000,
    reasoning: false,
  },
  custom: {
    name: 'Custom connection',
    adapter: 'openai' as const,
    endpoint: '',
    model: '',
    context: 32768,
    reasoning: false,
  },
};
const refKey = (ref: { providerId: string; modelId: string }): string =>
  JSON.stringify([ref.providerId, ref.modelId]);

export function LlmAdministration({
  client,
  onClose,
}: {
  client: AcpClient;
  onClose: () => void;
}): ReactElement {
  const { modal } = App.useApp();
  const [saved, setSaved] = useState<LlmProviderSettingsResponse>();
  const [draft, setDraft] = useState<LlmProviderSettings>();
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [providerKind, setProviderKind] = useState<keyof typeof presets>('kimi');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [activity, setActivity] = useState<Awaited<ReturnType<AcpClient['getLlmActivity']>>>([]);
  const operation = useRef<{ body: string; id: string } | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    void client
      .getLlmProviders(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setSaved(value);
          setDraft(value.settings);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(explain(cause));
      });
    return () => controller.abort();
  }, [client]);
  function edit(change: (value: LlmProviderSettings) => void): void {
    setDraft((value) => {
      if (!value) return value;
      const next = structuredClone(value);
      change(next);
      return next;
    });
    setDirty(true);
    setNotice('');
  }
  async function save(candidate = draft): Promise<void> {
    if (!candidate || !saved) return;
    for (const provider of candidate.providers) {
      if (!provider.name.trim()) {
        setError('Enter a connection name.');
        return;
      }
      if (!provider.endpoint.trim()) {
        setError(`Enter the endpoint for ${provider.name}.`);
        return;
      }
      if (
        provider.enabled &&
        !keys[provider.id] &&
        !saved.credentials.some((row) => row.providerId === provider.id && row.configured)
      ) {
        setError(`Enter the API key for ${provider.name}.`);
        return;
      }
    }
    if (candidate.models.some((model) => !model.modelId.trim())) {
      setError('Enter a model ID or remove the empty model before saving.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const entries = Object.entries(keys)
        .filter(
          ([providerId, secret]) =>
            secret && candidate.providers.some((provider) => provider.id === providerId),
        )
        .map(([providerId, secret]) => ({ providerId, secret }));
      const body = JSON.stringify({ version: saved.version, candidate, entries });
      if (operation.current?.body !== body) operation.current = { body, id: newId() };
      const value = await client.saveLlmProviders(
        saved.version,
        candidate,
        entries,
        operation.current.id,
      );
      operation.current = undefined;
      setSaved(value);
      setDraft(value.settings);
      setKeys({});
      setDirty(false);
      setEditingId(undefined);
      setNotice(
        value.settings.routing.defaultModel
          ? 'Connections and model settings saved.'
          : 'Connections saved. Choose a default model when you are ready.',
      );
    } catch (cause) {
      setError(explain(cause));
    } finally {
      setBusy(false);
    }
  }
  function openEditor(providerId?: string): void {
    if (!saved) return;
    const open = (): void => {
      const next = structuredClone(saved.settings);
      setKeys({});
      setError('');
      setNotice('');
      if (providerId) {
        setCreating(false);
        setEditingId(providerId);
        setDirty(false);
      } else {
        const id = newId();
        addPreset(next, id, 'kimi');
        setProviderKind('kimi');
        setCreating(true);
        setEditingId(id);
        setDirty(true);
      }
      setDraft(next);
    };
    if (dirty) modal.confirm({ title: 'Discard unsaved model settings?', onOk: open });
    else open();
  }
  function addPreset(value: LlmProviderSettings, id: string, kind: keyof typeof presets): void {
    const preset = presets[kind];
    value.providers = value.providers.filter((row) => row.id !== id);
    value.models = value.models.filter((row) => row.connectionId !== id);
    value.providers.push({
      id,
      name: preset.name,
      adapter: preset.adapter,
      endpoint: preset.endpoint,
      enabled: true,
    });
    if (preset.model)
      value.models.push({
        id: newId(),
        connectionId: id,
        name: preset.model,
        modelId: preset.model,
        pricingKey: 'unpriced',
        enabled: true,
        contextTokens: preset.context,
        outputTokens: 8192,
        capabilities: { tools: true, images: false, files: false, reasoning: preset.reasoning },
        settings: preset.reasoning
          ? preset.adapter === 'anthropic'
            ? { thinkingType: 'adaptive' }
            : { reasoningEffort: 'high' }
          : {},
      });
  }
  function cancelEditor(): void {
    const discard = (): void => {
      setEditingId(undefined);
      setDraft(saved?.settings);
      setKeys({});
      setDirty(false);
      setError('');
      operation.current = undefined;
    };
    discard();
  }
  function requestSave(candidate = draft): void {
    if (saved?.migrationRequired)
      modal.confirm({
        title: 'Replace legacy routing rules?',
        content:
          'Existing profile-bound conversations will require explicit model selection. Historical messages stay unchanged.',
        onOk: () => save(candidate),
      });
    else void save(candidate);
  }
  const models =
    draft?.models.filter(
      (model) =>
        model.enabled &&
        draft.providers.some((provider) => provider.id === model.connectionId && provider.enabled),
    ) ?? [];
  const options = models.map((model) => ({
    value: refKey({ providerId: model.connectionId, modelId: model.modelId }),
    label: `${draft!.providers.find((provider) => provider.id === model.connectionId)!.name} / ${model.modelId}`,
  }));
  return (
    <Drawer
      open
      width="min(720px, 100vw)"
      title="AI settings"
      onClose={
        busy
          ? undefined
          : () => {
              if (dirty)
                modal.confirm({ title: 'Discard unsaved connection changes?', onOk: onClose });
              else onClose();
            }
      }
      maskClosable={!busy}
    >
      {error && <Alert type="error" message={error} />}
      {notice && <Alert type="success" message={notice} />}
      {!draft || !saved ? (
        <Spin />
      ) : (
        <Form layout="vertical" disabled={busy}>
          {saved.migrationRequired && (
            <Alert
              type="warning"
              message="Earlier routing rules need migration"
              description="Saving replaces the old profile rules with the default and fallback models below. Existing profile-based conversations will need an explicit model selection before continuing. Review the old rules with your administrator before saving."
            />
          )}
          <Typography.Title level={5}>Connections</Typography.Title>
          <Flex justify="space-between" align="center" wrap gap={8} style={{ marginBottom: 12 }}>
            <Typography.Text type="secondary">
              Manage provider accounts and their models.
            </Typography.Text>
            <Button type="primary" disabled={busy} onClick={() => openEditor()}>
              Add connection
            </Button>
          </Flex>
          <List
            bordered
            locale={{ emptyText: 'No connections yet. Add your first connection.' }}
            dataSource={saved.settings.providers}
            renderItem={(provider) => (
              <List.Item>
                <Flex
                  wrap
                  gap={12}
                  align="center"
                  justify="space-between"
                  style={{ width: '100%' }}
                >
                  <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                    <List.Item.Meta
                      title={provider.name}
                      description={
                        <>
                          <span style={{ overflowWrap: 'anywhere' }}>{provider.endpoint}</span>
                          <br />
                          <span>
                            {provider.enabled ? 'Enabled' : 'Disabled'} ·{' '}
                            {saved.credentials.some(
                              (row) => row.providerId === provider.id && row.configured,
                            )
                              ? 'Key saved'
                              : 'Key missing'}{' '}
                            ·{' '}
                            {
                              saved.settings.models.filter(
                                (row) => row.connectionId === provider.id,
                              ).length
                            }{' '}
                            models
                          </span>
                        </>
                      }
                    />
                  </div>
                  <Space>
                    <Button
                      key="edit"
                      disabled={busy}
                      aria-label={`Edit ${provider.name}`}
                      onClick={() => openEditor(provider.id)}
                    >
                      Edit
                    </Button>
                    <Button
                      key="delete"
                      danger
                      disabled={busy}
                      aria-label={`Delete ${provider.name}`}
                      onClick={() =>
                        modal.confirm({
                          title: `Delete ${provider.name}?`,
                          content:
                            'This removes the connection and its models from available choices. Any default or fallback using it will be cleared. Existing explicit selections become unavailable. Unsaved model settings will be discarded.',
                          onOk: async () => {
                            const next = structuredClone(saved.settings);
                            next.providers = next.providers.filter((row) => row.id !== provider.id);
                            next.models = next.models.filter(
                              (row) => row.connectionId !== provider.id,
                            );
                            if (next.routing.defaultModel?.providerId === provider.id)
                              next.routing.defaultModel = null;
                            next.routing.fallbackModels = next.routing.fallbackModels.filter(
                              (ref) => ref.providerId !== provider.id,
                            );
                            requestSave(next);
                          },
                        })
                      }
                    >
                      Delete
                    </Button>
                  </Space>
                </Flex>
              </List.Item>
            )}
          />
          {editingId && (
            <Modal
              open
              title={creating ? 'Add connection' : 'Edit connection'}
              width={620}
              onCancel={busy ? undefined : cancelEditor}
              maskClosable={!busy}
              confirmLoading={busy}
              okText="Save connection"
              okButtonProps={{ disabled: busy || !dirty }}
              onOk={() => requestSave()}
              destroyOnHidden
            >
              {error && <Alert type="error" message={error} />}
              {creating && (
                <Form.Item label="Provider">
                  <Select
                    aria-label="Provider"
                    value={providerKind}
                    options={Object.entries(presets).map(([value, preset]) => ({
                      value,
                      label: preset.name,
                    }))}
                    onChange={(kind: keyof typeof presets) => {
                      setProviderKind(kind);
                      setKeys({});
                      edit((value) => addPreset(value, editingId!, kind));
                    }}
                  />
                </Form.Item>
              )}
              {draft.providers
                .filter((provider) => provider.id === editingId)
                .map((provider) => (
                  <div key={provider.id}>
                    <Form.Item label="Connection name">
                      <Input
                        value={provider.name}
                        maxLength={100}
                        onChange={(event) =>
                          edit((value) => {
                            value.providers.find((row) => row.id === provider.id)!.name =
                              event.target.value;
                          })
                        }
                      />
                    </Form.Item>
                    <Form.Item
                      label="API key"
                      extra={
                        saved.credentials.some(
                          (row) => row.providerId === provider.id && row.configured,
                        )
                          ? 'A key is saved. Leave blank to keep it.'
                          : 'Paste the key from your provider console.'
                      }
                    >
                      <Input.Password
                        aria-label={`API key for ${provider.name}`}
                        value={keys[provider.id] ?? ''}
                        autoComplete="new-password"
                        maxLength={16384}
                        onChange={(event) => {
                          setKeys((value) => ({ ...value, [provider.id]: event.target.value }));
                          setDirty(true);
                        }}
                      />
                    </Form.Item>
                    <Form.Item label="Endpoint">
                      <Input
                        aria-label={`Endpoint for ${provider.name}`}
                        value={provider.endpoint}
                        maxLength={2048}
                        onChange={(event) =>
                          edit((value) => {
                            value.providers.find((row) => row.id === provider.id)!.endpoint =
                              event.target.value;
                          })
                        }
                      />
                    </Form.Item>
                    <Collapse
                      items={[
                        {
                          key: 'connection',
                          label: 'Connection details',
                          children: (
                            <>
                              <Form.Item label="Protocol">
                                <Select
                                  value={provider.adapter}
                                  options={[
                                    { value: 'openai', label: 'OpenAI compatible' },
                                    { value: 'anthropic', label: 'Anthropic compatible' },
                                  ]}
                                  onChange={(adapter) =>
                                    edit((value) => {
                                      value.providers.find(
                                        (row) => row.id === provider.id,
                                      )!.adapter = adapter;
                                    })
                                  }
                                />
                              </Form.Item>

                              <Form.Item label="Enabled">
                                <Switch
                                  checked={provider.enabled}
                                  onChange={(enabled) =>
                                    edit((value) => {
                                      value.providers.find(
                                        (row) => row.id === provider.id,
                                      )!.enabled = enabled;
                                    })
                                  }
                                />
                              </Form.Item>
                            </>
                          ),
                        },
                      ]}
                    />
                    <Typography.Title level={5}>Models</Typography.Title>
                    {draft.models
                      .filter((model) => model.connectionId === provider.id)
                      .map((model) => (
                        <div key={model.id}>
                          <Form.Item label="Model ID">
                            <Input
                              aria-label={`Model for ${provider.name}`}
                              value={model.modelId}
                              maxLength={256}
                              onChange={(event) =>
                                edit((value) => {
                                  const selected = value.models.find((row) => row.id === model.id)!;
                                  const previous = selected.modelId;
                                  selected.modelId = event.target.value;
                                  selected.name = event.target.value;
                                  if (
                                    value.routing.defaultModel?.providerId === provider.id &&
                                    value.routing.defaultModel.modelId === previous
                                  )
                                    value.routing.defaultModel.modelId = event.target.value;
                                  value.routing.fallbackModels = value.routing.fallbackModels.map(
                                    (ref) =>
                                      ref.providerId === provider.id && ref.modelId === previous
                                        ? { ...ref, modelId: event.target.value }
                                        : ref,
                                  );
                                })
                              }
                            />
                          </Form.Item>
                          <Collapse
                            items={[
                              {
                                key: 'model',
                                label: 'Model details',
                                children: (
                                  <>
                                    <Form.Item label="Context tokens">
                                      <InputNumber
                                        min={1024}
                                        max={10000000}
                                        value={model.contextTokens}
                                        onChange={(value) =>
                                          value &&
                                          edit((draft) => {
                                            draft.models.find(
                                              (row) => row.id === model.id,
                                            )!.contextTokens = value;
                                          })
                                        }
                                      />
                                    </Form.Item>
                                    <Form.Item label="Maximum output tokens">
                                      <InputNumber
                                        min={1}
                                        max={1000000}
                                        value={model.outputTokens}
                                        onChange={(value) =>
                                          value &&
                                          edit((draft) => {
                                            draft.models.find(
                                              (row) => row.id === model.id,
                                            )!.outputTokens = value;
                                          })
                                        }
                                      />
                                    </Form.Item>
                                    {(['tools', 'images', 'files', 'reasoning'] as const).map(
                                      (capability) => (
                                        <Form.Item key={capability} label={capability}>
                                          <Switch
                                            checked={model.capabilities[capability]}
                                            onChange={(enabled) =>
                                              edit((draft) => {
                                                draft.models.find(
                                                  (row) => row.id === model.id,
                                                )!.capabilities[capability] = enabled;
                                              })
                                            }
                                          />
                                        </Form.Item>
                                      ),
                                    )}
                                    <Button
                                      disabled={
                                        dirty ||
                                        busy ||
                                        !saved.credentials.some(
                                          (row) => row.providerId === provider.id && row.configured,
                                        )
                                      }
                                      onClick={() =>
                                        modal.confirm({
                                          title: 'Test this saved model?',
                                          content:
                                            'Sends a short synthetic prompt to this provider and may consume subscription quota or incur charges. It does not send conversation content.',
                                          onOk: async () => {
                                            setBusy(true);
                                            setError('');
                                            try {
                                              const result = await client.testLlmConnection(
                                                provider.id,
                                                model.id,
                                                saved.version,
                                              );
                                              setNotice(`Model test: ${result.status}`);
                                            } catch (cause) {
                                              setError(explain(cause));
                                            } finally {
                                              setBusy(false);
                                            }
                                          },
                                        })
                                      }
                                    >
                                      Test saved model
                                    </Button>
                                    <Button
                                      danger
                                      onClick={() =>
                                        edit((value) => {
                                          value.models = value.models.filter(
                                            (row) => row.id !== model.id,
                                          );
                                          if (
                                            value.routing.defaultModel?.providerId ===
                                              provider.id &&
                                            value.routing.defaultModel.modelId === model.modelId
                                          )
                                            value.routing.defaultModel = null;
                                          value.routing.fallbackModels =
                                            value.routing.fallbackModels.filter(
                                              (ref) =>
                                                ref.providerId !== provider.id ||
                                                ref.modelId !== model.modelId,
                                            );
                                        })
                                      }
                                    >
                                      Remove model
                                    </Button>
                                  </>
                                ),
                              },
                            ]}
                          />
                        </div>
                      ))}
                    <Button
                      onClick={() =>
                        edit((value) => {
                          value.models.push({
                            id: newId(),
                            connectionId: provider.id,
                            name: 'New model',
                            modelId: '',
                            pricingKey: 'unpriced',
                            enabled: true,
                            contextTokens: 32768,
                            outputTokens: 8192,
                            capabilities: {
                              tools: false,
                              images: false,
                              files: false,
                              reasoning: false,
                            },
                            settings: {},
                          });
                        })
                      }
                    >
                      Add model
                    </Button>
                  </div>
                ))}
            </Modal>
          )}
          <Typography.Title level={5} style={{ marginTop: 24 }}>
            Model settings
          </Typography.Title>
          <Typography.Title level={5}>Default model</Typography.Title>
          <Select
            aria-label="Default model"
            allowClear
            placeholder="Choose a model when ready"
            style={{ width: '100%' }}
            options={options}
            value={draft.routing.defaultModel ? refKey(draft.routing.defaultModel) : undefined}
            onChange={(key) =>
              edit((value) => {
                const model = models.find(
                  (row) => refKey({ providerId: row.connectionId, modelId: row.modelId }) === key,
                );
                value.routing.defaultModel = model
                  ? { providerId: model.connectionId, modelId: model.modelId }
                  : null;
              })
            }
          />
          <Collapse
            style={{ marginTop: 16 }}
            items={[
              {
                key: 'fallback',
                label: 'Fallback models (optional)',
                children: (
                  <>
                    <Form.Item label="Use automatic fallback">
                      <Switch
                        checked={draft.routing.automaticFallback}
                        onChange={(enabled) =>
                          edit((value) => {
                            value.routing.automaticFallback = enabled;
                          })
                        }
                      />
                    </Form.Item>
                    <Select
                      aria-label="Fallback models"
                      mode="multiple"
                      maxCount={3}
                      style={{ width: '100%' }}
                      options={options.filter(
                        (option) =>
                          option.value !==
                          (draft.routing.defaultModel && refKey(draft.routing.defaultModel)),
                      )}
                      value={draft.routing.fallbackModels.map(refKey)}
                      onChange={(selected: string[]) =>
                        edit((value) => {
                          value.routing.fallbackModels = selected
                            .map((key) =>
                              models.find(
                                (row) =>
                                  refKey({ providerId: row.connectionId, modelId: row.modelId }) ===
                                  key,
                              )!,
                            )
                            .map((row) => ({ providerId: row.connectionId, modelId: row.modelId }));
                        })
                      }
                    />
                    <Typography.Paragraph type="secondary">
                      Models are tried in selection order. Enabling this approves sending requests
                      to these providers when a compatible model fails before output.
                    </Typography.Paragraph>
                  </>
                ),
              },
              {
                key: 'activity',
                label: 'Configuration history',
                children: (
                  <Space direction="vertical">
                    <Button
                      disabled={busy}
                      onClick={() => {
                        void client
                          .getLlmActivity()
                          .then(setActivity)
                          .catch((cause) => setError(explain(cause)));
                      }}
                    >
                      Load history
                    </Button>
                    {activity.map((row) => (
                      <Typography.Text key={row.id}>
                        {row.at} · {row.action} · {row.reason ?? 'Configuration change'}
                      </Typography.Text>
                    ))}
                  </Space>
                ),
              },
              {
                key: 'users',
                label: 'Users and roles',
                children: <TenantUserRoles client={client} />,
              },
            ]}
          />
          <Typography.Paragraph type="secondary">
            Keys are encrypted and cannot be read back. Save does not send a test prompt. Model
            changes apply at the next request. Connecting alone does not change the current default.
          </Typography.Paragraph>
          <Space>
            <Button type="primary" loading={busy} disabled={!dirty} onClick={() => requestSave()}>
              Save model settings
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                modal.confirm({
                  title: 'Reload and discard unsaved changes?',
                  onOk: async () => {
                    try {
                      const value = await client.getLlmProviders();
                      setSaved(value);
                      setDraft(value.settings);
                      setKeys({});
                      setDirty(false);
                      operation.current = undefined;
                      setError('');
                    } catch (cause) {
                      setError(explain(cause));
                    }
                  },
                })
              }
            >
              Reload
            </Button>
          </Space>
        </Form>
      )}
    </Drawer>
  );
}

export function LlmSessionSettings({
  client,
  sessionId,
  readOnly,
  compact = false,
  draftSettings,
  onDraftChange,
  onApplied,
}: {
  client: AcpClient;
  sessionId?: string;
  readOnly: boolean;
  compact?: boolean;
  draftSettings?: LlmSessionSettings;
  onDraftChange?: (settings: LlmSessionSettings) => void;
  onApplied?: () => void;
}): ReactElement | null {
  const [catalog, setCatalog] = useState<LlmModelsResponse>();
  const [current, setCurrent] = useState<LlmSessionSettingsResponse>();
  const [settings, setSettings] = useState<LlmSessionSettings>({ followDefault: true });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      client.getLlmModels(controller.signal),
      sessionId
        ? client.getLlmSessionSettings(sessionId, controller.signal)
        : Promise.resolve({ expectedLastSeq: 0, settings: draftSettings ?? null }),
    ])
      .then(([models, saved]) => {
        if (!controller.signal.aborted) {
          setCatalog(models);
          setCurrent(saved);
          setSettings(saved.settings ?? { followDefault: true });
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(explain(cause));
      });
    return () => controller.abort();
  }, [client, sessionId, draftSettings]);
  const selected = catalog?.models.find(
    (row) =>
      row.connectionId === (settings.model ?? catalog.defaultModel)?.providerId &&
      row.modelId === (settings.model ?? catalog.defaultModel)?.modelId,
  );
  if (catalog && !catalog.available && compact) return null;
  if (catalog && !catalog.available)
    return <Alert type="info" message="No managed default model is configured." />;
  const form = (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Typography.Text strong>Model settings</Typography.Text>
      {error && <Alert type="error" message={error} />}
      {settings.profileId && (
        <Alert
          type="warning"
          message="Choose a model to replace the earlier routing selection before continuing."
        />
      )}
      <Select
        aria-label="AI model"
        showSearch
        optionFilterProp="label"
        style={{ width: '100%' }}
        disabled={readOnly || busy}
        value={settings.profileId ? undefined : settings.model ? refKey(settings.model) : 'default'}
        placeholder="Choose a model"
        options={[
          {
            value: 'default',
            label: `Default · ${catalog?.defaultModel?.modelId ?? 'not configured'}`,
          },
          ...[...new Set(catalog?.models.map((row) => row.connectionId) ?? [])].map(
            (providerId) => ({
              label: catalog!.models.find((row) => row.connectionId === providerId)!.providerName,
              options: catalog!.models
                .filter((row) => row.connectionId === providerId)
                .map((row) => ({
                  value: refKey({ providerId, modelId: row.modelId }),
                  label: `${row.providerName} / ${row.modelId}`,
                })),
            }),
          ),
          ...(settings.model && !selected
            ? [
                {
                  value: refKey(settings.model),
                  label: `${settings.model.modelId} · unavailable`,
                  disabled: true,
                },
              ]
            : []),
        ]}
        onChange={(value) => {
          const model = catalog?.models.find(
            (row) => refKey({ providerId: row.connectionId, modelId: row.modelId }) === value,
          );
          setSettings(
            model
              ? { model: { providerId: model.connectionId, modelId: model.modelId } }
              : { followDefault: true },
          );
        }}
      />
      {catalog?.canTune && (
        <>
          {selected?.capabilities.reasoning && selected.adapter === 'openai' && (
            <Form.Item label="Reasoning effort">
              <Select
                aria-label="Session reasoning effort"
                allowClear
                placeholder="Model default"
                disabled={readOnly || busy}
                value={settings.reasoningEffort}
                options={['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((value) => ({
                  value,
                  label: value,
                }))}
                onChange={(value) => {
                  const next = { ...settings };
                  if (value) next.reasoningEffort = value;
                  else delete next.reasoningEffort;
                  setSettings(next);
                }}
              />
            </Form.Item>
          )}
          {selected?.capabilities.reasoning && selected.adapter === 'anthropic' && (
            <Form.Item label="Reasoning budget tokens">
              <InputNumber
                aria-label="Session reasoning budget tokens"
                min={1024}
                max={(selected.outputTokens ?? 8192) - 1}
                value={settings.reasoningBudgetTokens}
                disabled={readOnly || busy}
                onChange={(value) => {
                  const next = { ...settings };
                  if (value) next.reasoningBudgetTokens = value;
                  else delete next.reasoningBudgetTokens;
                  setSettings(next);
                }}
              />
            </Form.Item>
          )}
        </>
      )}
      {catalog?.canTune && (
        <Collapse
          items={[
            {
              key: 'advanced',
              label: 'Advanced settings',
              children: (
                <>
                  <Form.Item label="Pin model (disable fallback)">
                    <Switch
                      checked={settings.pinned ?? false}
                      disabled={readOnly || busy}
                      onChange={(pinned) => setSettings({ ...settings, pinned })}
                    />
                  </Form.Item>
                  <Form.Item label="Maximum output tokens">
                    <InputNumber
                      aria-label="Maximum session output tokens"
                      disabled={readOnly || busy}
                      min={1}
                      max={selected?.outputTokens}
                      value={settings.maxOutputTokens}
                      onChange={(value) => {
                        const next = { ...settings };
                        if (value) next.maxOutputTokens = value;
                        else delete next.maxOutputTokens;
                        setSettings(next);
                      }}
                    />
                  </Form.Item>
                </>
              ),
            },
          ]}
        />
      )}
      {!readOnly && (
        <Space>
          <Button
            loading={busy}
            disabled={!current || !!settings.profileId || busy || !catalog?.available}
            onClick={() => {
              if (!current) return;
              if (!sessionId) {
                onDraftChange?.(settings);
                setOpen(false);
                return;
              }
              setBusy(true);
              setError('');
              void client
                .setLlmSessionSettings(sessionId, current.expectedLastSeq, settings)
                .then(() => client.getLlmSessionSettings(sessionId))
                .then((saved) => {
                  onApplied?.();
                  setCurrent(saved);
                  setSettings(saved.settings ?? { followDefault: true });
                  setOpen(false);
                })
                .catch((cause) => setError(explain(cause)))
                .finally(() => setBusy(false));
            }}
          >
            {compact ? 'Apply' : 'Save model'}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              setSettings(settings.model ? { model: settings.model } : { followDefault: true })
            }
          >
            Reset advanced settings
          </Button>
        </Space>
      )}
      <Typography.Text type="secondary">
        Default follows the administrator's latest default. An explicit model stays selected.
        Changes apply at the next request.
      </Typography.Text>
    </Space>
  );
  if (!compact) return form;
  const savedSettings = current?.settings ?? { followDefault: true };
  const modelLabel = savedSettings.profileId
    ? 'Choose model'
    : (savedSettings.model?.modelId ?? `Default · ${catalog?.defaultModel?.modelId ?? 'model'}`);
  return (
    <Popover
      trigger="click"
      placement="topRight"
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setSettings(current?.settings ?? { followDefault: true });
        setOpen(next);
      }}
      title={null}
      content={<div className="composer-model-popover">{form}</div>}
    >
      <Button
        type="text"
        className="composer-model-trigger"
        aria-label="Model and reasoning settings"
        aria-expanded={open}
        disabled={busy}
      >
        <span className="composer-model-label">{modelLabel}</span>
        {savedSettings.reasoningEffort && <span>· {savedSettings.reasoningEffort}</span>}
        <span aria-hidden="true">⌄</span>
      </Button>
    </Popover>
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
