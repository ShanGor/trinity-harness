import 'dotenv/config';

import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SessionEvent } from '@trinity-harness/contracts';
import { loadEnv } from '@trinity-harness/shared';

import { createDb, createPool, GENESIS_HASH, PgSessionStore, sessionEvents } from '../src/index.js';

/**
 * Integration tests against the real local PostgreSQL (localhost:5432,
 * see .env). The whole suite is skipped when the database is unreachable so
 * unit-test runs never depend on the environment.
 */

async function isDatabaseReachable(databaseUrl: string): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

const databaseUrl = process.env['DATABASE_URL'];
const reachable = databaseUrl ? await isDatabaseReachable(databaseUrl) : false;

const now = () => new Date().toISOString();
const text = (t: string) => ({ kind: 'text' as const, text: t });

function userMessage(body: string): SessionEvent {
  return {
    type: 'message/user',
    eventId: crypto.randomUUID(),
    at: now(),
    surfaceOp: 'append',
    content: [text(body)],
  };
}

describe.skipIf(!reachable)('PgSessionStore (integration)', () => {
  let pool: pg.Pool;
  let store: PgSessionStore;

  beforeAll(() => {
    const env = loadEnv();
    pool = createPool(env.DATABASE_URL);
    store = new PgSessionStore(createDb(pool));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('appends events with monotonically increasing seq starting at 1', async () => {
    const sessionId = crypto.randomUUID();

    const first = await store.append(sessionId, [userMessage('one')], { actor: 'tester' });
    expect(first).toEqual({ from: 1, to: 1 });

    const second = await store.append(sessionId, [
      userMessage('two'),
      {
        type: 'turn/end',
        eventId: crypto.randomUUID(),
        at: now(),
        reason: 'completed',
      },
    ]);
    expect(second).toEqual({ from: 2, to: 3 });

    const replayed = await store.load(sessionId);
    expect(replayed.map((e) => e.type)).toEqual(['message/user', 'message/user', 'turn/end']);
  });

  it('concurrent appends produce disjoint, gap-free seq ranges', async () => {
    const sessionId = crypto.randomUUID();
    const [a, b, c] = await Promise.all([
      store.append(sessionId, [userMessage('a')]),
      store.append(sessionId, [userMessage('b'), userMessage('b2')]),
      store.append(sessionId, [userMessage('c')]),
    ]);

    const ranges = [a, b, c].sort((x, y) => x.from - y.from);
    expect(ranges[0]).toEqual({ from: 1, to: ranges[0]!.to });
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]!.from).toBe(ranges[i - 1]!.to + 1);
    }

    const replayed = await store.load(sessionId);
    expect(replayed).toHaveLength(4);
    expect(replayed.map((_, i) => i + 1)).toEqual([1, 2, 3, 4]); // seqs are 1..4 in order
  });

  it('maintains a sha256 hash chain over the log', async () => {
    const sessionId = crypto.randomUUID();
    await store.append(sessionId, [userMessage('x'), userMessage('y')]);

    const rows = await createDb(pool)
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .orderBy(sessionEvents.seq);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.prevHash).not.toBe(GENESIS_HASH);
    expect(rows[0]!.prevHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[1]!.prevHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.prevHash).not.toBe(rows[1]!.prevHash);
  });

  it('rejects out-of-contract payloads at the boundary', async () => {
    const sessionId = crypto.randomUUID();
    const bogus = { type: 'message/ghost' } as unknown as SessionEvent;
    await expect(store.append(sessionId, [bogus])).rejects.toThrow();
  });

  it('load(toSeq) truncates the replay at the requested seq', async () => {
    const sessionId = crypto.randomUUID();
    await store.append(sessionId, [userMessage('1'), userMessage('2'), userMessage('3')]);

    const partial = await store.load(sessionId, { toSeq: 2 });
    expect(partial).toHaveLength(2);
    expect((partial[1] as { content: { text: string }[] }).content[0]!.text).toBe('2');
  });

  it('projectMessages reflects user messages and assistant replace settles', async () => {
    const sessionId = crypto.randomUUID();
    await store.append(sessionId, [
      userMessage('question'),
      {
        type: 'message/assistant',
        eventId: crypto.randomUUID(),
        at: now(),
        surfaceOp: 'append',
        content: [text('partial')],
      },
      {
        type: 'message/assistant',
        eventId: crypto.randomUUID(),
        at: now(),
        surfaceOp: 'replace',
        content: [text('answer')],
      },
    ]);

    const surface = await store.projectMessages(sessionId);
    expect(surface).toEqual([
      { role: 'user', content: [text('question')] },
      { role: 'assistant', content: [text('answer')] },
    ]);
  });

  it('enforces append-only at the database level (trigger)', async () => {
    const sessionId = crypto.randomUUID();
    await store.append(sessionId, [userMessage('immutable')]);

    // drizzle re-wraps driver errors; the original PG message lives in `cause`.
    const pgMessage = (err: unknown): string =>
      String(
        (err as { cause?: { message?: unknown } }).cause?.message ??
          (err as { message?: unknown }).message ??
          err,
      );

    const db = createDb(pool);
    const updateError = await db
      .update(sessionEvents)
      .set({ actor: 'attacker' })
      .where(eq(sessionEvents.sessionId, sessionId))
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(updateError).not.toBeNull();
    expect(pgMessage(updateError)).toMatch(/append-only/i);

    const deleteError = await db
      .delete(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(deleteError).not.toBeNull();
    expect(pgMessage(deleteError)).toMatch(/append-only/i);
  });
});
