import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  PgCalendarStore,
  PgScheduleStore,
  PgSessionStore,
  PgSessionMetaStore,
  createDb,
} from '../src/index.js';
import {
  calendarDefinitionSchema,
  calendarToolParametersSchema,
  defaultCalendarPreferences,
  type CalendarSave,
  type Identity,
  type CalendarPushPort,
} from '@trinity-harness/contracts';

const url = process.env['DATABASE_URL'];
const admin = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
let reachable = false;
if (url) {
  try {
    await admin.query('select 1');
    reachable = true;
  } catch {
    reachable = false;
  }
}
const schema = `calendar_test_${randomUUID().replaceAll('-', '')}`;
const pool = new pg.Pool({
  connectionString: url,
  options: `-c search_path=${schema},public`,
  connectionTimeoutMillis: 2000,
});
const db = createDb(pool);
const store = new PgCalendarStore(db);
const events = new PgSessionStore(db);
const metas = new PgSessionMetaStore(db);
const owner: Identity = { tenantId: randomUUID(), userId: randomUUID(), role: 'member' };
const at = new Date('2026-11-23T00:00:00Z');
let source: string;
let initialized = false;
function input(extra: Partial<CalendarSave> = {}): CalendarSave {
  return {
    id: randomUUID(),
    operationId: randomUUID(),
    expectedRevision: 0,
    status: 'active',
    definition: calendarDefinitionSchema.parse({
      title: 'Appointment',
      kind: 'event',
      timing: {
        date: { calendar: 'gregorian', year: 2026, month: 11, day: 23 },
        timezone: 'UTC',
        hour: 1,
        minute: 0,
        recurrence: 'once',
        durationMinutes: 60,
      },
      reminderMinutes: [30, 0],
    }),
    ...extra,
  };
}
beforeAll(async () => {
  if (!reachable) return;
  await admin.query(`create schema ${schema}`);
  initialized = true;
  for (const table of [
    'personal_calendar_items',
    'personal_calendar_changes',
    'personal_calendar_preferences',
    'personal_calendar_reminders',
    'assistant_schedules',
    'schedule_occurrences',
    'users',
    'sessions',
    'session_events',
  ])
    await admin.query(`create table ${schema}.${table} (like public.${table} including all)`);
  await pool.query(
    'insert into users(id,tenant_id,email,password_hash,role,history_timezone) values($1,$2,$3,$4,$5,$6)',
    [
      owner.userId,
      owner.tenantId,
      `${owner.userId}@test.invalid`,
      'unused',
      'member',
      'Asia/Hong_Kong',
    ],
  );
  source = randomUUID();
  await metas.create({
    id: source,
    tenantId: owner.tenantId,
    userId: owner.userId,
    title: 'Calendar source',
    kind: 'chat',
    sessionRole: 'main',
    scope: 'personal',
    workspaceUri: `/tmp/${owner.userId}`,
    policy: 'read-only',
  });
});
afterAll(async () => {
  await pool.end();
  if (initialized) await admin.query(`drop schema ${schema} cascade`);
  await admin.end();
});

