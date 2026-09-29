import 'dotenv/config';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditRecord } from '@trinity-harness/contracts';
import { createDb, createPool, newAuditRecord, PgAuditStore } from '@trinity-harness/db';
import { loadEnv } from '@trinity-harness/shared';
import { createRedis, isRedisReachable, RedisEventBus } from '@trinity-harness/redis';

import { startAuditConsumer } from '../src/index.js';

/**
 * docs/design.md §13 integration: audit records published onto the `audit`
 * stream are persisted by the independent consumer into `audit_log`, exactly
 * once even under at-least-once redelivery.
 */

const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

async function pgReachable(url: string): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
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
const hasInfra =
  !!databaseUrl && (await pgReachable(databaseUrl)) && (await isRedisReachable(redisUrl));

describe.skipIf(!hasInfra)('audit consumer (integration)', () => {
  let pool: pg.Pool;
  let redis: ReturnType<typeof createRedis>;
  let bus: RedisEventBus;
  let store: PgAuditStore;
  let dispose: () => void;
  const tenantId = crypto.randomUUID();

  beforeAll(async () => {
    const env = loadEnv(process.env, { requireDatabaseUrl: true });
    pool = createPool(env.DATABASE_URL);
    store = new PgAuditStore(createDb(pool));
    redis = createRedis(redisUrl);
    bus = new RedisEventBus(redis, { blockMs: 300 });
    const handle = startAuditConsumer({
      bus,
      store,
      group: `audit-test-${crypto.randomUUID().slice(0, 8)}`,
    });
    dispose = () => handle.dispose();
  });

  afterAll(async () => {
    dispose();
    redis.disconnect();
    await pool.end();
  });

  it('persists published audit records (idempotent on redelivery)', async () => {
    const record: AuditRecord = newAuditRecord({
      tenantId,
      userId: 'u-test',
      action: 'auth/login',
      result: 'ok',
    });
    await bus.publish('audit', { type: 'audit/record', payload: record, occurredAt: record.at });
    // Same record again → consumer dedupes via PK conflict.
    await bus.publish('audit', { type: 'audit/record', payload: record, occurredAt: record.at });

    await expect
      .poll(async () => (await store.query({ tenantId })).total, { timeout: 10000 })
      .toBe(1);

    const page = await store.query({ tenantId, action: 'auth/login' });
    expect(page.records[0]).toMatchObject({ userId: 'u-test', result: 'ok' });
  });
});
