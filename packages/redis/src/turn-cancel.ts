import type { Disposable, TurnCancellationPort } from '@trinity-harness/contracts';
import type { Redis } from 'ioredis';

/**
 * Cross-process turn cancellation (docs/design.md §6.3 "取消", M3
 * `session/cancel`): the API server publishes on `sesscancel:{sessionId}`;
 * every agent-worker replica listens and aborts the turn IF it is running
 * locally (no-op otherwise — at-least-once, idempotent).
 */

export const cancelChannel = (sessionId: string): string => `sesscancel:${sessionId}`;

export class RedisTurnCancelPublisher implements TurnCancellationPort {
  constructor(private readonly redis: Redis) {}

  async cancel(sessionId: string): Promise<void> {
    await this.redis.publish(cancelChannel(sessionId), 'cancel');
  }
}

export class RedisTurnCancelSubscriber {
  constructor(private readonly redis: Redis) {}

  subscribe(handler: (sessionId: string) => void): Disposable & { started: Promise<void> } {
    const conn = this.redis.duplicate();
    let stopped = false;
    conn.on('pmessage', (_pattern: string, channel: string) => {
      if (!stopped) handler(channel.slice('sesscancel:'.length));
    });
    const started = conn.psubscribe('sesscancel:*').then(() => undefined);
    void started.catch((err) => {
      if (!stopped) console.error('[RedisTurnCancelSubscriber] psubscribe failed', err);
    });
    return {
      started,
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
