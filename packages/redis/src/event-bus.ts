import type { BusEvent, Disposable, EventBus } from '@trinity-harness/contracts';
import type { Redis } from 'ioredis';

const DEFAULT_MAXLEN = 10_000;

/**
 * Redis Stream {@link EventBus} (docs/design.md §14).
 *
 * Streams are capped with `MAXLEN ~` — Redis is a distribution layer only;
 * PG remains the source of truth, truncation loses nothing.
 *
 * `subscribe` uses consumer groups: every (stream, group) pair gets its own
 * copy (fan-out), failed deliveries stay pending and are reclaimed via
 * `XAUTOCLAIM` (at-least-once). Disposing the handle stops the loop but does
 * NOT destroy the group, so a restarting consumer resumes its pending list.
 */
export class RedisEventBus implements EventBus {
  constructor(
    private readonly redis: Redis,
    private readonly opts?: { maxlen?: number; blockMs?: number },
  ) {}

  async publish(stream: string, event: BusEvent): Promise<void> {
    await this.redis.xadd(
      stream,
      'MAXLEN',
      '~',
      this.opts?.maxlen ?? DEFAULT_MAXLEN,
      '*',
      'data',
      JSON.stringify(event),
    );
  }

  subscribe(
    stream: string,
    group: string,
    handler: (event: BusEvent) => Promise<void>,
  ): Disposable {
    const redis = this.redis;
    const blockMs = this.opts?.blockMs ?? 5000;
    const consumer = `c-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    let stopped = false;

    const ensureGroup = async (): Promise<void> => {
      try {
        await redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
      } catch (err) {
        // BUSYGROUP = group already exists — fine.
        if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
      }
    };

    const deliver = async (id: string, fields: string[]): Promise<void> => {
      const raw = fields[fields.indexOf('data') + 1];
      if (raw === undefined) {
        await redis.xack(stream, group, id);
        return;
      }
      try {
        const event = JSON.parse(raw) as BusEvent;
        await handler(event);
        await redis.xack(stream, group, id);
      } catch (err) {
        // Leave un-acked: the next reclaim pass retries it (at-least-once).
        // A poison entry would loop forever — surface it loudly.
        console.error(`[RedisEventBus] handler failed for ${stream}#${id}`, err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    };

    const loop = (async () => {
      await ensureGroup();
      while (!stopped) {
        // Reclaim stale pending entries first (crash recovery, at-least-once).
        const claimed = await redis.xautoclaim(stream, group, consumer, 60_000, '0', 'COUNT', 32);
        const [, claimedEntries] = claimed as [string, [string, string[]][], string];
        for (const [id, fields] of claimedEntries ?? []) {
          if (stopped) return;
          await deliver(id, fields);
        }

        const res = (await redis.xreadgroup(
          'GROUP',
          group,
          consumer,
          'COUNT',
          32,
          'BLOCK',
          blockMs,
          'STREAMS',
          stream,
          '>',
        )) as [string, [string, string[]][]][] | null;
        for (const [, entries] of res ?? []) {
          for (const [id, fields] of entries) {
            if (stopped) return;
            await deliver(id, fields);
          }
        }
      }
    })();

    const handle: Disposable = {
      dispose: () => {
        stopped = true;
      },
      [Symbol.dispose]() {
        this.dispose();
      },
    };
    // Surface unexpected loop termination instead of dying silently.
    loop.catch((err) => {
      if (!stopped) {
        console.error(`[RedisEventBus] subscribe loop crashed for ${stream}:${group}`, err);
      }
    });
    return handle;
  }
}
