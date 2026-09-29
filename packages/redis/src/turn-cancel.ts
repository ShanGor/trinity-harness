import type { Disposable } from '@trinity-harness/contracts';
import type { Redis } from 'ioredis';

/**
 * Cross-process turn cancellation (docs/design.md §6.3 "取消", M3
 * `session/cancel`): the API server publishes on `sesscancel:{sessionId}`;
 * every agent-worker replica listens and aborts the turn IF it is running
 * locally (no-op otherwise — at-least-once, idempotent).
 */

export const cancelChannel = (sessionId: string): string => `sesscancel:${sessionId}`;

export class RedisTurnCancelPublisher {
  constructor(private readonly redis: Redis) {}

  cancel(sessionId: string): void {
    void this.redis.publish(cancelChannel(sessionId), 'cancel').catch(() => {});
  }
}

export class RedisTurnCancelSubscriber {
  constructor(private readonly redis: Redis) {}

  subscribe(handler: (sessionId: string) => void): Disposable {
    const conn = this.redis.duplicate();
    let stopped = false;
    void conn
      .psubscribe('sesscancel:*')
      .then(() => {
        conn.on('pmessage', (_pattern: string, channel: string) => {
          if (stopped) return;
          handler(channel.slice('sesscancel:'.length));
        });
      })
      .catch((err) => {
        if (!stopped) console.error('[RedisTurnCancelSubscriber] psubscribe failed', err);
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
