import type {
  Disposable,
  LiveEventPublisher,
  LiveEventSubscriber,
  LoopEvent,
} from '@trinity-harness/contracts';
import type { Redis } from 'ioredis';

/**
 * Ephemeral live-delta fan-out over Redis Pub/Sub (docs/design.md §14).
 * One psubscribed connection per process; in-process fan-out to SSE
 * connections. Delivery is best-effort by design — committed state travels
 * through the event log, so a client that missed deltas resyncs from the log.
 */

export const liveChannel = (sessionId: string): string => `sesslive:${sessionId}`;

export class RedisLiveEventPublisher implements LiveEventPublisher {
  constructor(private readonly redis: Redis) {}

  publish(sessionId: string, event: LoopEvent): void {
    // Fire-and-forget: a lost delta only costs latency, never consistency.
    void this.redis.publish(liveChannel(sessionId), JSON.stringify(event)).catch(() => {});
  }
}

export class RedisLiveEventSubscriber implements LiveEventSubscriber {
  constructor(private readonly redis: Redis) {}

  subscribe(handler: (sessionId: string, event: LoopEvent) => void): Disposable {
    const conn = this.redis.duplicate();
    let stopped = false;
    void conn
      .psubscribe('sesslive:*')
      .then(() => {
        conn.on('pmessage', (_pattern: string, channel: string, message: string) => {
          if (stopped) return;
          const sessionId = channel.slice('sesslive:'.length);
          try {
            handler(sessionId, JSON.parse(message) as LoopEvent);
          } catch (err) {
            console.error(`[RedisLiveEventSubscriber] bad live payload on ${channel}`, err);
          }
        });
      })
      .catch((err) => {
        if (!stopped) {
          console.error('[RedisLiveEventSubscriber] psubscribe failed', err);
        }
      });
    return {
      dispose: () => {
        stopped = true;
        conn.disconnect();
      },
      [Symbol.dispose]() {
        this.dispose();
      },
    };
  }
}
