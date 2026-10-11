import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import type { ServerEvent } from '@trinity-harness/shared';
import {
  App as AntdApp,
  Button,
  Collapse,
  Dropdown,
  Flex,
  Form,
  Image,
  Input,
  Layout,
  List,
  Modal,
  Select,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { Bubble } from '@ant-design/x';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  AcpClient,
  type SessionSummary,
  type TeamView,
  type WorkspaceSelection,
} from '@trinity-harness/client-acp';

import { HistorySidebar, HistoryDivider } from './history-sidebar';
import { ChatComposer } from './chat-composer';
import './chat-layout.css';
import { ResponseActions } from './response-actions';
import { MessageTimestamp } from './message-timestamp';
import { AnswerCitationList } from './answer-citations';

import {
  settleAssistantItems,
  mergeAssistantChunk,
  mergeToolUpdate,
  mergeCommittedAssistantMessage,
  mergeCommittedUserMessage,
  newItemKey,
  type AttachmentView,
  type ChatItem,
} from './chat-items';

/**
 * M2 chat UI (docs/design.md §11.5): antd-x components consume the ACP-flavored
 * session/update events produced by the server — no private UI protocol. Auth:
 * bearer token from /api/auth/login, kept in sessionStorage; admin users get
 * an audit tab (docs/design.md §13). M6: session history sidebar, per-user /
 * per-team workspaces (docs/design.md §15), markdown rendering.
 */

const TOKEN_KEY = 'trinity.token';

type Role = 'admin' | 'developer' | 'viewer';
type MeUser = { id: string; email: string; role: Role };

type AuditRow = {
  id: string;
  at: string;
  userId: string;
  action: string;
  target?: string;
  result: string;
  sessionId?: string;
};

/** M3: an approval request waiting for the human (docs/design.md §12.2). */
type PendingApproval = {
  approvalId: string;
  toolName: string;
  title: string;
  argsPreview: string;
};

const client = new AcpClient({
  token: () => sessionStorage.getItem(TOKEN_KEY),
});

/** Workspace selector value encoding: 'personal' or `team:<id>`. */
function workspaceValue(ws: WorkspaceSelection): string {
  return ws.scope === 'team' ? `team:${ws.teamId}` : 'personal';
}

function workspaceLabel(s: SessionSummary, teams: TeamView[]): string {
  if (s.scope !== 'team') {
    const marker = `/${s.userId}/`;
    const index = s.workspaceUri.lastIndexOf(marker);
    return index < 0 ? 'personal' : `personal / ${s.workspaceUri.slice(index + marker.length)}`;
  }
  return teams.find((t) => t.teamId === s.scopeId)?.name ?? 'team';
}

