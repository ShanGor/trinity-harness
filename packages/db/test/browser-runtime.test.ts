import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PgBrowserRuntimeStore } from '../src/index.js';
import type { BrowserRuntimeResult } from '@trinity-harness/contracts';

const url = process.env['DATABASE_URL'];
const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
const locks = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
let reachable = false;
if (url) {
  try {
    await pool.query('SELECT 1');
    reachable = true;
  } catch {
    reachable = false;
  }
}
afterAll(async () => {
  await Promise.all([pool.end(), locks.end()]);
});
describe.skipIf(!reachable)('PostgreSQL browser runtime authority', () => {
  it('persists bindings and incomplete dispatches across adapter restarts', async () => {
    const store = new PgBrowserRuntimeStore(pool, locks);
    const sessionId = randomUUID();
    const record = {
      sessionId,
      generation: randomUUID(),
      owner: randomUUID(),
      status: 'active' as const,
    };
    await store.run(sessionId, async () => {
      await store.bind(record);
      await store.begin(sessionId, 'call', 'a'.repeat(64), record.generation);
    });
    const restarted = new PgBrowserRuntimeStore(pool, locks);
    expect(await restarted.binding(sessionId)).toEqual(record);
    expect(await restarted.command(sessionId, 'call')).toEqual({
      hash: 'a'.repeat(64),
      result: null,
    });
    const result: BrowserRuntimeResult = {
      isError: true,
      value: {
        kind: 'browser-error-v1',
        code: 'DRIVER_FAILED',
        operation: 'click',
        effect: 'unknown',
        message: 'unknown outcome',
      },
    };
    await restarted.run(sessionId, async () => {
      await restarted.finish(sessionId, 'call', result);
      await expect(
        restarted.begin(sessionId, 'call', 'a'.repeat(64), record.generation),
      ).rejects.toThrow();
    });
    expect((await store.command(sessionId, 'call'))?.result).toEqual(result);
    await expect(store.finish(sessionId, 'call', result)).rejects.toThrow('conflict');
  });
  it('serializes independent owners for the full operation and releases an aborted waiter', async () => {
    const store = new PgBrowserRuntimeStore(pool, locks);
    const sessionId = randomUUID();
    const order: string[] = [];
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store.run(sessionId, async () => {
      order.push('first');
      entered();
      await gate;
      order.push('release');
    });
    await ready;
    const controller = new AbortController();
    const aborted = store.run(
      sessionId,
      async () => {
        throw new Error('must not enter');
      },
      controller.signal,
    );
    controller.abort();
    await expect(aborted).rejects.toThrow();
    const second = new PgBrowserRuntimeStore(pool, locks).run(sessionId, async () => {
      order.push('second');
    });
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'release', 'second']);
  });
});
