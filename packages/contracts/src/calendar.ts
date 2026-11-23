import { z } from 'zod';
import type { Identity } from './identity.js';
import {
  calendarTimingSchema,
  calendarTimezoneSchema,
  nextOffsetCalendarInstant,
  calendarLocalParts,
} from './calendar-time.js';

export const calendarDefinitionSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    kind: z.enum(['event', 'deadline', 'reminder', 'task']),
    notes: z.string().max(4000).default(''),
    timing: calendarTimingSchema,
    reminderMinutes: z.array(z.number().int().min(0).max(527040)).max(8).default([0]),
    task: z
      .object({
        request: z.string().trim().min(1).max(20000),
        sourceSessionId: z.uuid(),
        relatedItemId: z.uuid().optional(),
        startBeforeMinutes: z.number().int().min(0).max(527040).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (d) => (d.kind === 'task') === !!d.task && !(d.kind === 'task' && d.timing.allDay),
    'Only timed agent tasks may contain an execution request',
  );
export type CalendarDefinition = z.infer<typeof calendarDefinitionSchema>;
export function nextCalendarDefinitionInstant(
  definition: CalendarDefinition,
  after: Date,
): Date | null {
  return nextOffsetCalendarInstant(
    definition.timing,
    after,
    definition.task?.relatedItemId ? (definition.task.startBeforeMinutes ?? 0) : 0,
  );
}
export const calendarSourceSchema = z
  .object({
    sessionId: z.uuid(),
    eventId: z.uuid(),
    quote: z.string().trim().min(1).max(2000),
    capture: z.enum(['explicit', 'automatic', 'suggestion']),
  })
  .strict();
export type CalendarSource = z.infer<typeof calendarSourceSchema>;
export const calendarStatusSchema = z.enum([
  'active',
  'suggested',
  'paused',
  'completed',
  'cancelled',
]);
export const calendarSaveSchema = z
  .object({
    operationId: z.uuid(),
    id: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    definition: calendarDefinitionSchema,
    status: calendarStatusSchema,
  })
  .strict();
export type CalendarSave = z.infer<typeof calendarSaveSchema>;
export const calendarRecordSchema = calendarSaveSchema
  .omit({ operationId: true, expectedRevision: true })
  .extend({
    revision: z.number().int().positive(),
    source: calendarSourceSchema.nullable(),
    scheduleId: z.uuid().nullable(),
    nextAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  });
export type CalendarRecord = z.infer<typeof calendarRecordSchema>;
export const calendarPreferencesSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    automaticCapture: z.boolean(),
    showLunar: z.boolean(),
    timezone: calendarTimezoneSchema,
    defaultReminderMinutes: z.array(z.number().int().min(0).max(527040)).max(8),
    quietHours: z
      .object({
        startHour: z.number().int().min(0).max(23),
        endHour: z.number().int().min(0).max(23),
      })
      .strict()
      .nullable(),
    pushEnabled: z.boolean(),
  })
  .strict();
export type CalendarPreferences = z.infer<typeof calendarPreferencesSchema>;
export const defaultCalendarPreferences: CalendarPreferences = {
  revision: 0,
  automaticCapture: false,
  showLunar: true,
  timezone: 'UTC',
  defaultReminderMinutes: [0],
  quietHours: null,
  pushEnabled: false,
};
export const calendarReminderSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  revision: z.number().int().positive(),
  title: z.string().max(200),
  eventAt: z.iso.datetime(),
  dueAt: z.iso.datetime(),
  status: z.enum(['pending', 'delivered', 'missed', 'cancelled', 'dismissed']),
  deliveredAt: z.iso.datetime().nullable(),
  readAt: z.iso.datetime().nullable(),
  pushStatus: z.enum(['pending', 'sent', 'unavailable', 'failed', 'suppressed']),
});
export type CalendarReminder = z.infer<typeof calendarReminderSchema>;
export const calendarSnapshotSchema = z.object({
  available: z.boolean(),
  items: z.array(calendarRecordSchema).max(200),
  reminders: z.array(calendarReminderSchema).max(100),
  preferences: calendarPreferencesSchema,
  pushAvailable: z.boolean(),
  pushPublicKey: z.string().nullable(),
});
export type CalendarSnapshot = z.infer<typeof calendarSnapshotSchema>;
export const calendarReminderActionSchema = z
  .object({
    action: z.enum(['read', 'dismiss', 'snooze']),
    minutes: z.number().int().min(1).max(10080).optional(),
  })
  .strict()
  .refine((a) => a.action !== 'snooze' || a.minutes !== undefined, 'Snooze duration required');
