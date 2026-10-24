import { memo, useEffect, useState, type ReactElement } from 'react';
import { App, Badge, Button } from 'antd';
import type { AcpClient } from '@trinity-harness/client-acp';

/** Durable inbox is the source; this isolated view does not update conversation history. */
export const InboxIndicator = memo(function InboxIndicator({
  client,
  onOpen,
}: {
  client: Pick<AcpClient, 'getInbox'>;
  onOpen: () => void;
}): ReactElement | null {
  const [unread, setUnread] = useState(0);
  const [available, setAvailable] = useState(false);
  const { notification } = App.useApp();
  useEffect(() => {
    const cancel = new AbortController();
    let observed: Map<string, string> | null = null;
    const watch = async (): Promise<void> => {
      while (!cancel.signal.aborted) {
        if (document.visibilityState !== 'hidden') {
          try {
            const result = await client.getInbox(
              AbortSignal.any([cancel.signal, AbortSignal.timeout(10_000)]),
            );
            if (cancel.signal.aborted) return;
            setAvailable(result.available);
            if (!result.available) return;
            setUnread(result.items.filter((item) => !item.readAt).length);
            if (
              observed &&
              result.items.some((item) => !item.readAt && observed!.get(item.id) !== item.status)
            )
              notification.info({
                key: 'assistant-inbox-update',
                message: 'Your assistant has a task update',
                description: 'Open Updates to review the result or task status.',
              });
            observed = new Map(result.items.map((item) => [item.id, item.status]));
          } catch {
            if (cancel.signal.aborted) return;
            setAvailable(false);
          }
        }
        const wake = AbortSignal.any([cancel.signal, AbortSignal.timeout(15_000)]);
        await new Promise<void>((resolve) => {
          if (wake.aborted) resolve();
          else wake.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    };
    void watch();
    return () => cancel.abort();
  }, [client, notification]);
  if (!available) return null;
  return (
    <Button type="text" onClick={onOpen} aria-label="Task updates">
      <Badge count={unread} size="small">
        Updates
      </Badge>
    </Button>
  );
});