export default function App() {
  const { message, modal } = AntdApp.useApp();
  const [user, setUser] = useState<MeUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(
    () => window.matchMedia('(max-width: 600px)').matches,
  );
  const [historyWidthRatio, setHistoryWidthRatio] = useState(0.22);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [teams, setTeams] = useState<TeamView[]>([]);
  /** Workspace for the NEXT session (existing sessions keep their own). */
  const [workspace, setWorkspace] = useState<WorkspaceSelection>({ scope: 'personal' });
  const [busy, setBusy] = useState(false);
  const [draftResetVersion, setDraftResetVersion] = useState(0);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [policy, setPolicy] = useState<string>('workspace-write');
  const [teamsOpen, setTeamsOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  /** M4: attachments staged for the next prompt (uploaded on selection). */
  const [staged, setStaged] = useState<(AttachmentView & { name: string })[]>([]);
  const sessionRef = useRef<string | null>(null);
  const streamRef = useRef<{ close(): void } | null>(null);

  useEffect(() => {
    if (!folderPickerOpen) return;
    let active = true;
    setFoldersLoading(true);
    void client
      .listPersonalFolders(browsePath)
      .then(
        (names) => {
          if (active) setFolders(names);
        },
        (error: unknown) => {
          if (active) {
            setFolders([]);
            message.error(error instanceof Error ? error.message : String(error));
          }
        },
      )
      .finally(() => {
        if (active) setFoldersLoading(false);
      });
    return () => {
      active = false;
    };
  }, [browsePath, folderPickerOpen, message]);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await client.listSessions());
    } catch {
      // Sidebar refresh is best-effort; the chat itself does not depend on it.
    }
  }, []);

  const refreshTeams = useCallback(async () => {
    try {
      setTeams(await client.listTeams());
    } catch {
      // Team workspaces are optional (endpoint exists when the store does).
    }
  }, []);

  const handleEvent = useCallback(
    (event: ServerEvent) => {
      if (event.type === 'error') {
        message.error(event.message);
        setBusy(false);
        setApproval(null);
        setItems((items) => settleAssistantItems(items, 'error'));
        return;
      }
      if (event.type === 'message/committed') {
        if (event.message.role === 'assistant') {
          // Live: fill the optimistic placeholder. Replay: append a new item
          // (see chat-items.ts — the placeholder only exists in the live flow).
          setItems((prev) =>
            mergeCommittedAssistantMessage(
              prev,
              event.message.content,
              newItemKey,
              event.message.at,
              event.message,
            ),
          );
        } else {
          // Replayed/relayed user message — skip if we already rendered it
          // locally when the prompt was sent (see chat-items.ts for why the
          // match targets the most recent USER item, not the last item).
          setItems((prev) =>
            mergeCommittedUserMessage(
              prev,
              {
                content: event.message.content,
                id: event.message.id,
                at: event.message.at,
                attachments: event.message.attachments,
              },
              newItemKey,
            ),
          );
        }
        return;
      }
      if (event.type === 'session/update' && event.update.kind === 'agent_message_chunk') {
        const { text } = event.update;
        setItems((prev) =>
          mergeAssistantChunk(prev, text, newItemKey, new Date(Date.now()).toISOString()),
        );
        setBusy(true);
        return;
      }
      if (event.type === 'session/update' && event.update.kind === 'tool_call') {
        const update = event.update;
        setItems((items) =>
          mergeToolUpdate(items, update, newItemKey, new Date(Date.now()).toISOString()),
        );
        return;
      }
      if (event.type === 'session/update' && event.update.kind === 'permission_request') {
        // M3 approval flow (docs/design.md §12.2): surface the gate, wait
        // for the human; the Modal answers via respondApproval.
        if (event.update.status === 'pending') {
          setApproval({
            approvalId: event.update.approvalId,
            toolName: event.update.toolName,
            title: event.update.title,
            argsPreview: event.update.argsPreview,
          });
        } else {
          setApproval(null);
        }
        return;
      }
      if (event.type === 'session/turn_status') {
        if (event.status === 'completed' || event.status === 'aborted') {
          const status = event.status;
          setBusy(false);
          setApproval(null);
          setItems((items) => settleAssistantItems(items, status));
        }
      }
    },
    [message],
  );

  const openStream = useCallback(
    (id: string, fromSeq?: number) => {
      streamRef.current?.close();
      streamRef.current = client.openEventStream(
        id,
        {
          onEvent: handleEvent,
          onError: (err) => message.warning(`event stream error (reconnecting): ${String(err)}`),
        },
        fromSeq !== undefined ? { afterSeq: fromSeq } : undefined,
      );
    },
    [handleEvent, message],
  );

  const onApprove = useCallback(
    async (outcome: 'allowed' | 'rejected', commandPrefix?: string[]) => {
      if (!approval || !sessionRef.current) return;
      try {
        await client.respondApproval(
          sessionRef.current,
          approval.approvalId,
          outcome,
          commandPrefix,
        );
        setApproval(null);
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      }
    },
    [approval, message],
  );

  const onCancelTurn = useCallback(async () => {
    if (!sessionRef.current) return;
    try {
      const sessionId = sessionRef.current;
      const result = await client.cancelTurn(sessionId);
      if (sessionRef.current !== sessionId) return;
      setApproval(null);
      if (result.alreadyStopped) {
        setBusy(false);
        setItems((items) => settleAssistantItems(items, 'aborted'));
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }, [message]);

  useEffect(() => {
    return () => streamRef.current?.close();
  }, []);

  // On load: a stored token may still be valid — ask /api/me.
  useEffect(() => {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) {
      setAuthChecked(true);
      return;
    }
    fetch('/api/me', { headers: { authorization: `Bearer ${token}` } })
      .then(async (res) => {
        if (res.ok) {
          const body = (await res.json()) as { user: MeUser };
          setUser(body.user);
          await Promise.all([refreshSessions(), refreshTeams()]);
        } else {
          sessionStorage.removeItem(TOKEN_KEY);
        }
      })
      .catch(() => sessionStorage.removeItem(TOKEN_KEY))
      .finally(() => setAuthChecked(true));
  }, [refreshSessions, refreshTeams]);

  const onLogin = useCallback(
    async (values: { email: string; password: string }) => {
      try {
        const { token, user: loggedIn } = (await client.login(values.email, values.password)) as {
          token: string;
          user: MeUser;
        };
        sessionStorage.setItem(TOKEN_KEY, token);
        setUser(loggedIn);
        await Promise.all([refreshSessions(), refreshTeams()]);
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      }
    },
    [message, refreshSessions, refreshTeams],
  );

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    streamRef.current?.close();
    setUser(null);
    setItems([]);
    setSessions([]);
    setTeams([]);
    setSessionId(null);
    sessionRef.current = null;
  }, []);

  /** Opens the event stream and marks the session active. */
  const activateSession = useCallback(
    (id: string, fromSeq?: number) => {
      sessionRef.current = id;
      setSessionId(id);
      openStream(id, fromSeq);
    },
    [openStream],
  );

  const ensureSession = useCallback(
    async (title?: string): Promise<string> => {
      if (sessionRef.current) return sessionRef.current;
      const id = await client.createSession(title, policy, workspace);
      activateSession(id);
      await refreshSessions();
      return id;
    },
    [activateSession, policy, refreshSessions, workspace],
  );

  /** Sidebar click: switch to a past session and replay its log. */
  const switchSession = useCallback(
    (id: string) => {
      if (id === sessionRef.current) return;
      streamRef.current?.close();
      setItems([]);
      setApproval(null);
      setStaged([]);
      setBusy(false);
      setDraftResetVersion((version) => version + 1);
      activateSession(id, 0);
    },
    [activateSession],
  );

  /** New chat: drop the session binding; the next prompt creates a fresh one. */
  const newChat = useCallback(() => {
    streamRef.current?.close();
    setItems([]);
    setApproval(null);
    setStaged([]);
    setBusy(false);
    setDraftResetVersion((version) => version + 1);
    sessionRef.current = null;
    setSessionId(null);
  }, []);

  const exportSession = useCallback(
    async (id: string) => {
      try {
        const blob = await client.exportSession(id);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `session-${id}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        requestAnimationFrame(() => URL.revokeObjectURL(url));
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      }
    },
    [message],
  );

  const confirmDeleteSession = useCallback(
    (id: string) => {
      modal.confirm({
        title: 'Delete this session from history?',
        content: 'The session will close and can no longer be opened.',
        okText: 'Delete',
        okButtonProps: { danger: true },
        async onOk() {
          try {
            await client.deleteSession(id);
            if (sessionRef.current === id) newChat();
            await refreshSessions();
          } catch (err) {
            message.error(err instanceof Error ? err.message : String(err));
            throw err;
          }
        },
      });
    },
    [message, modal, newChat, refreshSessions],
  );

  /** M4: upload a file right away and stage the blob reference. */
  const onStageFile = useCallback(
    async (file: File) => {
      try {
        const id = await ensureSession();
        const { uri, mimeType } = await client.uploadAttachment(id, file, file.type, file.name);
        const kind = file.type === 'application/pdf' ? ('file' as const) : ('image' as const);
        setStaged((prev) => [...prev, { kind, uri, mimeType, name: file.name }]);
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      }
    },
    [ensureSession, message],
  );

  const onSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if ((!trimmed && staged.length === 0) || busy) return;
      if (trimmed.length === 0 && staged.length === 0) return;
      const sent = staged.map(({ kind, uri, mimeType }) => ({ kind, uri, mimeType }));
      const mimeList = staged.map(({ uri, mimeType }) => ({
        uri,
        mimeType: mimeType ?? 'application/octet-stream',
      }));
      setStaged([]);
      setBusy(true);
      setItems((prev) => [
        ...prev,
        {
          key: newItemKey(),
          role: 'user',
          at: new Date(Date.now()).toISOString(),
          content: trimmed || '[attachments]',
          streaming: false,
          tools: [],
          attachments: sent,
        },
        {
          key: newItemKey(),
          role: 'assistant',
          at: new Date(Date.now()).toISOString(),
          content: '',
          streaming: true,
          tools: [],
          attachments: [],
        },
      ]);
      try {
        // First prompt of a session doubles as its sidebar title.
        const id = await ensureSession(trimmed.slice(0, 60) || undefined);
        await client.sendPrompt(id, trimmed || '[see attachments]', mimeList);
        await refreshSessions();
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
        setBusy(false);
        setItems((items) => settleAssistantItems(items, 'error'));
      }
    },
    [busy, ensureSession, message, refreshSessions, staged],
  );

  const activeTitle = sessions.find((s) => s.sessionId === sessionId)?.title;

  const chatPanel = (
    <div className="chat-panel">
      {items.length === 0 && (
        <div className="empty-chat-state">
          <img src="/branding/trinity-logo.png" alt="Trinity logo" />
          <span className="eyebrow">TRINITY HARNESS</span>
          <Typography.Title level={2}>What would you like to work on?</Typography.Title>
          <Typography.Text className="empty-chat-description">
            Build something new, work through a bug, or explore your code. Start with what you have
            in mind.
          </Typography.Text>
          <div className="empty-chat-capabilities" aria-label="Things you can work on">
            <span>Build & refine</span>
            <span>Debug & understand</span>
            <span>Review & improve</span>
          </div>
        </div>
      )}
      {items.length > 0 && <ChatTranscript items={items} />}
      <div className="composer-dock">
        <div className="composer-card">
          {staged.length > 0 && (
            <div className="composer-attachments" role="group" aria-label="Attached files">
              {staged.map((att) =>
                att.kind === 'image' ? (
                  <div className="staged-image-card" key={att.uri}>
                    <AttachmentItem attachment={att} size={48} />
                    <Typography.Text ellipsis title={att.name} className="staged-image-name">
                      {att.name}
                    </Typography.Text>
                    <Button
                      className="staged-image-remove"
                      type="text"
                      shape="circle"
                      size="small"
                      aria-label={`Remove ${att.name}`}
                      onClick={() => setStaged((prev) => prev.filter((s) => s.uri !== att.uri))}
                    >
                      ×
                    </Button>
                  </div>
                ) : (
                  <Tag
                    className="staged-file-tag"
                    key={att.uri}
                    closable
                    onClose={() => setStaged((prev) => prev.filter((s) => s.uri !== att.uri))}
                  >
                    📄 {att.name}
                  </Tag>
                ),
              )}
            </div>
          )}
          <Flex gap={8} align="center" className="chat-composer">
            <Upload
              beforeUpload={(file) => {
                void onStageFile(file as unknown as File);
                return false; // keep antd from posting the file itself
              }}
              showUploadList={false}
              accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
              disabled={busy}
            >
              <Button icon={<span>＋</span>} disabled={busy} aria-label="Attach image or PDF" />
            </Upload>
            <div className="chat-composer-input">
              <ChatComposer
                busy={busy}
                resetVersion={draftResetVersion}
                onSubmit={onSubmit}
                onCancel={onCancelTurn}
              />
            </div>
          </Flex>
        </div>
        <p className="composer-hint">Enter to send · Shift + Enter for a new line</p>
      </div>
    </div>
  );

  const auditPanel = user?.role === 'admin' ? <AuditTable /> : null;

  if (!authChecked) {
    return null;
  }

  if (!user) {
    return (
      <div className="login-screen">
        <Form className="login-card" layout="vertical" onFinish={onLogin}>
          <img className="login-logo" src="/branding/trinity-logo.png" alt="Trinity logo" />
          <span className="eyebrow">AI WORKSPACE</span>
          <Typography.Title level={2}>Welcome to Trinity</Typography.Title>
          <Typography.Paragraph type="secondary">Sign in to your workspace</Typography.Paragraph>
          <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            Sign in
          </Button>
        </Form>
      </div>
    );
  }

  const workspaceOptions = [
    { value: 'personal', label: 'Personal workspace' },
    ...teams.map((t) => ({ value: `team:${t.teamId}`, label: t.name })),
  ];

  return (
    <Layout className="trinity-shell">
      <HistorySidebar collapsed={historyCollapsed} widthRatio={historyWidthRatio}>
        <div className="sider-brand">
          <img src="/branding/trinity-logo.png" alt="Trinity logo" />
          <div>
            <strong>Trinity</strong>
            <span>AI Workspace</span>
          </div>
        </div>
        <Button className="new-chat-button" type="primary" onClick={newChat}>
          ＋ New conversation
        </Button>
        <span className="sider-section-label">Recent conversations</span>
        <div className="history-scroll">
          <RecentConversations
            sessions={sessions}
            sessionId={sessionId}
            user={user}
            teams={teams}
            onSelect={switchSession}
            onExport={exportSession}
            onDelete={confirmDeleteSession}
          />
        </div>
      </HistorySidebar>
      <HistoryDivider
        collapsed={historyCollapsed}
        widthRatio={historyWidthRatio}
        onToggle={() => setHistoryCollapsed((collapsed) => !collapsed)}
        onResize={(ratio) => {
          setHistoryWidthRatio(ratio);
          setHistoryCollapsed(false);
        }}
      />
      <Layout.Content className="trinity-content">
        <Flex vertical className="workspace-frame">
          <Flex justify="space-between" align="center" gap={8} className="workspace-header">
            {historyCollapsed && (
              <Button
                size="small"
                onClick={newChat}
                aria-label="New conversation"
                title="New conversation"
              >
                ＋
              </Button>
            )}
            <div className="workspace-heading">
              <Typography.Title level={4} title={activeTitle || sessionId || 'New conversation'}>
                {sessionId ? 'Conversation' : 'New conversation'}{' '}
                {sessionId ? (
                  <Typography.Text type="secondary">
                    · {activeTitle || sessionId.slice(0, 8)}
                  </Typography.Text>
                ) : null}
              </Typography.Title>
            </div>
            <Flex align="center" gap={8} wrap className="workspace-controls">
              <Select
                size="small"
                value={workspaceValue(workspace)}
                onChange={(v) =>
                  setWorkspace(
                    v === 'personal'
                      ? { scope: 'personal' }
                      : { scope: 'team', teamId: v.slice(5) },
                  )
                }
                disabled={busy || !!sessionRef.current}
                options={workspaceOptions}
                style={{ width: 180 }}
                title="Workspace for the next session"
                aria-label="Workspace for the next session"
              />
              {workspace.scope === 'personal' && (
                <Button
                  size="small"
                  disabled={busy || !!sessionRef.current}
                  onClick={() => {
                    setBrowsePath(workspace.path ?? '');
                    setFolderPickerOpen(true);
                  }}
                >
                  {workspace.path || 'Choose folder'}
                </Button>
              )}
              <Button size="small" onClick={() => setTeamsOpen(true)}>
                Teams
              </Button>
              <Select
                size="small"
                aria-label="Tool permissions for the next session"
                value={policy}
                onChange={setPolicy}
                disabled={busy || !!sessionRef.current}
                options={[
                  { value: 'workspace-write', label: 'Workspace write · ask' },
                  { value: 'read-only', label: 'Read only' },
                  { value: 'danger-full-access', label: 'Full access · no approvals' },
                ]}
                style={{ width: 210 }}
              />
              <Typography.Text type="secondary" className="user-label">
                {user.email} ({user.role})
              </Typography.Text>
              <Button size="small" onClick={logout}>
                Sign out
              </Button>
            </Flex>
          </Flex>
          <ApprovalModal
            approval={approval}
            onApprove={() => void onApprove('allowed')}
            onApprovePattern={(prefix) => void onApprove('allowed', prefix)}
            onReject={() => void onApprove('rejected')}
            onStop={() => void onCancelTurn()}
          />
          <Modal
            open={folderPickerOpen}
            title="Choose personal workspace folder"
            onCancel={() => setFolderPickerOpen(false)}
            onOk={() => {
              setWorkspace(
                browsePath ? { scope: 'personal', path: browsePath } : { scope: 'personal' },
              );
              setFolderPickerOpen(false);
            }}
            okText="Use this folder"
            okButtonProps={{ disabled: foldersLoading }}
          >
            <Typography.Paragraph>Your root / {browsePath || '(root)'}</Typography.Paragraph>
            <Button
              size="small"
              disabled={!browsePath || foldersLoading}
              onClick={() => setBrowsePath(browsePath.split('/').slice(0, -1).join('/'))}
            >
              ↑ Parent folder
            </Button>
            <List
              loading={foldersLoading}
              dataSource={folders}
              locale={{ emptyText: 'No subfolders' }}
              renderItem={(folder) => (
                <List.Item>
                  <Button
                    type="link"
                    onClick={() => setBrowsePath(browsePath ? `${browsePath}/${folder}` : folder)}
                  >
                    📁 {folder}
                  </Button>
                </List.Item>
              )}
            />
          </Modal>
          <TeamsModal
            open={teamsOpen}
            onClose={() => setTeamsOpen(false)}
            teams={teams}
            onChanged={() => {
              void refreshTeams();
              void refreshSessions();
            }}
          />
          <Flex justify="flex-end" className="turn-controls">
            {busy ? (
              <Button size="small" danger onClick={() => void onCancelTurn()}>
                Cancel turn
              </Button>
            ) : null}
          </Flex>
          {auditPanel ? (
            <Tabs
              className="workspace-tabs"
              items={[
                { key: 'chat', label: 'Chat', children: chatPanel },
                { key: 'audit', label: 'Audit', children: auditPanel },
              ]}
            />
          ) : (
            chatPanel
          )}
        </Flex>
      </Layout.Content>
    </Layout>
  );
}

const RecentConversations = memo(function RecentConversations({
  sessions,
  sessionId,
  user,
  teams,
  onSelect,
  onExport,
  onDelete,
}: {
  sessions: SessionSummary[];
  sessionId: string | null;
  user: MeUser;
  teams: TeamView[];
  onSelect: (id: string) => void;
  onExport: (id: string) => Promise<void>;
  onDelete: (id: string) => void;
}): ReactElement {
  return (
    <List
      size="small"
      dataSource={sessions}
      locale={{ emptyText: 'No sessions yet' }}
      renderItem={(s) => (
        <List.Item
          onClick={() => onSelect(s.sessionId)}
          className={`history-item${s.sessionId === sessionId ? ' active' : ''}`}
          actions={[
            <Dropdown
              key="actions"
              menu={{
                items: [
                  { key: 'export', label: 'Export JSON' },
                  {
                    key: 'delete',
                    label: 'Delete',
                    danger: true,
                    disabled:
                      user.role === 'viewer' || (user.role !== 'admin' && s.userId !== user.id),
                  },
                ],
                onClick: ({ key, domEvent }) => {
                  domEvent.stopPropagation();
                  if (key === 'export') void onExport(s.sessionId);
                  if (key === 'delete') onDelete(s.sessionId);
                },
              }}
            >
              <Button
                size="small"
                type="text"
                aria-label={`Actions for ${s.title || 'untitled conversation'}`}
                onClick={(event) => event.stopPropagation()}
              >
                ⋯
              </Button>
            </Dropdown>,
          ]}
        >
          <List.Item.Meta
            title={
              <Button
                type="text"
                className="history-title"
                aria-current={s.sessionId === sessionId ? 'true' : undefined}
                title={s.title || 'Untitled conversation'}
              >
                {s.title || 'Untitled conversation'}
              </Button>
            }
            description={
              <Flex gap={8} align="center">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {new Date(s.createdAt).toLocaleString()}
                </Typography.Text>
                <Tag style={{ fontSize: 11, lineHeight: '14px' }}>{workspaceLabel(s, teams)}</Tag>
              </Flex>
            }
          />
        </List.Item>
      )}
    />
  );
});

const bubbleRoles = {
  user: { placement: 'end' as const },
  assistant: { placement: 'start' as const },
};

function renderChatMessage(item: ChatItem): ReactElement {
  return <ChatMessageContent item={item} />;
}

const ChatTranscript = memo(function ChatTranscript({
  items,
}: {
  items: ChatItem[];
}): ReactElement {
  const bubbleItems = useMemo(
    () =>
      items.map((item) => ({
        key: item.key,
        role: item.role,
        content: item,
        messageRender: renderChatMessage,
      })),
    [items],
  );
  return <Bubble.List className="chat-messages" items={bubbleItems} roles={bubbleRoles} />;
});

const ChatMessageContent = memo(function ChatMessageContent({
  item,
}: {
  item: ChatItem;
}): ReactElement {
  if (item.role === 'assistant') return <AssistantContent item={item} content={item.content} />;
  return (
    <div>
      <div className="user-message-heading">
        <span>You</span>
        <MessageTimestamp at={item.at} />
      </div>
      {item.content.length > 0 && (
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }}>
          {item.content}
        </Typography.Paragraph>
      )}
      <AttachmentList attachments={item.attachments} />
    </div>
  );
});

/** Markdown-rendered assistant bubble: streaming deltas + tool calls below. */
function AssistantContent({ item, content }: { item: ChatItem; content: string }): ReactElement {
  return (
    <article className="assistant-response" aria-label="Trinity response">
      <div className="response-heading">
        <span className="response-author">Trinity</span>
        {item.streaming && <span className="response-streaming">Responding…</span>}
        <MessageTimestamp at={item.at} />
      </div>
      {content.length > 0 && (
        <div className="md" style={{ marginBottom: 8 }}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
            }}
          >
            {content}
          </ReactMarkdown>
          {item.streaming ? '▋' : ''}
        </div>
      )}
      <AttachmentList attachments={item.attachments} />
      {(item.tools.length > 0 || !!item.activity?.length) && (
        <details className="turn-activity">
          <summary>
            Activity · {item.activity?.length ?? 0} updates · {item.tools.length} tools
          </summary>
          {!!item.activity?.length && (
            <ol className="turn-progress">
              {item.activity.map((entry, index) => (
                <li key={index}>
                  <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
                    {entry.content}
                  </Typography.Paragraph>
                </li>
              ))}
            </ol>
          )}
          <Collapse
            size="small"
            items={item.tools.map((tool) => ({
              key: tool.toolCallId,
              label: `${tool.status === 'in_progress' ? '⏳' : tool.status === 'failed' ? '❌' : '✅'} ${tool.title}`,
              children: (
                <Typography.Text code style={{ whiteSpace: 'pre-wrap' }}>
                  {tool.content ?? ''}
                </Typography.Text>
              ),
            }))}
          />
        </details>
      )}
      {item.stopped && <Typography.Text type="secondary">Task stopped.</Typography.Text>}
      {item.error && <Typography.Text type="secondary">The task could not finish.</Typography.Text>}
      {!item.streaming && (
        <AnswerCitationList citations={item.citationList} renderImage={renderEvidenceImage} />
      )}
      {!item.streaming && content.trim().length > 0 && <ResponseActions content={content} />}
    </article>
  );
}

/** M4: renders message attachments — images inline, files as links. */
function renderEvidenceImage(uri: string): ReactElement {
  return <AttachmentItem attachment={{ kind: 'image', uri, mimeType: 'image/png' }} size={480} />;
}

function AttachmentList({ attachments }: { attachments: AttachmentView[] }) {
  if (attachments.length === 0) return null;
  return (
    <Flex gap={8} wrap style={{ marginBottom: 8 }}>
      {attachments.map((att) => (
        <AttachmentItem key={att.uri} attachment={att} />
      ))}
    </Flex>
  );
}

function AttachmentItem({
  attachment,
  size = 80,
}: {
  attachment: AttachmentView;
  size?: number;
}): ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setFailed(false);
    setUrl(null);
    void client
      .fetchBlob(attachment.uri, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.uri]);

  if (!url) {
    return (
      <Typography.Text type={failed ? 'danger' : 'secondary'}>
        {failed ? 'Attachment unavailable' : 'Loading attachment…'}
      </Typography.Text>
    );
  }

  if (attachment.kind === 'image') {
    return (
      <Image
        src={url}
        alt={attachment.mimeType ?? 'Uploaded image'}
        width={size}
        height={size}
        style={{ objectFit: 'cover', borderRadius: 8 }}
        preview={{ src: url }}
      />
    );
  }

  return (
    <a href={url} target="_blank" rel="noreferrer">
      📄 {attachment.mimeType ?? 'document'}
    </a>
  );
}

/** M3: antd Modal bound to a pending approval request (docs/design.md §11.5). */
function ApprovalModal({
  approval,
  onApprove,
  onReject,
  onStop,
  onApprovePattern,
}: {
  approval: PendingApproval | null;
  onApprove: () => void;
  onReject: () => void;
  onStop: () => void;
  onApprovePattern: (prefix: string[]) => void;
}) {
  const [pattern, setPattern] = useState('');
  useEffect(() => {
    let command = '';
    try {
      command = (JSON.parse(approval?.argsPreview ?? '{}') as { command?: string }).command ?? '';
    } catch {
      command = '';
    }
    setPattern(command.trim().split(/\s+/)[0] ?? '');
  }, [approval?.approvalId, approval?.argsPreview]);
  const prefix = pattern.trim().split(/\s+/).filter(Boolean);
  const valid = prefix.length > 0 && prefix.every((word) => /^[a-zA-Z0-9_./:@=+-]+$/.test(word));
  return (
    <Modal
      open={approval !== null}
      title={`Approval required: ${approval?.toolName ?? ''}`}
      okText="Allow once"
      cancelText="Reject"
      onOk={onApprove}
      onCancel={onReject}
      maskClosable={false}
      keyboard={false}
      footer={(_, { OkBtn, CancelBtn }) => (
        <>
          <Button onClick={onStop}>Stop task</Button>
          {approval?.toolName === 'bash' && (
            <Button disabled={!valid} onClick={() => onApprovePattern(prefix)}>
              Allow pattern for conversation
            </Button>
          )}
          <CancelBtn />
          <OkBtn />
        </>
      )}
    >
      {approval?.toolName === 'bash' && (
        <>
          <Typography.Paragraph>
            Allow commands starting with this executable and arguments for this conversation:
          </Typography.Paragraph>
          <Input
            aria-label="Command prefix"
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
          />
        </>
      )}
      <Typography.Paragraph>The agent wants to run a gated tool call:</Typography.Paragraph>
      <Typography.Text code style={{ whiteSpace: 'pre-wrap', display: 'block' }}>
        {approval?.title ?? ''}
      </Typography.Text>
      <Typography.Paragraph
        type="secondary"
        style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto', marginTop: 8 }}
      >
        {approval?.argsPreview ?? ''}
      </Typography.Paragraph>
    </Modal>
  );
}

/** Team management: create teams, see members, add members by email. */
function TeamsModal({
  open,
  onClose,
  teams,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  teams: TeamView[];
  onChanged: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [newTeam, setNewTeam] = useState('');
  const [memberEmails, setMemberEmails] = useState<Record<string, string>>({});

  const createTeam = async () => {
    const name = newTeam.trim();
    if (!name) return;
    try {
      await client.createTeam(name);
      setNewTeam('');
      onChanged();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  const addMember = async (teamId: string) => {
    const email = (memberEmails[teamId] ?? '').trim();
    if (!email) return;
    try {
      await client.addTeamMember(teamId, email);
      setMemberEmails((prev) => ({ ...prev, [teamId]: '' }));
      onChanged();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal open={open} title="Teams & shared workspaces" footer={null} onCancel={onClose}>
      <Flex vertical gap={12}>
        <Flex gap={8}>
          <Input
            placeholder="New team name"
            value={newTeam}
            onChange={(e) => setNewTeam(e.target.value)}
            onPressEnter={() => void createTeam()}
          />
          <Button type="primary" onClick={() => void createTeam()}>
            Create
          </Button>
        </Flex>
        {teams.length === 0 && (
          <Typography.Text type="secondary">
            Create a team to share a workspace, then invite members by email.
          </Typography.Text>
        )}
        {teams.map((t) => (
          <div key={t.teamId}>
            <Typography.Text strong>{t.name}</Typography.Text>
            <div style={{ marginBlock: 4 }}>
              {t.members.map((m) => (
                <Tag key={m.userId}>
                  {m.email} · {m.role}
                </Tag>
              ))}
            </div>
            <Flex gap={8}>
              <Input
                placeholder="member@example.com"
                value={memberEmails[t.teamId] ?? ''}
                onChange={(e) =>
                  setMemberEmails((prev) => ({ ...prev, [t.teamId]: e.target.value }))
                }
                onPressEnter={() => void addMember(t.teamId)}
              />
              <Button onClick={() => void addMember(t.teamId)}>Add member</Button>
            </Flex>
          </div>
        ))}
      </Flex>
    </Modal>
  );
}

/** Admin audit viewer (docs/design.md §13): paginated antd Table over /api/audit. */
function AuditTable() {
  const { message } = AntdApp.useApp();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);

  const load = useCallback(
    async (p: number) => {
      setLoading(true);
      try {
        const result = await client.queryAudit({ limit: 20, offset: (p - 1) * 20 });
        setRows(result.records as AuditRow[]);
        setTotal(result.total);
        setPage(p);
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [message],
  );

  useEffect(() => {
    void load(1);
  }, [load]);

  return (
    <div style={{ flex: 1, overflowY: 'auto', paddingBlock: 16 }}>
      <Table<AuditRow>
        size="small"
        rowKey="id"
        scroll={{ x: 800 }}
        loading={loading}
        dataSource={rows}
        pagination={{
          current: page,
          total,
          pageSize: 20,
          onChange: (p) => void load(p),
        }}
        columns={[
          { title: 'Time', dataIndex: 'at', render: (v: string) => new Date(v).toLocaleString() },
          { title: 'User', dataIndex: 'userId' },
          { title: 'Action', dataIndex: 'action' },
          { title: 'Target', dataIndex: 'target' },
          {
            title: 'Result',
            dataIndex: 'result',
            render: (v: string) =>
              v === 'ok' ? '✅ ok' : v === 'denied' ? '⛔ denied' : `❌ ${v}`,
          },
          {
            title: 'Session',
            dataIndex: 'sessionId',
            render: (v?: string) => v?.slice(0, 8) ?? '',
          },
        ]}
      />
    </div>
  );
}