export type CalendarReminderAction = z.infer<typeof calendarReminderActionSchema>;
export const calendarPushSubscriptionSchema = z
  .object({
    endpoint: z.string().url().max(2048),
    keys: z
      .object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{20,30}$/),
      })
      .strict(),
  })
  .strict();
export type CalendarPushSubscription = z.infer<typeof calendarPushSubscriptionSchema>;

/** Authenticated tool provenance, supplied by the tool adapter; never an HTTP payload. */
export interface CalendarWriteOrigin {
  source: CalendarSource;
  callId: string;
}
export interface CalendarStore {
  snapshot(identity: Identity): Promise<CalendarSnapshot>;
  save(
    identity: Identity,
    input: CalendarSave,
    at: Date,
    origin?: CalendarWriteOrigin,
  ): Promise<CalendarRecord>;
  preferences(identity: Identity, input: CalendarPreferences): Promise<CalendarPreferences>;
  reminderAction(
    identity: Identity,
    id: string,
    action: CalendarReminderAction,
    at: Date,
  ): Promise<void>;
  subscribe(identity: Identity, subscription: CalendarPushSubscription | null): Promise<void>;
  tick(at: Date, signal?: AbortSignal): Promise<void>;
}
export interface CalendarPushPort {
  readonly publicKey: string;
  send(
    subscription: CalendarPushSubscription,
    reminderId: string,
    signal?: AbortSignal,
  ): Promise<'sent' | 'expired' | 'failed'>;
}

export const calendarToolParametersSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('read') }).strict(),
  z
    .object({
      operation: z.literal('save'),
      id: z.uuid().optional(),
      expectedRevision: z.number().int().nonnegative(),
      definition: calendarDefinitionSchema,
      status: calendarStatusSchema,
      sourceQuote: z.string().trim().min(1).max(2000),
      capture: z.enum(['explicit', 'automatic', 'suggestion']),
    })
    .strict(),
]);

export interface CalendarOccurrence {
  item: CalendarRecord;
  at: string;
  endAt: string;
}
/** All-day commitments retain their civil date across changes to the viewing timezone. */
export function calendarOccurrenceDate(
  occurrence: CalendarOccurrence,
  viewingTimezone: string,
): string {
  return calendarLocalParts(
    new Date(occurrence.at),
    occurrence.item.definition.timing.allDay
      ? occurrence.item.definition.timing.timezone
      : viewingTimezone,
  ).date;
}
/** Bounded display projection; truncation must remain visible to the user. */
export function calendarOccurrences(
  records: CalendarRecord[],
  from: Date,
  to: Date,
  limit = 500,
): { occurrences: CalendarOccurrence[]; truncated: boolean } {
  const occurrences: CalendarOccurrence[] = [];
  let truncated = false;
  for (const item of records) {
    if (!['active', 'paused'].includes(item.status)) continue;
    let cursor = new Date(from.getTime() - 1);
    for (let n = 0; n <= 64; n++) {
      const next = nextCalendarDefinitionInstant(item.definition, cursor);
      if (!next || next >= to) break;
      if (n === 64 || occurrences.length >= limit) {
        truncated = true;
        break;
      }
      occurrences.push({
        item,
        at: next.toISOString(),
        endAt: new Date(
          next.getTime() + item.definition.timing.durationMinutes * 60000,
        ).toISOString(),
      });
      cursor = next;
    }
  }
  return { occurrences: occurrences.sort((a, b) => a.at.localeCompare(b.at)), truncated };
}
