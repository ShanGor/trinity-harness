import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  calendarSaveSchema,
  calendarRecordSchema,
  calendarPreferencesSchema,
  calendarReminderSchema,
  calendarPushSubscriptionSchema,
  calendarToolParametersSchema,
  defaultCalendarPreferences,
  nextCalendarDefinitionInstant,
  calendarDateToGregorian,
  calendarLocalParts,
  calendarLocalInstant,
  removedPromptIds,
  sessionEventSchema,
  parsePermissionPolicy,
  type CalendarStore,
  type CalendarRecord,
  type CalendarSave,
  type CalendarSnapshot,
  type CalendarPreferences,
  type CalendarReminderAction,
  type CalendarPushSubscription,
  type CalendarWriteOrigin,
  type CalendarPushPort,
  type Identity,
} from '@trinity-harness/contracts';
import type { Db } from './client.js';
import {
  personalCalendarItems as items,
  personalCalendarChanges as changes,
  personalCalendarPreferences as preferences,
  personalCalendarReminders as reminders,
  assistantSchedules as schedules,
  scheduleOccurrences,
  sessions,
  sessionEvents,
  users,
} from './schema.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type ItemRow = typeof items.$inferSelect;
function reminderExpiry(item: ItemRow, eventAt: string): number {
  const timing = itemRecord(item).definition.timing;
  if (timing.allDay) {
    const date = calendarLocalParts(new Date(eventAt), timing.timezone).date;
    const tomorrow = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000)
      .toISOString()
      .slice(0, 10);
    return (
      calendarLocalInstant(tomorrow, 0, 0, timing.timezone)?.getTime() ??
      new Date(eventAt).getTime() + 86400000
    );
  }
  return new Date(eventAt).getTime() + Math.max(15, timing.durationMinutes) * 60000;
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
      : entry,
  );
}
function itemRecord(row: ItemRow): CalendarRecord {
  return calendarRecordSchema.parse({
    id: row.id,
    revision: row.revision,
    definition: row.definition,
    status: row.status,
    source: row.source,
    scheduleId: row.scheduleId,
    nextAt: row.nextAt ? new Date(row.nextAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  });
}
function owner(identity: Identity) {
  return and(eq(items.tenantId, identity.tenantId), eq(items.userId, identity.userId));
}
function preferenceOwner(identity: Identity) {
  return and(eq(preferences.tenantId, identity.tenantId), eq(preferences.userId, identity.userId));
}

/** A coded, content-free conflict; never expose source values or raw database errors. */
export class CalendarConflict extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
async function assertOwner(tx: Tx, identity: Identity): Promise<void> {
  const [user] = await tx
    .select()
    .from(users)
    .where(and(eq(users.id, identity.userId), eq(users.tenantId, identity.tenantId)))
    .for('share');
  if (!user || user.role === 'viewer' || identity.role === 'viewer')
    throw new CalendarConflict('CALENDAR_FORBIDDEN');
}
async function lockedPreferences(tx: Tx, identity: Identity): Promise<CalendarPreferences> {
  const [row] = await tx.select().from(preferences).where(preferenceOwner(identity));
  if (row) return calendarPreferencesSchema.parse(row.preferences);
  const [user] = await tx
    .select({ timezone: users.historyTimezone })
    .from(users)
    .where(and(eq(users.id, identity.userId), eq(users.tenantId, identity.tenantId)));
  return { ...defaultCalendarPreferences, timezone: user?.timezone ?? 'UTC' };
}

/** Owner/revision/source-fenced commitments, reminders and linked existing Work schedules. */
export class PgCalendarStore implements CalendarStore {
  constructor(
    private readonly db: Db,
    private readonly push?: CalendarPushPort,
  ) {}

  async snapshot(identity: Identity): Promise<CalendarSnapshot> {
    const [records, notices, prefs] = await Promise.all([
      this.db.select().from(items).where(owner(identity)).orderBy(desc(items.updatedAt)).limit(200),
      this.db
        .select()
        .from(reminders)
        .where(
          and(
            eq(reminders.tenantId, identity.tenantId),
            eq(reminders.userId, identity.userId),
            sql`${reminders.status} <> 'pending'`,
          ),
        )
        .orderBy(desc(reminders.dueAt))
        .limit(100),
      this.db.transaction((tx) => lockedPreferences(tx, identity)),
    ]);
    return {
      available: true,
      items: records.map(itemRecord),
      reminders: notices.map((r) =>
        calendarReminderSchema.parse({
          ...r,
          eventAt: new Date(r.eventAt).toISOString(),
          dueAt: new Date(r.dueAt).toISOString(),
          deliveredAt: r.deliveredAt ? new Date(r.deliveredAt).toISOString() : null,
          readAt: r.readAt ? new Date(r.readAt).toISOString() : null,
        }),
      ),
      preferences: prefs,
      pushAvailable: !!this.push,
      pushPublicKey: this.push?.publicKey ?? null,
    };
  }

  async save(
    identity: Identity,
    raw: CalendarSave,
    at: Date,
    origin?: CalendarWriteOrigin,
  ): Promise<CalendarRecord> {
    const input = calendarSaveSchema.parse(raw);
    if (
      !calendarDateToGregorian(input.definition.timing.date) &&
      !(
        input.definition.timing.date.calendar === 'chinese' &&
        input.definition.timing.recurrence === 'yearly'
      )
    )
      throw new CalendarConflict('CALENDAR_DATE_INVALID');
    return this.db.transaction(async (tx) => {
      if (origin)
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${origin.source.sessionId}))`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${identity.userId}, 2395))`,
      );
      await assertOwner(tx, identity);
      const [previous] = await tx
        .select()
        .from(changes)
        .where(
          and(
            eq(changes.tenantId, identity.tenantId),
            eq(changes.userId, identity.userId),
            eq(changes.operationId, input.operationId),
          ),
        );
      if (previous) {
        if (canonical(previous.input) !== canonical({ input, origin: origin ?? null }))
          throw new CalendarConflict('CALENDAR_OPERATION_CONFLICT');
        return calendarRecordSchema.parse(previous.snapshot);
      }
      const [current] = await tx
        .select()
        .from(items)
        .where(and(owner(identity), eq(items.id, input.id)))
        .for('update');
      if ((current?.revision ?? 0) !== input.expectedRevision)
        throw new CalendarConflict('CALENDAR_REVISION_CONFLICT');
      const [sameId] = current
        ? []
        : await tx.select({ id: items.id }).from(items).where(eq(items.id, input.id));
      if (sameId) throw new CalendarConflict('CALENDAR_REVISION_CONFLICT');
      if (!current) {
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(items)
          .where(owner(identity));
        if ((count?.n ?? 0) >= 200) throw new CalendarConflict('CALENDAR_LIMIT');
      }
      const prefs = await lockedPreferences(tx, identity);
      if (origin) await this.validateOrigin(tx, identity, input, origin, prefs);
      if (!current && origin) {
        const [duplicate] = await tx
          .select()
          .from(items)
          .where(
            and(
              owner(identity),
              sql`${items.source}->>'eventId' = ${origin.source.eventId}`,
              eq(items.definition, input.definition),
              eq(items.status, input.status),
            ),
          )
          .limit(1);
        if (duplicate) {
          const result = itemRecord(duplicate);
          await tx.insert(changes).values({
            id: randomUUID(),
            tenantId: identity.tenantId,
            userId: identity.userId,
            operationId: input.operationId,
            itemId: duplicate.id,
            input: { input, origin },
            snapshot: result,
            createdAt: at.toISOString(),
          });
          return result;
        }
      }
      let definition = input.definition;
      if (definition.task?.relatedItemId && input.status === 'active') {
        const [related] = await tx
          .select()
          .from(items)
          .where(and(owner(identity), eq(items.id, definition.task.relatedItemId)))
          .for('share');
        if (
          !related ||
          related.status !== 'active' ||
          (related.definition as { kind?: unknown }).kind === 'task' ||
          related.id === input.id
        )
          throw new CalendarConflict('CALENDAR_RELATED_ITEM_UNAVAILABLE');
        definition = {
          ...definition,
          timing: {
            ...itemRecord(related).definition.timing,
            allDay: false,
            durationMinutes: definition.timing.durationMinutes,
          },
        };
      }
      const dependents = await tx
        .select()
        .from(items)
        .where(
          and(owner(identity), sql`${items.definition}->'task'->>'relatedItemId' = ${input.id}`),
        )
        .for('update');
      if (definition.kind === 'task' && dependents.length)
        throw new CalendarConflict('CALENDAR_RELATED_ITEM_UNAVAILABLE');
      const next = nextCalendarDefinitionInstant(definition, at);

      if (input.status === 'active' && !next)
        throw new CalendarConflict('CALENDAR_NO_FUTURE_OCCURRENCE');
      let scheduleId = current?.scheduleId ?? null;
      if (definition.task && input.status === 'active') {
        const [source] = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, definition.task.sourceSessionId))
          .for('share');
        if (
          !source ||
          source.closedAt ||
          source.scope !== 'personal' ||
          !source.workspaceUri ||
          source.userId !== identity.userId ||
          source.tenantId !== identity.tenantId
        )
          throw new CalendarConflict('CALENDAR_WORKSPACE_UNAVAILABLE');
        if (origin && input.status === 'active' && origin.source.capture !== 'explicit')
          throw new CalendarConflict('CALENDAR_EXECUTION_NOT_AUTHORIZED');
        const scheduleDefinition = {
          title: definition.title,
          request: definition.task.request,
          sourceSessionId: source.id,
          timezone: definition.timing.timezone,
          sourcePolicy: parsePermissionPolicy(source.policy ?? 'workspace-write'),
          ...(origin ? { requestSource: origin.source } : {}),
          timing: {
            kind: 'calendar',
            timing: definition.timing,
            beforeMinutes: definition.task.relatedItemId
              ? (definition.task.startBeforeMinutes ?? 0)
              : 0,
          },
        };
        if (scheduleId) {
          const [existing] = await tx
            .select()
            .from(schedules)
            .where(eq(schedules.id, scheduleId))
            .for('update');
          if (!existing) throw new CalendarConflict('CALENDAR_SCHEDULE_UNAVAILABLE');
          const prior = existing.definition as {
            sourceSessionId?: unknown;
            sourcePolicy?: unknown;
          };
          if (prior.sourceSessionId === source.id && prior.sourcePolicy)
            scheduleDefinition.sourcePolicy = parsePermissionPolicy(
              JSON.stringify(prior.sourcePolicy),
            );
          await tx
            .update(schedules)
            .set({
              definition: scheduleDefinition,
              enabled: input.status === 'active',
              revision: existing.revision + 1,
              nextFireAt: input.status === 'active' ? (next?.toISOString() ?? null) : null,
            })
            .where(eq(schedules.id, scheduleId));
        } else {
          const [count] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(schedules)
            .where(
              and(eq(schedules.tenantId, identity.tenantId), eq(schedules.userId, identity.userId)),
            );
          if ((count?.n ?? 0) >= 200) throw new CalendarConflict('CALENDAR_SCHEDULE_LIMIT');
          scheduleId = randomUUID();
          await tx.insert(schedules).values({
            id: scheduleId,
            tenantId: identity.tenantId,
            userId: identity.userId,
            operationId: input.operationId,
            revision: 1,
            definition: scheduleDefinition,
            enabled: input.status === 'active',
            nextFireAt: input.status === 'active' ? (next?.toISOString() ?? null) : null,
            reviewCatchupInitialized: true,
            createdAt: at.toISOString(),
          });
        }
      } else if (scheduleId) {
        await tx
          .update(schedules)
          .set({ enabled: false, nextFireAt: null, revision: sql`${schedules.revision} + 1` })
          .where(eq(schedules.id, scheduleId));
      }
      if (current?.scheduleId) {
        // Already dispatched work is fenced by assertRunAuthorized. Never repeat or undo effects.
        await tx
          .update(scheduleOccurrences)
          .set({ readAt: null })
          .where(
            and(
              eq(scheduleOccurrences.scheduleId, current.scheduleId),
              eq(scheduleOccurrences.status, 'queued'),
            ),
          );
      }
      const reminderNext =
        next && input.status === 'active' ? nextCalendarDefinitionInstant(definition, next) : null;
      const lead = Math.max(0, ...definition.reminderMinutes) * 60000;
      const row = {
        id: input.id,
        tenantId: identity.tenantId,
        userId: identity.userId,
        revision: input.expectedRevision + 1,
        definition,
        status: input.status,
        source: origin?.source ?? current?.source ?? null,
        scheduleId,
        nextAt: input.status === 'active' ? (next?.toISOString() ?? null) : null,
        reminderNextAt: reminderNext?.toISOString() ?? null,
        reminderDueAt: reminderNext ? new Date(reminderNext.getTime() - lead).toISOString() : null,
        createdAt: current?.createdAt ?? at.toISOString(),
        updatedAt: at.toISOString(),
      };
      if (current) await tx.update(items).set(row).where(eq(items.id, input.id));
      else await tx.insert(items).values(row);
      await tx
        .update(reminders)
        .set({ status: 'cancelled', pushStatus: 'suppressed' })
        .where(
          and(eq(reminders.itemId, input.id), inArray(reminders.status, ['pending', 'delivered'])),
        );
      if (row.nextAt) await this.materialize(tx, row, new Date(row.nextAt));
      const result = itemRecord(row);
      await tx.insert(changes).values({
        id: randomUUID(),
        tenantId: identity.tenantId,
        userId: identity.userId,
        operationId: input.operationId,
        itemId: input.id,
        input: { input, origin: origin ?? null },
        snapshot: result,
        createdAt: at.toISOString(),
      });
      for (const dependent of dependents) await this.updateDependent(tx, dependent, row, at);
      return result;
    });
  }

  private async updateDependent(
    tx: Tx,
    dependent: ItemRow,
    parent: ItemRow,
    at: Date,
  ): Promise<void> {
    if (['cancelled', 'completed'].includes(dependent.status)) return;
    const original = itemRecord(dependent).definition;
    const definition = {
      ...original,
      timing: {
        ...itemRecord(parent).definition.timing,
        allDay: false,
        durationMinutes: original.timing.durationMinutes,
      },
    };
    const status = parent.status === 'active' ? dependent.status : 'paused';
    const next = status === 'active' ? nextCalendarDefinitionInstant(definition, at) : null;
    const cursor = next ? nextCalendarDefinitionInstant(definition, next) : null;
    const lead = Math.max(0, ...definition.reminderMinutes) * 60000;
    const row = {
      ...dependent,
      definition,
      status,
      revision: dependent.revision + 1,
      nextAt: next?.toISOString() ?? null,
      reminderNextAt: cursor?.toISOString() ?? null,
      reminderDueAt: cursor ? new Date(cursor.getTime() - lead).toISOString() : null,
      updatedAt: at.toISOString(),
    };
    const [priorSchedule] = dependent.scheduleId
      ? await tx
          .select()
          .from(schedules)
          .where(eq(schedules.id, dependent.scheduleId))
          .for('update')
      : [];
    if (dependent.scheduleId && definition.task && priorSchedule)
      await tx
        .update(schedules)
        .set({
          definition: {
            title: definition.title,
            request: definition.task.request,
            sourceSessionId: definition.task.sourceSessionId,
            sourcePolicy: (priorSchedule.definition as { sourcePolicy?: unknown }).sourcePolicy,
            requestSource: (priorSchedule.definition as { requestSource?: unknown }).requestSource,
            timezone: definition.timing.timezone,
            timing: {
              kind: 'calendar',
              timing: definition.timing,
              beforeMinutes: definition.task.startBeforeMinutes,
            },
          },
          revision: sql`${schedules.revision} + 1`,
          enabled: !!next,
          nextFireAt: next?.toISOString() ?? null,
        })
        .where(eq(schedules.id, dependent.scheduleId));
    await tx.update(items).set(row).where(eq(items.id, dependent.id));
    await tx
      .update(reminders)
      .set({ status: 'cancelled', pushStatus: 'suppressed' })
      .where(
        and(
          eq(reminders.itemId, dependent.id),
          inArray(reminders.status, ['pending', 'delivered']),
        ),
      );
    if (next) await this.materialize(tx, row, next);
    await tx.insert(changes).values({
      id: randomUUID(),
      tenantId: parent.tenantId,
      userId: parent.userId,
      itemId: dependent.id,
      operationId: randomUUID(),
      input: { cause: 'linked_change', parentId: parent.id, parentRevision: parent.revision },
      snapshot: itemRecord(row),
      createdAt: at.toISOString(),
    });
  }

  private async validateOrigin(
    tx: Tx,
    identity: Identity,
    input: CalendarSave,
    origin: CalendarWriteOrigin,
    prefs: CalendarPreferences,
  ): Promise<void> {
    const [meta] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, origin.source.sessionId))
      .for('share');
    if (
      !meta ||
      meta.closedAt ||
      meta.scope !== 'personal' ||
      meta.userId !== identity.userId ||
      meta.tenantId !== identity.tenantId
    )
      throw new CalendarConflict('CALENDAR_SOURCE_UNAVAILABLE');
    const rows = await tx
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, meta.id))
      .orderBy(sessionEvents.seq);
    const events = rows.map((r) => sessionEventSchema.parse(r.payload));
    const prompt = events.findLast((e) => e.type === 'message/user');
    if (
      prompt?.type !== 'message/user' ||
      prompt.eventId !== origin.source.eventId ||
      prompt.trigger ||
      removedPromptIds(events).has(prompt.eventId)
    )
      throw new CalendarConflict('CALENDAR_SOURCE_UNAVAILABLE');
    const direct = prompt.content
      .filter((b) => b.kind === 'text')
      .map((b) => b.text)
      .join('\n')
      .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`]*`/g, '')
      .split('\n')
      .filter((line) => !/^\s*>/.test(line))
      .join('\n');
    if (!direct.includes(origin.source.quote))
      throw new CalendarConflict('CALENDAR_SOURCE_QUOTE_INVALID');
    const call = events
      .slice(events.indexOf(prompt) + 1)
      .findLast((e) => e.type === 'tool/call' && e.callId === origin.callId);
    const parsed =
      call?.type === 'tool/call' && call.name === 'calendar'
        ? calendarToolParametersSchema.safeParse(call.args)
        : null;
    if (!parsed?.success || parsed.data.operation !== 'save')
      throw new CalendarConflict('CALENDAR_CALL_UNAVAILABLE');
    const args = parsed.data;
    if (
      (args.id !== undefined && args.id !== input.id) ||
      args.expectedRevision !== input.expectedRevision ||
      args.status !== input.status ||
      args.sourceQuote !== origin.source.quote ||
      args.capture !== origin.source.capture ||
      JSON.stringify(args.definition) !== JSON.stringify(input.definition)
    )
      throw new CalendarConflict('CALENDAR_CALL_MISMATCH');
    if (origin.source.capture === 'suggestion' && input.status !== 'suggested')
      throw new CalendarConflict('CALENDAR_CAPTURE_NOT_AUTHORIZED');
    if (
      origin.source.capture === 'automatic' &&
      !prefs.automaticCapture &&
      input.status !== 'suggested'
    )
      throw new CalendarConflict('CALENDAR_AUTOMATIC_CAPTURE_DISABLED');
    if (input.definition.task && input.status === 'active' && origin.source.capture !== 'explicit')
      throw new CalendarConflict('CALENDAR_EXECUTION_NOT_AUTHORIZED');
  }

  async preferences(identity: Identity, raw: CalendarPreferences): Promise<CalendarPreferences> {
    const input = calendarPreferencesSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${identity.userId}, 2395))`,
      );
      await assertOwner(tx, identity);
      const current = await lockedPreferences(tx, identity);
      if (current.revision !== input.revision)
        throw new CalendarConflict('CALENDAR_PREFERENCES_CONFLICT');
      if (input.pushEnabled && !this.push) throw new CalendarConflict('CALENDAR_PUSH_UNAVAILABLE');
      const saved = { ...input, revision: input.revision + 1 };
      await tx
        .insert(preferences)
        .values({
          tenantId: identity.tenantId,
          userId: identity.userId,
          revision: saved.revision,
          preferences: saved,
        })
        .onConflictDoUpdate({
          target: [preferences.tenantId, preferences.userId],
          set: { revision: saved.revision, preferences: saved },
        });
      return saved;
    });
  }

  async reminderAction(
    identity: Identity,
    id: string,
    action: CalendarReminderAction,
    at: Date,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${identity.userId}, 2395))`,
      );
      await assertOwner(tx, identity);
      const [reminder] = await tx
        .select()
        .from(reminders)
        .where(
          and(
            eq(reminders.id, id),
            eq(reminders.tenantId, identity.tenantId),
            eq(reminders.userId, identity.userId),
          ),
        )
        .for('update');
      if (reminder && action.action === 'read' && reminder.status !== 'pending') {
        await tx
          .update(reminders)
          .set({ readAt: at.toISOString(), pushStatus: 'suppressed' })
          .where(eq(reminders.id, id));
        return;
      }
      if (!reminder || !['delivered', 'dismissed'].includes(reminder.status))
        throw new CalendarConflict('CALENDAR_REMINDER_UNAVAILABLE');
      const [item] = await tx.select().from(items).where(eq(items.id, reminder.itemId));
      if (!item || item.revision !== reminder.revision || item.status !== 'active')
        throw new CalendarConflict('CALENDAR_REMINDER_UNAVAILABLE');
      if (
        action.action === 'snooze' &&
        (!action.minutes ||
          reminderExpiry(item, reminder.eventAt) < at.getTime() + action.minutes * 60000)
      )
        throw new CalendarConflict('CALENDAR_SNOOZE_EXPIRED');
      await tx
        .update(reminders)
        .set(
          action.action === 'snooze'
            ? {
                status: 'pending',
                dueAt: new Date(at.getTime() + action.minutes! * 60000).toISOString(),
                readAt: null,
                deliveredAt: null,
                pushStatus: 'pending',
                pushAfter: null,
                pushAttempts: 0,
              }
            : {
                readAt: at.toISOString(),
                ...(action.action === 'dismiss'
                  ? { status: 'dismissed', pushStatus: 'suppressed' }
                  : {}),
              },
        )
        .where(eq(reminders.id, id));
    });
  }

  async subscribe(identity: Identity, raw: CalendarPushSubscription | null): Promise<void> {
    const subscription = raw ? calendarPushSubscriptionSchema.parse(raw) : null;
    if (subscription && !this.push) throw new CalendarConflict('CALENDAR_PUSH_UNAVAILABLE');
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${identity.userId}, 2395))`,
      );
      await assertOwner(tx, identity);
      const prefs = await lockedPreferences(tx, identity);
      const saved = subscription
        ? prefs
        : { ...prefs, pushEnabled: false, revision: prefs.revision + 1 };
      await tx
        .insert(preferences)
        .values({
          tenantId: identity.tenantId,
          userId: identity.userId,
          revision: saved.revision,
          preferences: saved,
          subscription,
        })
        .onConflictDoUpdate({
          target: [preferences.tenantId, preferences.userId],
          set: { subscription, revision: saved.revision, preferences: saved },
        });
    });
  }

  private async materialize(tx: Tx, item: ItemRow, eventAt: Date): Promise<void> {
    const definition = calendarRecordSchema.shape.definition.parse(item.definition);
    for (const offset of new Set(definition.reminderMinutes))
      await tx
        .insert(reminders)
        .values({
          id: randomUUID(),
          itemId: item.id,
          revision: item.revision,
          tenantId: item.tenantId,
          userId: item.userId,
          title: definition.title,
          eventAt: eventAt.toISOString(),
          dueAt: new Date(eventAt.getTime() - offset * 60000).toISOString(),
          offset,
          status: 'pending',
          pushStatus: 'pending',
        })
        .onConflictDoNothing();
  }

  async tick(at: Date, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(items)
        .where(
          and(
            eq(items.status, 'active'),
            sql`(${items.nextAt} <= ${at.toISOString()} or ${items.reminderDueAt} <= ${at.toISOString()})`,
          ),
        )
        .orderBy(items.nextAt)
        .limit(50)
        .for('update', { skipLocked: true });
      for (const item of due) {
        signal?.throwIfAborted();
        const definition = calendarRecordSchema.shape.definition.parse(item.definition);
        const next = nextCalendarDefinitionInstant(definition, at);
        const lead = Math.max(0, ...definition.reminderMinutes) * 60000;
        const horizon = at.getTime() + lead;
        let cursor = item.reminderNextAt ? new Date(item.reminderNextAt) : null;
        if (cursor && cursor.getTime() < at.getTime() - 900000)
          cursor = nextCalendarDefinitionInstant(definition, new Date(at.getTime() - 900000));
        for (let n = 0; cursor && cursor.getTime() <= horizon && n < 64; n++) {
          signal?.throwIfAborted();
          await this.materialize(tx, item, cursor);
          cursor = nextCalendarDefinitionInstant(definition, cursor);
        }
        // With no lead-time, reserve the next occurrence before its event time.
        if (next && (!cursor || next < cursor)) await this.materialize(tx, item, next);
        await tx
          .update(items)
          .set({
            nextAt: next?.toISOString() ?? null,
            reminderNextAt: cursor?.toISOString() ?? null,
            reminderDueAt: cursor ? new Date(cursor.getTime() - lead).toISOString() : null,
          })
          .where(eq(items.id, item.id));
      }
    });
    await this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(reminders)
        .where(and(eq(reminders.status, 'pending'), sql`${reminders.dueAt} <= ${at.toISOString()}`))
        .orderBy(reminders.dueAt)
        .limit(100)
        .for('update', { skipLocked: true });
      for (const reminder of due) {
        signal?.throwIfAborted();
        const [item] = await tx.select().from(items).where(eq(items.id, reminder.itemId));
        const [user] = await tx
          .select()
          .from(users)
          .where(and(eq(users.id, reminder.userId), eq(users.tenantId, reminder.tenantId)));
        const cancelled =
          !item ||
          item.revision !== reminder.revision ||
          item.status !== 'active' ||
          !user ||
          user.role === 'viewer';
        const expired = item && at.getTime() > reminderExpiry(item, reminder.eventAt);
        await tx
          .update(reminders)
          .set({
            status: cancelled ? 'cancelled' : expired ? 'missed' : 'delivered',
            deliveredAt: cancelled || expired ? null : at.toISOString(),
            pushStatus: cancelled || expired ? 'suppressed' : this.push ? 'pending' : 'unavailable',
          })
          .where(eq(reminders.id, reminder.id));
      }
    });
    if (this.push) await this.deliverPush(at, signal);
  }

  private async deliverPush(at: Date, signal?: AbortSignal): Promise<void> {
    // Hold the reminder lock across bounded provider dispatch: competing ticks cannot send concurrently.
    await this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(reminders)
        .where(
          and(
            eq(reminders.status, 'delivered'),
            eq(reminders.pushStatus, 'pending'),
            sql`(${reminders.pushAfter} is null or ${reminders.pushAfter} <= ${at.toISOString()})`,
          ),
        )
        .orderBy(reminders.dueAt)
        .limit(3)
        .for('update', { skipLocked: true });
      for (const reminder of due) {
        signal?.throwIfAborted();
        const identity: Identity = {
          tenantId: reminder.tenantId,
          userId: reminder.userId,
          role: 'member',
        };
        const [item] = await tx.select().from(items).where(eq(items.id, reminder.itemId));
        const [user] = await tx
          .select()
          .from(users)
          .where(and(eq(users.id, identity.userId), eq(users.tenantId, identity.tenantId)))
          .for('share');
        const [config] = await tx
          .select()
          .from(preferences)
          .where(preferenceOwner(identity))
          .for('share');
        const prefs = config
          ? calendarPreferencesSchema.parse(config.preferences)
          : defaultCalendarPreferences;
        if (
          !item ||
          item.revision !== reminder.revision ||
          item.status !== 'active' ||
          !user ||
          user.role === 'viewer' ||
          !prefs.pushEnabled ||
          !config?.subscription ||
          reminder.readAt ||
          reminderExpiry(item, reminder.eventAt) < at.getTime()
        ) {
          await tx
            .update(reminders)
            .set({ pushStatus: 'suppressed' })
            .where(eq(reminders.id, reminder.id));
          continue;
        }
        const local = calendarLocalParts(at, prefs.timezone);
        const quiet = prefs.quietHours;
        if (
          quiet &&
          quiet.startHour !== quiet.endHour &&
          (quiet.startHour < quiet.endHour
            ? local.hour >= quiet.startHour && local.hour < quiet.endHour
            : local.hour >= quiet.startHour || local.hour < quiet.endHour)
        ) {
          let date = local.date;
          if (quiet.startHour > quiet.endHour && local.hour >= quiet.startHour)
            date = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
          const resume = calendarLocalInstant(date, quiet.endHour, 0, prefs.timezone);
          await tx
            .update(reminders)
            .set({
              pushAfter: resume?.toISOString() ?? new Date(at.getTime() + 3600000).toISOString(),
            })
            .where(eq(reminders.id, reminder.id));
          continue;
        }
        const result = await this.push!.send(
          calendarPushSubscriptionSchema.parse(config.subscription),
          reminder.id,
          signal,
        );
        const attempts = reminder.pushAttempts + 1;
        await tx
          .update(reminders)
          .set({
            pushAttempts: attempts,
            pushStatus:
              result === 'sent'
                ? 'sent'
                : result === 'expired'
                  ? 'unavailable'
                  : attempts >= 3
                    ? 'failed'
                    : 'pending',
            pushAfter: new Date(at.getTime() + attempts * 60000).toISOString(),
          })
          .where(eq(reminders.id, reminder.id));
        if (result === 'expired')
          await tx.update(preferences).set({ subscription: null }).where(preferenceOwner(identity));
      }
    });
  }
}
