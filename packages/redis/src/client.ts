import { Redis } from 'ioredis';

/** Dedicated connection helpers: BullMQ needs its own connections; XREAD
 *  connections must never be shared with publishers (blocking commands). */
export function createRedis(url: string, opts?: { maxRetriesPerRequest?: null }): Redis {
  return new Redis(url, {
    // BullMQ requires this setting; safe for our own use too.
    maxRetriesPerRequest: opts?.maxRetriesPerRequest ?? null,
    enableReadyCheck: true,
  });
}

export async function isRedisReachable(url: string): Promise<boolean> {
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 3000,
    maxRetriesPerRequest: 0,
  });
  try {
    await redis.connect();
    await redis.ping();
    return true;
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}
