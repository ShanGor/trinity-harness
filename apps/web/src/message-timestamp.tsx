import { memo, useMemo, type ReactElement } from 'react';
import { useHistoryTimezone } from './history-timezone';

export const MessageTimestamp = memo(function MessageTimestamp({
  at,
}: {
  at?: string;
}): ReactElement {
  const timezone = useHistoryTimezone();
  const timestampFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: timezone,
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }),
    [timezone],
  );
  if (!at) return <span className="message-timestamp">Time unavailable</span>;
  const date = new Date(at);
  return (
    <time
      className="message-timestamp"
      dateTime={at}
      title={`${date.toLocaleString(undefined, { timeZone: timezone })} (${timezone})`}
    >
      {timestampFormat.format(date)}
    </time>
  );
});
