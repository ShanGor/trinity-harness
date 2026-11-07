import { useEffect, useState, type ReactElement } from 'react';
import { Alert, Button } from 'antd';
import type { EventStreamStatus } from '@trinity-harness/client-acp';

/** Connection feedback stays outside conversation history and the composer. */
export function EventStreamNotice({
  status,
  onRetry,
}: {
  status: EventStreamStatus;
  onRetry: () => void;
}): ReactElement | null {
  const since = status.state === 'reconnecting' ? status.since : null;
  const [prolonged, setProlonged] = useState(false);
  useEffect(() => {
    setProlonged(false);
    if (since === null) return;
    // A one-shot UI deadline, independent of the client's retry scheduling.
    const timer = setTimeout(() => setProlonged(true), Math.max(0, since + 15_000 - Date.now()));
    return () => clearTimeout(timer);
  }, [since]);

  if (status.state === 'connecting' || status.state === 'open') return null;
  const blocked = status.state === 'blocked';
  const text = blocked
    ? status.reason === 'authentication'
      ? 'Sign in again to restore live updates.'
      : status.reason === 'access'
        ? 'Live updates stopped: you no longer have access to this conversation.'
        : 'Live updates stopped: this conversation is unavailable.'
    : prolonged
      ? 'Live updates are still disconnected. Retrying automatically…'
      : 'Connection interrupted—reconnecting…';

  return (
    <div role="status" aria-live="polite" aria-label="Live update connection">
      <Alert
        type={blocked || prolonged ? 'warning' : 'info'}
        showIcon
        message={text}
        action={
          (blocked || prolonged) && (
            <Button size="small" onClick={onRetry}>
              Retry connection
            </Button>
          )
        }
      />
    </div>
  );
}
