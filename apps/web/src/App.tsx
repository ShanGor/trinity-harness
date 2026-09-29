import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ServerEvent, SessionUpdate } from '@trinity-harness/shared';
import {
  App as AntdApp,
  Button,
  Collapse,
  Flex,
  Form,
  Input,
  Modal,
  Select,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { Bubble, Sender } from '@ant-design/x';

import { AcpClient } from '@trinity-harness/client-acp';

/**
 * M2 chat UI (docs/design.md §11.5): antd-x components consume the ACP-flavored
 * session/update events produced by the server — no private UI protocol. Auth:
 * bearer token from /api/auth/login, kept in sessionStorage; admin users get
 * an audit tab (docs/design.md §13).
 */

const TOKEN_KEY = 'trinity.token';

type Role = 'admin' | 'developer' | 'viewer';
type MeUser = { id: string; email: string; role: Role };

type ToolCallView = {
  toolCallId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  content?: string;
};

/** M4 multimodal: an attachment reference rendered from the blob store. */
type AttachmentView = { kind: 'image' | 'file'; uri: string; mimeType?: string };

type ChatItem = {
  key: string;
  role: 'user' | 'assistant';
  content: string;
  streaming: boolean;
  tools: ToolCallView[];
  attachments: AttachmentView[];
};

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

function upsertTool(item: ChatItem, update: SessionUpdate & { kind: 'tool_call' }): ChatItem {
  const existing = item.tools.find((t) => t.toolCallId === update.toolCallId);
  const next: ToolCallView = {
    toolCallId: update.toolCallId,
    title: existing?.title || update.title || update.toolCallId,
    status: update.status,
    ...(update.content !== undefined ? { content: update.content } : {}),
  };
  return {
    ...item,
    tools: existing
      ? item.tools.map((t) => (t.toolCallId === update.toolCallId ? next : t))
      : [...item.tools, next],
  };
}

export default function App() {
  const { message } = AntdApp.useApp();
  const [user, setUser] = useState<MeUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [policy, setPolicy] = useState<string>('workspace-write');
  /** M4: attachments staged for the next prompt (uploaded on selection). */
  const [staged, setStaged] = useState<(AttachmentView & { name: string })[]>([]);
  const sessionRef = useRef<string | null>(null);
  const streamRef = useRef<{ close(): void } | null>(null);

  const applyToLastAssistant = useCallback((fn: (item: ChatItem) => ChatItem) => {
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      return [...prev.slice(0, -1), fn(last)];
    });
  }, []);

  const handleEvent = useCallback(
    (event: ServerEvent) => {
      if (event.type === 'error') {
        message.error(event.message);
        setBusy(false);
        applyToLastAssistant((item) => ({ ...item, streaming: false }));
        return;
      }
      if (event.type === 'message/committed') {
        if (event.message.role === 'assistant') {
          applyToLastAssistant((item) => ({
            ...item,
            content: event.message.content,
            streaming: false,
          }));
        } else {
          // Replayed/relayed user message — skip if we already rendered it
          // locally when the prompt was sent.
          setItems((prev) => {
            const last = prev[prev.length - 1];
            if (
              last?.role === 'user' &&
              last.content === event.message.content &&
              (event.message.attachments ?? []).length === 0
            ) {
              return prev;
            }
            return [
              ...prev,
              {
                key: crypto.randomUUID(),
                role: 'user',
                content: event.message.content,
                streaming: false,
                tools: [],
                attachments: event.message.attachments ?? [],
              },
            ];
          });
        }
        setBusy(false);
        return;
      }
      if (event.type === 'session/update' && event.update.kind === 'agent_message_chunk') {
        const { text } = event.update;
        applyToLastAssistant((item) => ({ ...item, content: item.content + text }));
        return;
      }
      if (event.type === 'session/update' && event.update.kind === 'tool_call') {
        const update = event.update;
        applyToLastAssistant((item) => upsertTool(item, update));
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
          setBusy(false);
          setApproval(null);
          applyToLastAssistant((item) => ({ ...item, streaming: false }));
        }
      }
    },
    [applyToLastAssistant, message],
  );

  const onApprove = useCallback(
    async (outcome: 'allowed' | 'rejected') => {
      if (!approval || !sessionRef.current) return;
      try {
        await client.respondApproval(sessionRef.current, approval.approvalId, outcome);
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
      await client.cancelTurn(sessionRef.current);
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
        } else {
          sessionStorage.removeItem(TOKEN_KEY);
        }
      })
      .catch(() => sessionStorage.removeItem(TOKEN_KEY))
      .finally(() => setAuthChecked(true));
  }, []);

  const onLogin = useCallback(
    async (values: { email: string; password: string }) => {
      try {
        const { token, user: loggedIn } = (await client.login(values.email, values.password)) as {
          token: string;
          user: MeUser;
        };
        sessionStorage.setItem(TOKEN_KEY, token);
        setUser(loggedIn);
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      }
    },
    [message],
  );

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    streamRef.current?.close();
    setUser(null);
    setItems([]);
    setSessionId(null);
    sessionRef.current = null;
  }, []);

  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionRef.current) return sessionRef.current;
    const id = await client.createSession(undefined, policy);
    sessionRef.current = id;
    setSessionId(id);
    streamRef.current = client.openEventStream(id, {
      onEvent: handleEvent,
      onError: (err) => message.warning(`event stream error (reconnecting): ${String(err)}`),
    });
    return id;
  }, [handleEvent, message, policy]);

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
          key: crypto.randomUUID(),
          role: 'user',
          content: trimmed || '[attachments]',
          streaming: false,
          tools: [],
          attachments: sent,
        },
        {
          key: crypto.randomUUID(),
          role: 'assistant',
          content: '',
          streaming: true,
          tools: [],
          attachments: [],
        },
      ]);
      try {
        const id = await ensureSession();
        await client.sendPrompt(id, trimmed || '[see attachments]', mimeList);
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
        setBusy(false);
        applyToLastAssistant((item) => ({ ...item, streaming: false }));
      }
    },
    [applyToLastAssistant, busy, ensureSession, message, staged],
  );

  const bubbleItems = useMemo(
    () =>
      items.map((item) => ({
        key: item.key,
        role: item.role,
        content: item.content,
        ...(item.role === 'assistant' || item.attachments.length > 0
          ? {
              messageRender: (content: string) => (
                <div>
                  {content.length > 0 && (
                    <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }}>
                      {content}
                      {item.streaming ? '▋' : ''}
                    </Typography.Paragraph>
                  )}
                  <AttachmentList attachments={item.attachments} />
                  {item.tools.length > 0 && (
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
                  )}
                </div>
              ),
            }
          : {}),
      })),
    [items],
  );

  const chatPanel = (
    <>
      <Bubble.List
        items={bubbleItems}
        roles={{
          user: { placement: 'end' as const },
          assistant: { placement: 'start' as const },
        }}
        style={{ flex: 1, overflowY: 'auto', paddingBlock: 16 }}
      />
      {staged.length > 0 && (
        <Flex gap={8} wrap style={{ marginBottom: 8 }}>
          {staged.map((att) => (
            <Tag
              key={att.uri}
              closable
              onClose={() => setStaged((prev) => prev.filter((s) => s.uri !== att.uri))}
            >
              {att.kind === 'file' ? '📄' : '🖼️'} {att.name}
            </Tag>
          ))}
        </Flex>
      )}
      <Flex gap={8} align="end" style={{ marginBottom: 16 }}>
        <Upload
          beforeUpload={(file) => {
            void onStageFile(file as unknown as File);
            return false; // keep antd from posting the file itself
          }}
          showUploadList={false}
          accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
          disabled={busy}
        >
          <Button icon={<span>📎</span>} disabled={busy} aria-label="Attach image or PDF" />
        </Upload>
        <div style={{ flex: 1 }}>
          <Sender
            value={input}
            onChange={setInput}
            onSubmit={(text) => {
              setInput('');
              void onSubmit(text);
            }}
            loading={busy}
            placeholder="Describe a coding task… (attach images/PDFs with 📎)"
          />
        </div>
      </Flex>
    </>
  );

  const auditPanel = user?.role === 'admin' ? <AuditTable /> : null;

  if (!authChecked) {
    return null;
  }

  if (!user) {
    return (
      <Flex justify="center" align="center" style={{ height: '100vh' }}>
        <Form layout="vertical" style={{ width: 320 }} onFinish={onLogin}>
          <Typography.Title level={4}>Trinity Harness — Sign in</Typography.Title>
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
      </Flex>
    );
  }

  return (
    <Flex
      vertical
      style={{
        height: '100vh',
        maxWidth: 860,
        margin: '0 auto',
        padding: '16px 16px 0',
        boxSizing: 'border-box',
      }}
    >
      <Flex justify="space-between" align="center">
        <Typography.Title level={4} style={{ marginTop: 8 }}>
          Trinity Harness{' '}
          {sessionId ? (
            <Typography.Text type="secondary">· {sessionId.slice(0, 8)}</Typography.Text>
          ) : null}
        </Typography.Title>
        <Flex align="center" gap={12}>
          <Select
            size="small"
            value={policy}
            onChange={setPolicy}
            disabled={busy || !!sessionRef.current}
            options={[
              { value: 'workspace-write', label: 'workspace-write + ask' },
              { value: 'read-only', label: 'read-only' },
              { value: 'danger-full-access', label: 'danger-full-access + never' },
            ]}
            style={{ width: 200 }}
          />
          <Typography.Text type="secondary">
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
        onReject={() => void onApprove('rejected')}
      />
      <Flex justify="flex-end" style={{ marginBottom: 8 }}>
        {busy ? (
          <Button size="small" danger onClick={() => void onCancelTurn()}>
            Cancel turn
          </Button>
        ) : null}
      </Flex>
      {auditPanel ? (
        <Tabs
          style={{ flex: 1, minHeight: 0 }}
          items={[
            { key: 'chat', label: 'Chat', children: chatPanel },
            { key: 'audit', label: 'Audit', children: auditPanel },
          ]}
        />
      ) : (
        chatPanel
      )}
    </Flex>
  );
}

/** M4: renders message attachments — images inline, files as links. */
function AttachmentList({ attachments }: { attachments: AttachmentView[] }) {
  if (attachments.length === 0) return null;
  return (
    <Flex gap={8} wrap style={{ marginBottom: 8 }}>
      {attachments.map((att) =>
        att.kind === 'image' ? (
          <img
            key={att.uri}
            src={client.blobUrl(att.uri)}
            alt={att.uri}
            style={{ maxWidth: 320, maxHeight: 240, borderRadius: 8 }}
          />
        ) : (
          <a key={att.uri} href={client.blobUrl(att.uri)} target="_blank" rel="noreferrer">
            📄 {att.mimeType ?? 'document'}
          </a>
        ),
      )}
    </Flex>
  );
}

/** M3: antd Modal bound to a pending approval request (docs/design.md §11.5). */
function ApprovalModal({
  approval,
  onApprove,
  onReject,
}: {
  approval: PendingApproval | null;
  onApprove: () => void;
  onReject: () => void;
}) {
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
    >
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
