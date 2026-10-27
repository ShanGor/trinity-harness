import { useEffect, useRef, useState, type ReactElement } from 'react';
import { App, Button, Input, Modal } from 'antd';
import type { AcpClient } from '@trinity-harness/client-acp';
import { newId, type ServerEvent } from '@trinity-harness/shared';
import type { ChatItem } from './chat-items';
import { ResponseActions } from './response-actions';

export function MessageControls({
  client,
  sessionId,
  item,
  prompt,
  editable,
  busy,
  onEvent,
}: {
  client: AcpClient;
  sessionId: string | null;
  item: ChatItem;
  prompt?: ChatItem;
  editable: boolean;
  busy: boolean;
  onEvent?: (event: ServerEvent) => void;
}): ReactElement {
  const { message } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const operation = useRef<{ id: string; text: string; kind: 'retry' | 'amend' } | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const promptId = prompt?.messageId;
  const available = !!sessionId && !!promptId && !!onEvent;

  const revise = async (kind: 'retry' | 'amend'): Promise<void> => {
    if (!available || pending) return;
    setPending(true);
    const abort = new AbortController();
    controller.current = abort;
    const nextText = kind === 'retry' ? prompt!.content : text.trim();
    if (
      !operation.current ||
      operation.current.kind !== kind ||
      operation.current.text !== nextText
    )
      operation.current = { id: newId(), text: nextText, kind };
    const id = operation.current.id;
    try {
      if (busy)
        await client.stopAndWait(
          sessionId!,
          AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
        );
      abort.signal.throwIfAborted();
      await client.reviseMessage(
        sessionId!,
        { promptId: promptId!, operationId: id, kind },
        nextText || '[see attachments]',
      );
      if (abort.signal.aborted) return;
      setEditing(false);
    } catch (error) {
      if (!abort.signal.aborted) message.error(String(error));
    } finally {
      if (!abort.signal.aborted) setPending(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!available || pending) return;
    setPending(true);
    try {
      await client.removeMessage(sessionId!, promptId!, item.role);
      onEvent!({
        type: 'message/removed',
        sessionId: sessionId!,
        promptId: promptId!,
        role: item.role,
      });
    } catch (error) {
      message.error(String(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <ResponseActions content={item.content} role={item.role}>
        {available && (
          <>
            {item.role === 'assistant' && (item.error || item.stopped) && !prompt?.removed && (
              <Button
                type="text"
                className="message-text-action"
                disabled={busy || pending}
                onClick={() => void revise('retry')}
              >
                Retry
              </Button>
            )}
            {item.role === 'user' && editable && (
              <Button
                type="text"
                className="message-text-action"
                disabled={pending}
                onClick={() => {
                  setText(item.content);
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            )}
            <Button
              type="text"
              className="message-text-action"
              aria-label={`Delete ${item.role === 'user' ? 'message' : 'response'}`}
              disabled={pending}
              onClick={() => void remove()}
            >
              Delete
            </Button>
          </>
        )}
      </ResponseActions>
      <Modal
        title="Edit message"
        open={editing}
        onCancel={() => {
          if (!pending) setEditing(false);
        }}
        onOk={() => void revise('amend')}
        okText="Save and retry"
        confirmLoading={pending}
        okButtonProps={{ disabled: !text.trim() }}
        cancelButtonProps={{ disabled: pending }}
        destroyOnHidden
      >
        {busy && <p>Saving will stop the current response and send your amended message.</p>}
        <Input.TextArea
          aria-label="Edit message text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          autoSize={{ minRows: 3, maxRows: 12 }}
        />
      </Modal>
    </>
  );
}