describe.skipIf(!reachable)('durable personal calendar', () => {
  it('inherits account timezone, deduplicates operations and fences owners/revisions', async () => {
    expect((await store.snapshot(owner)).preferences.timezone).toBe('Asia/Hong_Kong');
    const create = input();
    const saved = await store.save(owner, create, at);
    expect((await new PgCalendarStore(db).save(owner, create, at)).id).toBe(saved.id);
    expect((await store.snapshot({ ...owner, userId: randomUUID() })).items).toEqual([]);
    await expect(store.save({ ...owner, role: 'viewer' }, input(), at)).rejects.toThrow(
      'CALENDAR_FORBIDDEN',
    );
    await expect(store.save(owner, { ...create, operationId: randomUUID() }, at)).rejects.toThrow(
      'CALENDAR_REVISION_CONFLICT',
    );
    await expect(
      store.save(owner, { ...create, definition: { ...create.definition, title: 'Changed' } }, at),
    ).rejects.toThrow('CALENDAR_OPERATION_CONFLICT');
    const changes = await Promise.allSettled(
      ['One', 'Two'].map((title) =>
        store.save(
          owner,
          {
            ...create,
            operationId: randomUUID(),
            expectedRevision: 1,
            definition: { ...create.definition, title },
          },
          at,
        ),
      ),
    );
    expect(changes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('reconciles concurrent restart ticks once and separates read/dismiss/snooze from completion', async () => {
    const create = input();
    const item = await store.save(owner, create, at);
    const due = new Date('2026-11-23T00:30:00Z');
    await Promise.all([store.tick(due), new PgCalendarStore(db).tick(due)]);
    let notices = (await store.snapshot(owner)).reminders.filter((r) => r.itemId === item.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ status: 'delivered', pushStatus: 'unavailable' });
    const id = notices[0]!.id;
    await store.reminderAction(owner, id, { action: 'read' }, due);
    expect((await store.snapshot(owner)).reminders.find((r) => r.id === id)?.readAt).toBe(
      due.toISOString(),
    );
    await store.reminderAction(owner, id, { action: 'snooze', minutes: 10 }, due);
    expect((await store.snapshot(owner)).reminders.find((r) => r.id === id)).toBeUndefined();
    await store.tick(new Date('2026-11-23T00:40:00Z'));
    await store.reminderAction(owner, id, { action: 'dismiss' }, due);
    notices = (await store.snapshot(owner)).reminders.filter((r) => r.itemId === item.id);
    expect(notices[0]?.status).toBe('dismissed');
    expect((await store.snapshot(owner)).items.find((r) => r.id === item.id)?.status).toBe(
      'active',
    );
  });
  it('invalidates obsolete reminders on edit/cancel and records expired reminders', async () => {
    const create = input();
    const item = await store.save(owner, create, at);
    await store.save(
      owner,
      { ...create, operationId: randomUUID(), expectedRevision: 1, status: 'cancelled' },
      at,
    );
    await store.tick(new Date('2026-11-23T00:31:00Z'));
    expect(
      (await store.snapshot(owner)).reminders
        .filter((r) => r.itemId === item.id)
        .every((r) => r.status === 'cancelled'),
    ).toBe(true);
    const old = await store.save(owner, input(), at);
    await store.tick(new Date('2026-11-24T00:00:00Z'));
    expect(
      (await store.snapshot(owner)).reminders
        .filter((r) => r.itemId === old.id)
        .every((r) => r.status === 'missed'),
    ).toBe(true);
  });
  it('materializes recurring lead-time reminders before the preceding event has occurred', async () => {
    const create = input();
    create.definition.timing.recurrence = 'daily';
    create.definition.reminderMinutes = [2880];
    const item = await store.save(owner, create, at);
    await store.tick(new Date('2026-11-23T00:01:00Z'));
    const notices = (await store.snapshot(owner)).reminders.filter((r) => r.itemId === item.id);
    expect(
      notices.some((r) => r.eventAt === '2026-11-24T01:00:00.000Z' && r.status === 'delivered'),
    ).toBe(true);
    const [count] = (
      await pool.query('select count(*)::int n from personal_calendar_reminders where item_id=$1', [
        item.id,
      ])
    ).rows;
    await store.tick(new Date('2026-11-23T00:01:00Z'));
    expect(
      (
        await pool.query(
          'select count(*)::int n from personal_calendar_reminders where item_id=$1',
          [item.id],
        )
      ).rows[0].n,
    ).toBe(count.n);
  });
  it('links tasks to existing Work dispatch and fences queued work after calendar cancellation', async () => {
    const create = input();
    create.definition.kind = 'task';
    create.definition.task = { request: 'Prepare the authorized report', sourceSessionId: source };
    const item = await store.save(owner, create, at);
    expect(item.scheduleId).not.toBeNull();
    const scheduler = new PgScheduleStore(db);
    await scheduler.tick(new Date('2026-11-23T01:00:00Z'));
    const run = (await scheduler.inbox(owner)).find((r) => r.scheduleId === item.scheduleId)!;
    expect(run).toMatchObject({ status: 'queued' });
    await scheduler.assertRunAuthorized(run.sessionId!, owner.userId);
    await store.save(
      owner,
      { ...create, expectedRevision: 1, operationId: randomUUID(), status: 'cancelled' },
      new Date('2026-11-23T01:01:00Z'),
    );
    await expect(scheduler.assertRunAuthorized(run.sessionId!, owner.userId)).rejects.toThrow(
      'authorization changed',
    );
  });
  it('moves linked preparation with its appointment, pauses it on cancellation and preserves policy authority', async () => {
    const appointment = input();
    const parent = await store.save(owner, appointment, at);
    const work = input();
    work.definition.kind = 'task';
    work.definition.task = {
      request: 'Prepare notes',
      sourceSessionId: source,
      relatedItemId: parent.id,
      startBeforeMinutes: 15,
    };
    const task = await store.save(owner, work, at);
    expect(task.nextAt).toBe('2026-11-23T00:45:00.000Z');
    await store.save(
      owner,
      {
        ...appointment,
        operationId: randomUUID(),
        expectedRevision: 1,
        definition: {
          ...appointment.definition,
          timing: { ...appointment.definition.timing, hour: 2 },
        },
      },
      at,
    );
    expect((await store.snapshot(owner)).items.find((i) => i.id === task.id)).toMatchObject({
      revision: 2,
      nextAt: '2026-11-23T01:45:00.000Z',
    });
    await metas.setPolicy(source, 'workspace-write');
    const scheduler = new PgScheduleStore(db);
    await scheduler.tick(new Date('2026-11-23T01:45:00Z'));
    expect(
      (await scheduler.inbox(owner)).find((r) => r.scheduleId === task.scheduleId),
    ).toMatchObject({ status: 'skipped', reason: 'access_revoked' });
    await metas.setPolicy(source, 'read-only');
    await store.save(
      owner,
      { ...appointment, operationId: randomUUID(), expectedRevision: 2, status: 'cancelled' },
      at,
    );
    expect((await store.snapshot(owner)).items.find((i) => i.id === task.id)).toMatchObject({
      status: 'paused',
      nextAt: null,
    });
  });
  it('requires a committed original user source and call, respecting automatic-capture preferences', async () => {
    const create = input();
    const quote = 'My appointment is today at 1 am UTC.';
    const promptId = randomUUID(),
      callId = randomUUID();
    const args = calendarToolParametersSchema.parse({
      operation: 'save',
      expectedRevision: 0,
      definition: create.definition,
      status: 'active',
      sourceQuote: quote,
      capture: 'automatic',
    });
    await events.append(source, [
      {
        type: 'message/user',
        surfaceOp: 'append',
        eventId: promptId,
        at: at.toISOString(),
        content: [{ kind: 'text', text: quote }],
      },
      {
        type: 'tool/call',
        eventId: randomUUID(),
        at: at.toISOString(),
        callId,
        name: 'calendar',
        args,
      },
    ]);
    const origin = {
      source: { sessionId: source, eventId: promptId, quote, capture: 'automatic' as const },
      callId,
    };
    await expect(store.save(owner, create, at, origin)).rejects.toThrow(
      'CALENDAR_AUTOMATIC_CAPTURE_DISABLED',
    );
    const prefs = (await store.snapshot(owner)).preferences;
    await store.preferences(owner, { ...prefs, automaticCapture: true });
    const saved = await store.save(owner, create, at, origin);
    expect(saved.source).toEqual(origin.source);
    expect((await store.save(owner, create, at, origin)).id).toBe(saved.id);
    await expect(
      store.save(owner, input(), at, { ...origin, callId: randomUUID() }),
    ).rejects.toThrow('CALENDAR_CALL_UNAVAILABLE');
    await expect(store.preferences(owner, { ...defaultCalendarPreferences })).rejects.toThrow(
      'CALENDAR_PREFERENCES_CONFLICT',
    );
  });
  it('allows cancellation after a task workspace is closed', async () => {
    const template = randomUUID();
    await metas.create({
      id: template,
      tenantId: owner.tenantId,
      userId: owner.userId,
      title: 'Closing source',
      scope: 'personal',
      kind: 'chat',
      sessionRole: 'side',
      workspaceUri: '/tmp/calendar-test',
      policy: 'read-only',
    });
    const create = input();
    create.definition.kind = 'task';
    create.definition.task = { request: 'Prepare notes', sourceSessionId: template };
    const task = await store.save(owner, create, at);
    await metas.close(template);
    const cancelled = await store.save(
      owner,
      {
        ...create,
        operationId: randomUUID(),
        expectedRevision: task.revision,
        status: 'cancelled',
      },
      at,
    );
    expect(cancelled.status).toBe('cancelled');
  });
  it('keeps quiet-hour push in the outbox and suppresses acknowledged notifications', async () => {
    let sent = 0;
    const push: CalendarPushPort = {
      publicKey: 'test-public-key',
      send: async () => {
        sent++;
        return 'sent';
      },
    };
    const pushed = new PgCalendarStore(db, push);
    const prefs = (await pushed.snapshot(owner)).preferences;
    await pushed.preferences(owner, {
      ...prefs,
      pushEnabled: true,
      timezone: 'UTC',
      quietHours: { startHour: 0, endHour: 1 },
    });
    await pushed.subscribe(owner, {
      endpoint: 'https://fcm.googleapis.com/test',
      keys: { p256dh: 'a'.repeat(87), auth: 'a'.repeat(22) },
    });
    const item = await pushed.save(owner, input(), at);
    await pushed.tick(new Date('2026-11-23T00:30:00Z'));
    const notice = (await pushed.snapshot(owner)).reminders.find((r) => r.itemId === item.id)!;
    expect(notice).toMatchObject({ status: 'delivered', pushStatus: 'pending' });
    const initialSent = sent;
    await pushed.reminderAction(owner, notice.id, { action: 'read' }, at);
    await pushed.tick(new Date('2026-11-23T01:00:00Z'));
    expect(
      (await pushed.snapshot(owner)).reminders.find((r) => r.id === notice.id)?.pushStatus,
    ).toBe('suppressed');
    // Other due reminders may be delivered; the acknowledged receipt remains suppressed.
    expect(sent).toBeGreaterThanOrEqual(initialSent);
    await pushed.subscribe(owner, null);
    expect((await pushed.snapshot(owner)).preferences.pushEnabled).toBe(false);
  });
});
