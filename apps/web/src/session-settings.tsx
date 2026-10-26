import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, Descriptions, Flex, Form, Modal, Select, Spin, Typography } from 'antd';
import type { AcpClient, TeamView } from '@trinity-harness/client-acp';
import type { SessionSettings } from '@trinity-harness/shared';

const permissionOptions = [
  { value: 'read-only', label: 'Read only' },
  { value: 'workspace-write', label: 'Workspace write · ask' },
];

export function SessionSettingsModal({
  client,
  sessionId,
  teams,
  onClose,
}: {
  client: AcpClient;
  sessionId: string;
  teams: TeamView[];
  onClose: () => void;
}): ReactElement {
  const [settings, setSettings] = useState<SessionSettings | null>(null);
  const [policy, setPolicy] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const live = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    live.current = true;
    setLoading(true);
    setSettings(null);
    setLoadError(false);
    setSaveError(false);
    setSaved(false);
    void client.getSessionSettings(sessionId, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setSettings(result);
        setPolicy(result.policy);
        setLoading(false);
      },
      () => {
        if (controller.signal.aborted) return;
        setLoadError(true);
        setLoading(false);
      },
    );
    return () => {
      live.current = false;
      controller.abort();
    };
  }, [client, sessionId, loadVersion]);

  const canSave =
    settings?.canChangePolicy &&
    policy !== settings.policy &&
    permissionOptions.some((option) => option.value === policy) &&
    !loading &&
    !saving &&
    !saveError;

  async function save(): Promise<void> {
    if (!canSave) return;
    setSaving(true);
    setSaved(false);
    try {
      await client.setSessionPolicy(sessionId, policy);
      if (!live.current) return;
      setSettings((current) => (current ? { ...current, policy } : current));
      setSaved(true);
    } catch {
      if (live.current) setSaveError(true);
    } finally {
      if (live.current) setSaving(false);
    }
  }

  const currentIsPreset = permissionOptions.some((option) => option.value === settings?.policy);
  const team = teams.find((entry) => entry.teamId === settings?.scopeId);

  return (
    <Modal
      open
      centered
      title="Session settings"
      styles={{ body: { maxHeight: 'calc(100dvh - 180px)', overflowY: 'auto' } }}
      onCancel={saving ? undefined : onClose}
      closable={!saving}
      maskClosable={!saving}
      keyboard={!saving}
      footer={
        <Flex justify="flex-end" gap={8}>
          <Button disabled={saving} onClick={onClose}>
            Close
          </Button>
          {settings?.canChangePolicy && (
            <Button type="primary" loading={saving} disabled={!canSave} onClick={() => void save()}>
              Save permissions
            </Button>
          )}
        </Flex>
      }
    >
      <div className="session-settings" aria-busy={loading || saving}>
        {loading && (
          <Spin tip="Loading session settings…">
            <div style={{ minHeight: 100 }} />
          </Spin>
        )}
        {loadError && (
          <Alert
            type="error"
            showIcon
            message="Could not load session settings."
            action={<Button onClick={() => setLoadVersion((value) => value + 1)}>Retry</Button>}
          />
        )}
        {settings && (
          <>
            <Descriptions
              column={1}
              size="small"
              items={[
                {
                  key: 'title',
                  label: 'Conversation',
                  children: settings.title || 'Untitled conversation',
                },
                {
                  key: 'kind',
                  label: 'Type',
                  children:
                    settings.sessionRole === 'main'
                      ? 'Main chat'
                      : settings.kind === 'work'
                        ? 'Work'
                        : settings.kind === 'chat'
                          ? 'Chat'
                          : 'Existing conversation',
                },
                {
                  key: 'workspace',
                  label: 'Workspace',
                  children:
                    settings.workspaceUri ||
                    (settings.kind === 'chat'
                      ? 'Assigned automatically before first use'
                      : 'Workspace unavailable'),
                },
                {
                  key: 'visibility',
                  label: 'Visibility',
                  children:
                    settings.scope === 'team'
                      ? `Shared with team · ${team?.name ?? settings.scopeId ?? 'Team workspace'}`
                      : 'Personal · you and tenant administrators',
                },
              ]}
            />
            <Typography.Paragraph type="secondary">
              Session type and workspace are fixed after creation. Use New or Create related Work to
              choose a different workspace.
            </Typography.Paragraph>
            <Form layout="vertical">
              <Form.Item label="Tool permissions" htmlFor="session-permissions">
                <Select
                  id="session-permissions"
                  aria-label="Tool permissions"
                  value={policy}
                  disabled={!settings.canChangePolicy || saving || saveError}
                  options={[
                    ...permissionOptions,
                    ...(!currentIsPreset
                      ? [
                          {
                            value: settings.policy,
                            label:
                              settings.policy === 'danger-full-access'
                                ? 'Full access (current policy)'
                                : 'Custom policy (current)',
                            disabled: true,
                          },
                        ]
                      : []),
                  ]}
                  onChange={(value) => {
                    setPolicy(value);
                    setSaved(false);
                  }}
                />
              </Form.Item>
              <Typography.Paragraph type="secondary">
                {policy === 'read-only'
                  ? 'Bash commands are blocked. File writes require approval.'
                  : policy === 'workspace-write'
                    ? 'Files can be changed inside the workspace. Commands follow the session approval policy.'
                    : 'This session uses an existing policy.'}
              </Typography.Paragraph>
              {!currentIsPreset && (
                <Typography.Paragraph type="secondary">
                  Choosing a preset replaces the existing rules and command grants.
                </Typography.Paragraph>
              )}
              {!settings.canChangePolicy && (
                <Typography.Paragraph>
                  You have read-only access to these settings.
                </Typography.Paragraph>
              )}
              <Typography.Paragraph type="secondary">
                Changes apply to requests submitted after saving. Running and already queued
                requests keep their existing permissions.
              </Typography.Paragraph>
            </Form>
            {saved && <Alert type="success" showIcon message="Permissions saved." />}
            {saveError && (
              <Alert
                type="error"
                showIcon
                message="Could not confirm the save. Reload settings to check the current permissions before trying again."
                action={
                  <Button onClick={() => setLoadVersion((value) => value + 1)}>
                    Reload settings
                  </Button>
                }
              />
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
