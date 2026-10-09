import { memo, type ReactElement } from 'react';

const timestampFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export const MessageTimestamp = memo(function MessageTimestamp({
  at,
}: {
  at?: string;
}): ReactElement {
  if (!at) return <span className="message-timestamp">Time unavailable</span>;
  const date = new Date(at);
  return (
    <time className="message-timestamp" dateTime={at} title={date.toLocaleString()}>
      {timestampFormat.format(date)}
    </time>
  );
});
