import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  PgScheduleStore,
  PgSessionMetaStore,
  PgSessionStore,
  PgEnvironmentStore,
} from '../src/index.js';
import {
  parsePermissionPolicy,
  type Identity,
  type ScheduleCreate,
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
const schema = `runtime_test_${randomUUID().replaceAll('-', '')}`;
const pool = new pg.Pool({
  connectionString: url,
  options: `-c search_path=${schema},public`,
  connectionTimeoutMillis: 2000,
});
const db = createDb(pool);
const schedules = new PgScheduleStore(db);
const metas = new PgSessionMetaStore(db);
const events = new PgSessionStore(db);
const owner: Identity = { tenantId: randomUUID(), userId: randomUUID(), role: 'developer' };
const at = new Date('2026-10-24T00:00:00Z');
let source: string;
let initialized = false;
beforeAll(async () => {
  if (!reachable) return;
  // Isolated tables: no notifications reach running development workers.
  await admin.query(`create schema ${schema}`);
  initialized = true;
  for (const table of [
    'assistant_schedules',
    'schedule_occurrences',
    'assistant_environments',
    'environment_events',
    'users',
    'sessions',
    'session_events',
    'conversation_episodes',
  ])
    await admin.query(`create table ${schema}.${table} (like public.${table} including all)`);
  await admin.query(
    `create table ${schema}.firecracker_node_maintenance (node_id text primary key, state text not null, updated_at timestamptz not null default now())`,
  );
  await pool.query(
    'create trigger environment_events_append_only before update or delete on environment_events for each row execute function public.reject_environment_event_mutation()',
  );
  await pool.query(
    'insert into users(id,tenant_id,email,password_hash,role) values($1,$2,$3,$4,$5)',
    [owner.userId, owner.tenantId, `${owner.userId}@test.invalid`, 'unused', 'developer'],
  );
  source = randomUUID();
  await metas.create({
    id: source,
    tenantId: owner.tenantId,
    userId: owner.userId,
    title: 'Template',
    kind: 'work',
    sessionRole: 'task',
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
function definition(): ScheduleCreate {
  return {
    operationId: randomUUID(),
    title: 'Report',
    request: 'Summarize the authorized workspace',
    sourceSessionId: source,
    timezone: 'UTC',
    timing: { kind: 'once', at: '2026-10-24T00:01:00Z' },
  };
}

describe.skipIf(!reachable)('durable runtime control', () => {
  it('commits a dated nightly review once and excludes derived digests from recall indexing', async () => {
    const input = { ...definition(), consolidation: 'review' as const, timezone: 'Asia/Hong_Kong' };
    const schedule = await schedules.create(owner, input, at);
    await Promise.all([
      schedules.tick(new Date('2026-10-24T00:01:00Z')),
      schedules.tick(new Date('2026-10-24T00:01:00Z')),
    ]);
    const notices = (await schedules.inbox(owner)).filter(
      (item) => item.scheduleId === schedule.id,
    );
    expect(notices).toHaveLength(1);
    const sessionId = notices[0]!.sessionId!;
    const queued = (await events.load(sessionId)).find((event) => event.type === 'prompt/queued');
    if (queued?.type !== 'prompt/queued') throw new Error('missing prompt');
    expect(queued.trigger?.consolidation).toBe('review');
    expect(JSON.stringify(queued.content)).toContain('Review date: 2026-10-23');
    await events.append(sessionId, [
      {
        type: 'message/user',
        surfaceOp: 'append',
        eventId: queued.promptId,
        at: queued.at,
        content: queued.content,
        trigger: queued.trigger,
      },
      {
        type: 'message/assistant',
        eventId: randomUUID(),
        at: queued.at,
        phase: 'final',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'Derived digest' }],
      },
      {
        type: 'turn/end',
        eventId: randomUUID(),
        at: queued.at,
        promptId: queued.promptId,
        reason: 'completed',
      },
    ]);
    expect(
      (await pool.query('select * from conversation_episodes where session_id=$1', [sessionId]))
        .rows,
    ).toHaveLength(0);
  });
  it('atomically creates one queued run, preserves trigger provenance and recovers its outcome after restart', async () => {
    const input = definition();
    const schedule = await schedules.create(owner, input, at);
    expect((await schedules.create(owner, input, at)).id).toBe(schedule.id);
    await Promise.all([
      schedules.tick(new Date('2026-10-24T00:01:00Z')),
      new PgScheduleStore(db).tick(new Date('2026-10-24T00:01:00Z')),
    ]);
    const notices = (await schedules.inbox(owner)).filter(
      (item) => item.scheduleId === schedule.id,
    );
    expect(notices).toHaveLength(1);
    const runId = notices[0]!.sessionId!;
    const queued = (await events.load(runId)).find((event) => event.type === 'prompt/queued');
    expect(queued).toMatchObject({
      trigger: { scheduleId: schedule.id },
      actor: owner.userId,
      policy: parsePermissionPolicy('read-only'),
    });
    if (queued?.type !== 'prompt/queued') throw new Error('missing durable prompt');
    await schedules.assertRunAuthorized(runId, owner.userId);
    await events.append(runId, [
      {
        type: 'turn/end',
        eventId: randomUUID(),
        at: at.toISOString(),
        promptId: queued.promptId,
        reason: 'completed',
      },
    ]);
    const restarted = new PgScheduleStore(db);
    await restarted.tick(new Date('2026-10-24T00:02:00Z'));
    expect((await restarted.inbox(owner)).find((item) => item.id === notices[0]!.id)?.status).toBe(
      'completed',
    );
    expect(await restarted.inbox({ ...owner, userId: randomUUID() })).toEqual([]);
    await restarted.acknowledge(owner, notices[0]!.id, at);
    expect((await restarted.inbox(owner)).find((item) => item.id === notices[0]!.id)?.readAt).toBe(
      at.toISOString(),
    );
    await metas.setPolicy(source, 'workspace-write');
    await expect(schedules.assertRunAuthorized(runId, owner.userId)).rejects.toThrow(
      'authorization changed',
    );
    await metas.setPolicy(source, 'read-only');
  });
  it('records missed occurrences without enqueuing a backlog and rejects another owner', async () => {
    const schedule = await schedules.create(owner, definition(), at);
    await schedules.tick(new Date('2026-10-24T02:00:00Z'));
    expect(
      (await schedules.inbox(owner)).find((item) => item.scheduleId === schedule.id),
    ).toMatchObject({ status: 'skipped', reason: 'missed', sessionId: null });
    await expect(
      schedules.create({ ...owner, userId: randomUUID() }, definition(), at),
    ).rejects.toThrow();
    expect(
      await schedules.setEnabled({ ...owner, userId: randomUUID() }, schedule.id, 1, false, at),
    ).toBeNull();
  });
  it('skips overlapping daily occurrences while a previous run awaits completion', async () => {
    const input: ScheduleCreate = {
      ...definition(),
      timing: { kind: 'daily', hour: 0, minute: 1, weekdays: [0, 1, 2, 3, 4, 5, 6] },
    };
    const schedule = await schedules.create(owner, input, at);
    await schedules.tick(new Date('2026-10-24T00:01:00Z'));
    await new PgScheduleStore(db).tick(new Date('2026-10-25T00:01:00Z'));
    const items = (await schedules.inbox(owner)).filter((item) => item.scheduleId === schedule.id);
    expect(items.map((item) => [item.status, item.reason])).toEqual([
      ['skipped', 'overlap'],
      ['queued', 'due'],
    ]);
  });

  function nightly(): ScheduleCreate {
    return {
      ...definition(),
      consolidation: 'review',
      timing: { kind: 'daily', hour: 0, minute: 1, weekdays: [0, 1, 2, 3, 4, 5, 6] },
    };
  }
  async function finishReview(
    scheduleId: string,
    reason: 'completed' | 'error' | 'aborted',
    at: string,
  ): Promise<string> {
    const [row] = (
      await pool.query('select * from schedule_occurrences where schedule_id=$1 and status=$2', [
        scheduleId,
        'queued',
      ])
    ).rows;
    if (!row) throw new Error('missing queued review');
    await events.append(row.session_id, [
      { type: 'turn/end', eventId: randomUUID(), at, promptId: row.prompt_id, reason },
    ]);
    return row.session_id;
  }
  it('catches up oldest-first after downtime without duplicating queued or completed days', async () => {
    const schedule = await schedules.create(owner, nightly(), at);
    const now = new Date('2026-10-26T04:00:00Z');
    await Promise.all([schedules.tick(now), new PgScheduleStore(db).tick(now)]);
    let items = (await schedules.inbox(owner)).filter((item) => item.scheduleId === schedule.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      status: 'queued',
      at: '2026-10-24T00:01:00.000Z',
      attempts: 1,
    });
    await new PgScheduleStore(db).tick(now);
    expect(
      (await schedules.inbox(owner)).filter((item) => item.scheduleId === schedule.id),
    ).toHaveLength(1);
    await finishReview(schedule.id, 'completed', now.toISOString());
    await schedules.tick(now); // advance past the completed day
    await schedules.tick(now);
    items = (await schedules.inbox(owner)).filter((item) => item.scheduleId === schedule.id);
    expect(items.map((item) => [item.status, item.at])).toEqual([
      ['queued', '2026-10-25T00:01:00.000Z'],
      ['completed', '2026-10-24T00:01:00.000Z'],
    ]);
    const queued = (await events.load(items[0]!.sessionId!)).find(
      (event) => event.type === 'prompt/queued',
    );
    expect(JSON.stringify(queued)).toContain('Review date: 2026-10-24');
  });
  it('bounds long-outage catch-up to seven local review days and records an expired gap', async () => {
    const schedule = await schedules.create(owner, nightly(), new Date('2026-10-01T00:00:00Z'));
    const now = new Date('2026-10-24T04:00:00Z');
    await schedules.tick(now);
    await schedules.tick(now);
    const items = (await schedules.inbox(owner)).filter((item) => item.scheduleId === schedule.id);
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.status === 'queued')?.at).toBe('2026-10-18T00:01:00.000Z');
    expect(items.find((item) => item.reason === 'expired')).toMatchObject({
      status: 'skipped',
      sessionId: null,
    });
  });
  it('recovers legacy skipped/missing dates once without replaying completed reviews', async () => {
    const schedule = await schedules.create(owner, nightly(), at);
    // Simulate the old scheduler advancing over an outage before this upgrade.
    await pool.query(
      'update assistant_schedules set review_catchup_initialized=false,next_fire_at=$2 where id=$1',
      [schedule.id, '2026-10-27T00:01:00Z'],
    );
    await pool.query(
      `insert into schedule_occurrences(id,schedule_id,revision,tenant_id,user_id,scheduled_at,title,status,reason) values($1,$2,1,$3,$4,$5,'Report','skipped','missed')`,
      [randomUUID(), schedule.id, owner.tenantId, owner.userId, '2026-10-24T00:01:00Z'],
    );
    const now = new Date('2026-10-26T04:00:00Z');
    await schedules.tick(now);
    const item = (await schedules.inbox(owner)).find((item) => item.scheduleId === schedule.id)!;
    expect(item).toMatchObject({ status: 'queued', at: '2026-10-24T00:01:00.000Z' });
    await finishReview(schedule.id, 'completed', now.toISOString());
    await schedules.tick(now);
    await schedules.tick(now);
    expect(
      (await schedules.inbox(owner)).filter((item) => item.scheduleId === schedule.id),
    ).toHaveLength(2);
  });
  it('persists bounded retry backoff, original dates and authorization for every attempt', async () => {
    const schedule = await schedules.create(owner, nightly(), at);
    await schedules.tick(new Date('2026-10-24T00:01:00Z'));
    const firstSession = await finishReview(schedule.id, 'error', '2026-10-24T00:02:00Z');
    await schedules.tick(new Date('2026-10-24T00:03:00Z'));
    let item = (await schedules.inbox(owner)).find((item) => item.scheduleId === schedule.id)!;
    expect(item).toMatchObject({
      status: 'failed',
      attempts: 1,
      retryAt: '2026-10-24T00:07:00.000Z',
    });
    await Promise.all([
      schedules.tick(new Date('2026-10-24T00:07:00Z')),
      new PgScheduleStore(db).tick(new Date('2026-10-24T00:07:00Z')),
    ]);
    item = (await schedules.inbox(owner)).find((item) => item.scheduleId === schedule.id)!;
    expect(item).toMatchObject({ status: 'queued', attempts: 2, at: '2026-10-24T00:01:00.000Z' });
    expect(item.sessionId).not.toBe(firstSession);
    await schedules.assertRunAuthorized(firstSession, owner.userId);
    await metas.setPolicy(source, 'workspace-write');
    await expect(schedules.assertRunAuthorized(firstSession, owner.userId)).rejects.toThrow(
      'authorization changed',
    );
    await metas.setPolicy(source, 'read-only');
    await finishReview(schedule.id, 'error', '2026-10-24T00:08:00Z');
    await schedules.tick(new Date('2026-10-24T00:17:00Z'));
    expect(
      (await schedules.inbox(owner)).find((item) => item.scheduleId === schedule.id)?.status,
    ).toBe('failed');
    await schedules.tick(new Date('2026-10-24T00:18:00Z'));
    await finishReview(schedule.id, 'error', '2026-10-24T00:19:00Z');
    await schedules.tick(new Date('2026-10-24T00:35:00Z'));
    expect(
      (await schedules.inbox(owner)).find((item) => item.scheduleId === schedule.id),
    ).toMatchObject({ status: 'failed', attempts: 3, retryAt: null });
  });
  it('never retries cancelled reviews or failures with potentially effectful calls', async () => {
    for (const unsafe of [false, true]) {
      const schedule = await schedules.create(owner, nightly(), at);
      const now = new Date('2026-10-24T00:01:00Z');
      await schedules.tick(now);
      const item = (await schedules.inbox(owner)).find((item) => item.scheduleId === schedule.id)!;
      if (unsafe)
        await events.append(item.sessionId!, [
          {
            type: 'tool/call',
            eventId: randomUUID(),
            at: now.toISOString(),
            callId: 'unsafe',
            name: 'write_file',
            args: {},
          },
        ]);
      await finishReview(schedule.id, unsafe ? 'error' : 'aborted', '2026-10-24T00:02:00Z');
      await schedules.tick(new Date('2026-10-24T00:30:00Z'));
      expect(
        (await schedules.inbox(owner)).find((item) => item.scheduleId === schedule.id),
      ).toMatchObject({ status: unsafe ? 'failed' : 'cancelled', attempts: 1, retryAt: null });
    }
  });
  it('does not backfill paused days and refuses catch-up after access revocation', async () => {
    const schedule = await schedules.create(owner, nightly(), at);
    const paused = await schedules.setEnabled(owner, schedule.id, schedule.revision, false, at);
    const resumed = await schedules.setEnabled(
      owner,
      schedule.id,
      paused!.revision,
      true,
      new Date('2026-10-26T04:00:00Z'),
    );
    await schedules.tick(new Date('2026-10-26T04:00:00Z'));
    expect(
      (await schedules.inbox(owner)).filter((item) => item.scheduleId === schedule.id),
    ).toHaveLength(0);
    expect(resumed?.nextFireAt).toBe('2026-10-27T00:01:00.000Z');
    const revoked = await schedules.create(owner, nightly(), at);
    await pool.query('update users set role=$2 where id=$1', [owner.userId, 'viewer']);
    await schedules.tick(new Date('2026-10-26T04:00:00Z'));
    expect(
      (await schedules.inbox({ ...owner, role: 'viewer' })).find(
        (item) => item.scheduleId === revoked.id,
      ),
    ).toMatchObject({ status: 'skipped', reason: 'access_revoked' });
    await pool.query('update users set role=$2 where id=$1', [owner.userId, 'developer']);
  });

  it('does not widen a retry after the source policy changes', async () => {
    const schedule = await schedules.create(owner, nightly(), at);
    await schedules.tick(new Date('2026-10-24T00:01:00Z'));
    await finishReview(schedule.id, 'error', '2026-10-24T00:02:00Z');
    await metas.setPolicy(source, 'workspace-write');
    await schedules.tick(new Date('2026-10-24T00:08:00Z'));
    expect(
      (await schedules.inbox(owner)).find((item) => item.scheduleId === schedule.id),
    ).toMatchObject({ status: 'failed', reason: 'access_revoked', attempts: 1, retryAt: null });
    expect((await schedules.list(owner)).find((item) => item.id === schedule.id)?.enabled).toBe(
      false,
    );
    await metas.setPolicy(source, 'read-only');
  });
  it('reserves capacity once per user, fences old generations and never moves an uncertain VM', async () => {
    const store = new PgEnvironmentStore(db, pool);
    const nodes = [{ id: 'node-1', endpoint: 'https://node.test/', vcpus: 2, memoryMiB: 2304 }];
    const [one, two] = await Promise.all([
      store.reserve(owner, nodes),
      new PgEnvironmentStore(db, pool).reserve(owner, nodes),
    ]);
    expect(one.generation).toBe(two.generation);
    await expect(store.reserve({ ...owner, userId: randomUUID() }, nodes)).rejects.toMatchObject({
      code: 'WAITING_CAPACITY',
    });
    await store.transition(one, 'quarantined');
    expect((await store.reserve(owner, nodes)).state).toBe('quarantined');
    // A delayed healthy status probe cannot overwrite a concurrent quarantine.
    expect((await store.transition(one, 'running', one.state)).state).toBe('quarantined');
    await store.transition(one, 'stopped');
    const next = await store.reserve(owner, nodes);
    expect(next.nodeId).toBe(one.nodeId);
    expect(next.generation).not.toBe(one.generation);
    expect(await store.authorizeNode(one)).toBe(false);
    await expect(store.transition(one, 'running')).rejects.toThrow('generation changed');
    await expect(
      pool.query('update environment_events set type=$1 where environment_id=$2', [
        'tampered',
        one.id,
      ]),
    ).rejects.toThrow('append-only');
  });
  it('blocks node assignments while maintenance is active and allows them after resume', async () => {
    const store = new PgEnvironmentStore(db, pool);
    const maintenanceOwner: Identity = {
      tenantId: randomUUID(),
      userId: randomUUID(),
      role: 'developer',
    };
    const node = {
      id: 'maintenance-node',
      endpoint: 'https://node.test/',
      vcpus: 2,
      memoryMiB: 4096,
    };
    await store.beginNodeDrain(node.id);
    expect(await store.isNodeDraining(node.id)).toBe(true);
    await expect(store.reserve(maintenanceOwner, [node])).rejects.toMatchObject({
      code: 'WAITING_CAPACITY',
    });
    await store.endNodeDrain(node.id);
    expect(await store.isNodeDraining(node.id)).toBe(false);
    await expect(store.reserve(maintenanceOwner, [node])).resolves.toMatchObject({
      nodeId: node.id,
      state: 'starting',
    });
  });
  it('allows stop commands while draining and denies new starts and guest RPCs', async () => {
    const store = new PgEnvironmentStore(db, pool);
    const maintenanceOwner: Identity = {
      tenantId: randomUUID(),
      userId: randomUUID(),
      role: 'developer',
    };
    const node = {
      id: 'drain-auth-node',
      endpoint: 'https://node.test/',
      vcpus: 2,
      memoryMiB: 4096,
    };
    const assigned = await store.reserve(maintenanceOwner, [node]);
    await store.beginNodeDrain(node.id);
    expect(await store.authorizeNode(assigned, 'start')).toBe(false);
    expect(await store.authorizeNode(assigned, 'guest')).toBe(false);
    expect(await store.authorizeNode(assigned, 'stop')).toBe(true);
    await store.transition(assigned, 'stopped');
    await store.endNodeDrain(node.id);
  });
});
