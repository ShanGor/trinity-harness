import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserControlRecordSchema } from '@trinity-harness/contracts';
import { PgBrowserInteractionStore } from '../src/index.js';
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
const schema = `browser_interaction_${randomUUID().replaceAll('-', '')}`;
const pool = new pg.Pool({
  connectionString: url,
  options: `-c search_path=${schema},public`,
  connectionTimeoutMillis: 2000,
});
let initialized = false;
beforeAll(async () => {
  if (!reachable) return;
  await admin.query(`create schema ${schema}`);
  initialized = true;
  for (const table of ['browser_controls', 'browser_user_inputs'])
    await admin.query(`create table ${schema}.${table} (like public.${table} including all)`);
});
afterAll(async () => {
  await pool.end();
  if (initialized) await admin.query(`drop schema ${schema} cascade`);
  await admin.end();
});
describe.skipIf(!reachable)('durable browser control and input journal', () => {
  it('preserves reservations and unknown outcomes across adapter reconstruction without typed input values', async () => {
    const store = new PgBrowserInteractionStore(pool),
      sessionId = randomUUID(),
      sourceSessionId = randomUUID(),
      requestId = randomUUID();
    const record = browserControlRecordSchema.parse({
      sessionId,
      generation: randomUUID(),
      epoch: 2,
      mode: 'quarantined',
      controllerId: randomUUID(),
      expiresAt: '2026-10-26T00:01:00Z',
      sequence: 1,
      frame: null,
    });
    await store.reserve(record, requestId, sourceSessionId);
    const restarted = new PgBrowserInteractionStore(pool);
    expect(await restarted.get(sessionId)).toEqual(record);
    expect(await restarted.input(sessionId, requestId)).toMatchObject({
      effect: 'unknown',
      epoch: 2,
      sequence: 1,
      sourceSessionId,
    });
    await restarted.finish(sessionId, requestId, 'applied');
    expect((await store.input(sessionId, requestId))?.effect).toBe('applied');
    await expect(store.finish(sessionId, requestId, 'unknown')).rejects.toThrow('outcome conflict');
  });
  it('rolls back a duplicate reservation without advancing the control sequence', async () => {
    const store = new PgBrowserInteractionStore(pool),
      sessionId = randomUUID(),
      requestId = randomUUID();
    const record = browserControlRecordSchema.parse({
      sessionId,
      generation: randomUUID(),
      epoch: 1,
      mode: 'quarantined',
      controllerId: randomUUID(),
      expiresAt: null,
      sequence: 1,
      frame: null,
    });
    await store.reserve(record, requestId);
    await expect(store.reserve({ ...record, sequence: 2 }, requestId)).rejects.toThrow();
    expect((await store.get(sessionId))?.sequence).toBe(1);
  });
  it('rejects malformed persisted authority rather than dropping unrecognized fields', async () => {
    const sessionId = randomUUID();
    await pool.query('insert into browser_controls(session_id,record) values($1,$2)', [
      sessionId,
      JSON.stringify({ sessionId, mode: 'human', unexpected: 'value' }),
    ]);
    await expect(new PgBrowserInteractionStore(pool).get(sessionId)).rejects.toThrow();
  });
});
