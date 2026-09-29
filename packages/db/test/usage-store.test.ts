import 'dotenv/config';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '@trinity-harness/shared';

import { createDb, createPool, createTenant, modelUsage, PgUsageStore } from '../src/index.js';

/**
 * M5: PgUsageStore integration (docs/design.md §15 `model_usage`, §17).
 * Skipped when the local PostgreSQL is unreachable.
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

describe.skipIf(!reachable)('PgUsageStore (integration)', () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof createDb>;
  let store: PgUsageStore;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    const env = loadEnv(process.env, { requireDatabaseUrl: true });
    pool = createPool(env.DATABASE_URL);
    db = createDb(pool);
    store = new PgUsageStore(db);
    tenantId = (await createTenant(db, 'm5-usage-a')).id;
    otherTenantId = (await createTenant(db, 'm5-usage-b')).id;
  });

  afterAll(async () => {
    await db.delete(modelUsage).execute();
    await pool.end();
  });

  it('records usage and aggregates per tenant with window cutoffs', async () => {
    const sessionId = crypto.randomUUID();
    await store.record({
      tenantId,
      sessionId,
      model: 'fake/model',
      inputTokens: 100,
      outputTokens: 50,
    });
    // An old row (yesterday) must not count toward today's windows.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await store.record({
      tenantId,
      sessionId,
      model: 'fake/model',
      inputTokens: 1000,
      outputTokens: 1000,
      at: yesterday.toISOString(),
    });
    // Another tenant is never mixed in.
    await store.record({
      tenantId: otherTenantId,
      sessionId: crypto.randomUUID(),
      model: 'fake/model',
      inputTokens: 7,
      outputTokens: 7,
    });

    const epoch = new Date(0);
    const sinceHour = new Date();
    sinceHour.setUTCMinutes(0, 0, 0);

    expect(await store.usageSince(tenantId, epoch)).toBe(2150);
    expect(await store.usageSince(tenantId, sinceHour)).toBe(150);
    expect(await store.usageSince(otherTenantId, epoch)).toBe(14);
  });

  it('quotaOf defaults to unlimited; setQuota round-trips (validated)', async () => {
    expect(await store.quotaOf(tenantId)).toEqual({});

    await store.setQuota(tenantId, { dailyTokens: 12345 });
    expect(await store.quotaOf(tenantId)).toEqual({ dailyTokens: 12345 });

    await store.setQuota(tenantId, { hourlyTokens: 100, monthlyTokens: 1_000_000 });
    expect(await store.quotaOf(tenantId)).toEqual({
      hourlyTokens: 100,
      monthlyTokens: 1_000_000,
    });

    await expect(store.setQuota(crypto.randomUUID(), { dailyTokens: 1 })).rejects.toThrow(
      /tenant not found/,
    );
  });
});
