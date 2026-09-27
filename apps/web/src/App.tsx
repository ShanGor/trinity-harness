import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ServerEvent, SessionUpdate } from '@trinity-harness/shared';
import { App as AntdApp, Collapse, Flex, Typography } from 'antd';
import { Bubble, Sender } from '@ant-design/x';

import { AcpClient } from '@trinity-harness/client-acp';

/**
 * M1 chat UI (docs/design.md §11.5): antd-x components consume the ACP-flavored
 * session/update events produced by the server — no private UI protocol.
 */

type ToolCallView = {
  toolCallId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  content?: string;
};

type ChatItem = {
  key: string;
  role: 'user' | 'assistant';
  content: string;
  streaming: boolean;
  tools: ToolCallView[];
};

const client = new AcpClient();

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
  const [items, setItems] = useState<ChatItem[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
      }
    },
    [applyToLastAssistant, message],
  );

  useEffect(() => {
    return () => streamRef.current?.close();
  }, []);

  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionRef.current) return sessionRef.current;
    const id = await client.createSession();
    sessionRef.current = id;
    setSessionId(id);
    streamRef.current = client.openEventStream(id, {
      onEvent: handleEvent,
      onError: (err) => message.warning(`event stream error (reconnecting): ${String(err)}`),
    });
    return id;
  }, [handleEvent, message]);

  const onSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setBusy(true);
      setItems((prev) => [
        ...prev,
        { key: crypto.randomUUID(), role: 'user', content: trimmed, streaming: false, tools: [] },
        { key: crypto.randomUUID(), role: 'assistant', content: '', streaming: true, tools: [] },
      ]);
      try {
        const id = await ensureSession();
        await client.sendPrompt(id, trimmed);
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
        setBusy(false);
        applyToLastAssistant((item) => ({ ...item, streaming: false }));
      }
    },
    [applyToLastAssistant, busy, ensureSession, message],
  );

  const bubbleItems = useMemo(
    () =>
      items.map((item) => ({
        key: item.key,
        role: item.role,
        content: item.content,
        ...(item.role === 'assistant'
          ? {
              messageRender: (content: string) => (
                <div>
                  <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }}>
                    {content}
                    {item.streaming ? '▋' : ''}
                  </Typography.Paragraph>
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
      <Typography.Title level={4} style={{ marginTop: 8 }}>
        Trinity Harness{' '}
        {sessionId ? (
          <Typography.Text type="secondary">· {sessionId.slice(0, 8)}</Typography.Text>
        ) : null}
      </Typography.Title>
      <Bubble.List
        items={bubbleItems}
        roles={{
          user: { placement: 'end' as const },
          assistant: { placement: 'start' as const },
        }}
        style={{ flex: 1, overflowY: 'auto', paddingBlock: 16 }}
      />
      <Sender
        value=""
        onSubmit={onSubmit}
        loading={busy}
        placeholder="Describe a coding task…"
        style={{ marginBottom: 16 }}
      />
    </Flex>
  );
}
