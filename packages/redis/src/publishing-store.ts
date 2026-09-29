import type {
  AppendOptions,
  Message,
  SeqRange,
  SessionEvent,
  SessionEventPublisher,
  SessionStore,
} from '@trinity-harness/contracts';

/**
 * SessionStore decorator: append to the wrapped store (PG), then publish the
 * committed events to the session's Redis Stream (docs/design.md §14).
 *
 * Publishing happens strictly AFTER the append resolves, so the stream can
 * only lag the log — a consumer that needs absolute certainty replays from PG
 * (§11.3: PG is the source of truth, Redis is a distribution layer).
 *
 * Best-effort by design: if Redis is down the log stays consistent and SSE
 * clients reconnect to a later offset; the turn itself is never failed by a
 * distribution-layer outage.
 */
export class PublishingSessionStore implements SessionStore {
  constructor(
    private readonly inner: SessionStore,
    private readonly publisher: SessionEventPublisher,
  ) {}

  async append(
    sessionId: string,
    events: readonly SessionEvent[],
    opts?: AppendOptions,
  ): Promise<SeqRange> {
    const range = await this.inner.append(sessionId, events, opts);
    if (events.length > 0) {
      const entries = events.map((event, i) => ({ seq: range.from + i, event }));
      try {
        await this.publisher.publish(sessionId, entries);
      } catch (err) {
        // Distribution-layer failure must not fail the turn (design.md §14).
        console.error(`[PublishingSessionStore] publish failed for ${sessionId}`, err);
      }
    }
    return range;
  }

  load(sessionId: string, opts?: { toSeq?: number }): Promise<SessionEvent[]> {
    return this.inner.load(sessionId, opts);
  }

  loadRange(
    sessionId: string,
    opts: { afterSeq: number; toSeq?: number },
  ): Promise<{ seq: number; event: SessionEvent }[]> {
    return this.inner.loadRange(sessionId, opts);
  }

  projectMessages(sessionId: string): Promise<Message[]> {
    return this.inner.projectMessages(sessionId);
  }
}
