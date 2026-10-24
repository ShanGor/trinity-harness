import { z } from 'zod';
import type { Identity } from './identity.js';

export const scheduleTimingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.iso.datetime() }).strict(),
  z
    .object({
      kind: z.literal('daily'),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
      weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    })
    .strict(),
]);
export const scheduleDefinitionSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    request: z.string().trim().min(1).max(20_000),
    sourceSessionId: z.uuid(),
    timezone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Unknown IANA timezone'),
    timing: scheduleTimingSchema,
  })
  .strict();
export type ScheduleDefinition = z.infer<typeof scheduleDefinitionSchema>;
export const scheduleCreateSchema = scheduleDefinitionSchema.extend({ operationId: z.uuid() });
export type ScheduleCreate = z.infer<typeof scheduleCreateSchema>;
export const scheduleRecordSchema = scheduleDefinitionSchema.extend({
  id: z.uuid(),
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  nextFireAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ScheduleRecord = z.infer<typeof scheduleRecordSchema>;
export const scheduleListSchema = z.object({
  available: z.boolean(),
  schedules: z.array(scheduleRecordSchema).max(200),
});
export const inboxItemSchema = z.object({
  id: z.uuid(),
  scheduleId: z.uuid(),
  title: z.string().max(200),
  status: z.enum(['queued', 'completed', 'failed', 'cancelled', 'skipped']),
  reason: z.enum(['due', 'missed', 'overlap', 'access_revoked', 'outcome']).optional(),
  sessionId: z.uuid().nullable(),
  at: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;
export const inboxListSchema = z.object({
  available: z.boolean(),
  items: z.array(inboxItemSchema).max(100),
});
export interface ScheduleStore {
  list(identity: Identity): Promise<ScheduleRecord[]>;
  create(identity: Identity, input: ScheduleCreate, at: Date): Promise<ScheduleRecord>;
  setEnabled(
    identity: Identity,
    id: string,
    revision: number,
    enabled: boolean,
    at: Date,
  ): Promise<ScheduleRecord | null>;
  inbox(identity: Identity): Promise<InboxItem[]>;
  acknowledge(identity: Identity, id: string, at: Date): Promise<void>;
  assertRunAuthorized(sessionId: string, actor: string): Promise<void>;
  /** Transactionally materializes due runs in the existing PG prompt outbox. */
  tick(at: Date, signal?: AbortSignal): Promise<void>;
}

export const scheduleTriggerSchema = z.object({
  kind: z.literal('schedule'),
  scheduleId: z.uuid(),
  revision: z.number().int().positive(),
  occurrenceId: z.uuid(),
  scheduledAt: z.iso.datetime(),
});

/** Calendar semantics: skip missing local minutes, use only the first DST fold occurrence. */
export function nextScheduleInstant(definition: ScheduleDefinition, after: Date): Date | null {
  if (definition.timing.kind === 'once') {
    const at = new Date(definition.timing.at);
    return at > after ? at : null;
  }
  const timing = definition.timing;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: definition.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const local = (date: Date): { day: string; minute: number; weekday: number } => {
    const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
    return {
      day: `${parts['year']}-${parts['month']}-${parts['day']}`,
      minute: Number(parts['hour']) * 60 + Number(parts['minute']),
      weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts['weekday']!),
    };
  };
  const initial = local(after);
  const wanted = timing.hour * 60 + timing.minute;
  const firstMinute = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  // Eight days includes a full weekly cycle plus DST shifts.
  for (let time = firstMinute; time <= firstMinute + 8 * 86_400_000; time += 60_000) {
    const candidate = new Date(time);
    const current = local(candidate);
    if (current.minute !== wanted || !timing.weekdays.includes(current.weekday)) continue;
    if (current.day === initial.day && initial.minute >= wanted) continue;
    let duplicateFold = false;
    for (let earlier = time - 26 * 60 * 60_000; earlier < time; earlier += 60_000) {
      const previous = local(new Date(earlier));
      if (previous.day === current.day && previous.minute === wanted) {
        duplicateFold = true;
        break;
      }
    }
    if (duplicateFold) continue;
    return candidate;
  }
  return null;
}
