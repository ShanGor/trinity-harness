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
