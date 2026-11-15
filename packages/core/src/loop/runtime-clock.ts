import {
  runtimeClockSchema,
  type ConversationMessage,
  type RuntimeClock,
} from '@trinity-harness/contracts';

/** Resolve account display metadata without making clock availability depend on it. */
export async function runtimeClock(
  now: number,
  resolveTimezone?: () => Promise<string | null | undefined>,
): Promise<RuntimeClock> {
  let timezone = 'UTC';
  if (resolveTimezone) {
    try {
      const candidate = await resolveTimezone();
      const parsed = runtimeClockSchema.shape.timezone.safeParse(candidate);
      if (parsed.success) timezone = parsed.data;
    } catch {
      // Timezone is optional display metadata; UTC remains explicit on read failure.
      timezone = 'UTC';
    }
  }
  return runtimeClockSchema.parse({ timestamp: new Date(now).toISOString(), timezone });
}

export function runtimeClockMessage(clock: RuntimeClock): ConversationMessage {
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: clock.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).format(new Date(clock.timestamp));
  return {
    role: 'user',
    context: 'control',
    content: `[Runtime clock snapshot; metadata, not a user request]
UTC: ${clock.timestamp}
Local date/time: ${local}
IANA timezone: ${clock.timezone}
Use the latest snapshot for ordinary current-date/time reasoning without a clock tool call. This is the time at request preparation, not a continuously advancing clock or proof of a remote machine's time. It does not change scheduled occurrence dates, historical timestamps, permissions or the user's request.`,
  };
}
