import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { App, Button, Flex, Typography } from 'antd';
import type { AcpClient, SessionSummary } from '@trinity-harness/client-acp';
import type { ServerEvent } from '@trinity-harness/shared';
import { applyTimelineEvent, type ChatItem } from './chat-items';
import { ChatComposer } from './chat-composer';

export function SideConversation({
  client,
  session,
  visible,
  onClose,
  onExpand,
  renderTranscript,
  draftStore,
  draftOwner,
}: {
  client: AcpClient;
  session: SessionSummary;
  visible: boolean;
  onClose: () => void;
  onExpand: () => void;
  draftStore: Map<string, string>;
  draftOwner: string;
  renderTranscript: (items: ChatItem[]) => ReactNode;
}): ReactElement {
  const { message } = App.useApp();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<{
    approvalId: string;
    title: string;
    preview: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    let stream: { close(): void } | undefined;
    setItems([]);
    setBusy(false);
    setApproval(null);
    const event = (value: ServerEvent): void => {
      if (!active) return;
      setItems((current) => applyTimelineEvent(current, value));
      if (value.type === 'session/turn_status')
        setBusy(value.status === 'running' || value.status === 'awaiting_approval');
      if (value.type === 'session/update' && value.update.kind === 'agent_message_chunk')
        setBusy(true);
      if (value.type === 'session/update' && value.update.kind === 'permission_request')
        setApproval(
          value.update.status === 'pending'
            ? {
                approvalId: value.update.approvalId,
                title: value.update.title,
                preview: value.update.argsPreview,
              }
            : null,
        );
      if (value.type === 'error') {
        setBusy(false);
        setApproval(null);
        message.error(value.message);
      }
      if (
        value.type === 'session/turn_status' &&
        (value.status === 'completed' || value.status === 'aborted')
      )
        setApproval(null);
    };
    void client
      .getTimeline(session.sessionId)
      .then((page) => {
        if (!active) return;
        for (const value of page.events) event(value);
        stream = client.openEventStream(
          session.sessionId,
          { onEvent: event },
          { afterSeq: page.lastSeq },
        );
      })
      .catch((error: unknown) => {
        if (active) message.error(String(error));
      });
    return () => {
      active = false;
      stream?.close();
    };
  }, [client, session.sessionId, message]);
  return (
    <aside className="side-conversation" hidden={!visible} aria-label="Side conversation">
      <Flex align="center" gap={8} className="side-conversation-header">
        <Typography.Text strong>
          {session.kind === 'work' ? 'Work' : 'Chat'} · {session.title || 'Untitled'}
        </Typography.Text>
        <Button onClick={onExpand}>Expand</Button>
        <Button onClick={onClose} aria-label="Close side conversation">
          ×
        </Button>
      </Flex>
      {session.workspaceUri && (
        <Typography.Text type="secondary" title={session.workspaceUri}>
          {session.kind === 'chat'
            ? 'Session workspace'
            : session.scope === 'team'
              ? 'Shared team workspace'
              : 'Personal workspace'}{' '}
          · {session.taskState?.replaceAll('_', ' ')}
        </Typography.Text>
      )}
      {renderTranscript(items)}
      {items.some((item) => item.final && item.messageId) && (
        <Button
          onClick={() => {
            const answer = [...items].reverse().find((item) => item.final && item.messageId);
            if (answer?.messageId)
              void client
                .shareBack(session.sessionId, answer.messageId)
                .then(() => message.success('Answer link shared to Main chat.'))
                .catch((error: unknown) => message.error(String(error)));
          }}
        >
          Share answer link to Main chat
        </Button>
      )}
      {approval && (
        <div className="side-approval">
          <Typography.Text strong>{approval.title}</Typography.Text>
          <pre>{approval.preview}</pre>
          <Flex gap={8}>
            <Button
              onClick={() =>
                void client
                  .respondApproval(session.sessionId, approval.approvalId, 'allowed')
                  .then(() => setApproval(null))
                  .catch((error: unknown) => message.error(String(error)))
              }
            >
              Allow once
            </Button>
            <Button
              onClick={() =>
                void client
                  .respondApproval(session.sessionId, approval.approvalId, 'rejected')
                  .then(() => setApproval(null))
                  .catch((error: unknown) => message.error(String(error)))
              }
            >
              Deny
            </Button>
          </Flex>
        </div>
      )}
      {busy && (
        <Button
          danger
          onClick={() =>
            void client
              .cancelTurn(session.sessionId)
              .catch((error: unknown) => message.error(String(error)))
          }
        >
          Stop
        </Button>
      )}
      <ChatComposer
        draftOwner={draftOwner}
        draftStore={draftStore}
        draftKey={session.sessionId}
        busy={busy}
        resetVersion={0}
        onCancel={() => void client.cancelTurn(session.sessionId)}
        onSubmit={async (text) => {
          try {
            setBusy(true);
            await client.sendPrompt(session.sessionId, text);
            return true;
          } catch (error) {
            setBusy(false);
            message.error(String(error));
            return false;
          }
        }}
      />
    </aside>
  );
}
