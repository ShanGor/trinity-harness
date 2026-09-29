import { existsSync } from 'node:fs';
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';

import { createDb, createPool, PgAuditStore } from '@trinity-harness/db';
import { createRedis, isRedisReachable, RedisEventBus } from '@trinity-harness/redis';
import { loadEnv } from '@trinity-harness/shared';

import { startAuditConsumer } from './consumer.js';

// Load .env from the repo root first, then the app dir (local overrides).
for (const candidate of [
  path.resolve(process.cwd(), '../../.env'),
  path.resolve(process.cwd(), '.env'),
]) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate, quiet: true });
  }
}

/** docs/design.md §13/§16: standalone Deployment consuming the audit stream. */
async function main(): Promise<void> {
  const env = loadEnv(process.env, { requireDatabaseUrl: true });
  const redisUrl = process.env['REDIS_URL'];
  if (!redisUrl) {
    throw new Error('REDIS_URL is required');
  }
  if (!(await isRedisReachable(redisUrl))) {
    throw new Error(`Redis unreachable at ${redisUrl} (fail-closed)`);
  }

  const redis = createRedis(redisUrl);
  const pool = createPool(env.DATABASE_URL);
  const consumer = startAuditConsumer({
    bus: new RedisEventBus(redis),
    store: new PgAuditStore(createDb(pool)),
  });
  console.log('[audit-consumer] consuming audit stream');

  const shutdown = async (): Promise<void> => {
    consumer.dispose();
    redis.disconnect();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
