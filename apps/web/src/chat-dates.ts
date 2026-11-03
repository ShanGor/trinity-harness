import type { ChatItem } from './chat-items';

/** Only prompts open a date group; their complete response stays in that group. */
export function chatDateHeadings(
  items: readonly ChatItem[],
  timezone: string,
): Map<string, string> {
  const dates = new Map<string, string>();
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  let previous: string | undefined;
  for (const item of items) {
    if (item.removed || item.role !== 'user' || !item.at) continue;
    const instant = new Date(item.at);
    if (!Number.isFinite(instant.getTime())) continue;
    const parts = format.formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((value) => value.type === type)!.value;
    const date = `${part('year')}-${part('month')}-${part('day')}`;
    if (date !== previous) dates.set(item.key, date);
    previous = date;
  }
  return dates;
}
