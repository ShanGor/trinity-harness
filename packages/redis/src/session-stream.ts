import type {
  Disposable,
  SessionEvent,
  SessionEventPublisher,
  SessionEventReader,
} from '@trinity-harness/contracts';
import { sessionEventSchema } from '@trinity-harness/contracts';
import type { Redis } from 'ioredis';

/**
 * Per-session event distribution with three-layer seq alignment
 * (docs/design.md §11.3): stream ids ARE `session_events.seq`, so a consumer
 * resuming from seq N simply reads the stream after id N — and the SSE `id:`
 * field maps 1:1 onto the PG truth.
 *
 * Entries are published only AFTER the PG transaction commits (the wrapper
 * publishes post-append), so a stream can only ever lag PG, never contradict.
 */

export const sessionStreamKey = (sessionId: string): string => `sess:${sessionId}`;

/**
 * Stream ids must be `<ms>-<seq>`; we store the PG seq in the ms part with a
 * constant 0 sub-seq, preserving the three-layer alignment (§11.3).
 */
const seqToId = (seq: number): string => `${seq}-0`;
const idToSeq = (id: string): number => Number(id.split('-')[0]);

export class RedisSessionEventPublisher implements SessionEventPublisher {
  constructor(
    private readonly redis: Redis,
    private readonly opts?: { maxlen?: number },
  ) {}

  async publish(
    sessionId: string,
    entries: readonly { seq: number; event: SessionEvent }[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const key = sessionStreamKey(sessionId);
    const maxlen = this.opts?.maxlen ?? 10_000;
    for (const { seq, event } of entries) {
      await this.redis.xadd(
        key,
        'MAXLEN',
        '~',
        maxlen,
        seqToId(seq),
        'data',
        JSON.stringify(event),
      );
    }
  }
}

interface StreamInfo {
  /** First retained entry, as a plain seq. */
  firstSeq: number | null;
  length: number;
}

async function streamInfo(redis: Redis, key: string): Promise<StreamInfo | null> {
  try {
    const out = (await redis.xinfo('STREAM', key)) as unknown[];
    const length = Number(out[1]);
    // XINFO layout: ... "first-entry" [id, fields] ... "last-entry" [id, fields]
    const firstIdx = out.indexOf('first-entry');
    const firstEntry = firstIdx >= 0 ? (out[firstIdx + 1] as [string, unknown[]] | null) : null;
    if (length === 0 || !firstEntry) return { firstSeq: null, length: 0 };
    return { firstSeq: idToSeq(firstEntry[0]), length };
  } catch (err) {
    if (err instanceof Error && err.message.includes('no such key')) return null;
    throw err;
  }
}

/**
 * Blocking read of one session stream starting strictly after `afterSeq`.
 *
 * `open` resolves `started` once the initial cursor is established, so the
 * caller can safely PG-fill the gap between `afterSeq` and the first retained
 * stream entry without racing the live reader (see apps/server relay).
 */
export class RedisSessionEventReader implements SessionEventReader {
  constructor(
    private readonly redis: Redis,
    private readonly opts?: { blockMs?: number },
  ) {}

  async firstRetainedSeq(sessionId: string): Promise<number | null> {
    const info = await streamInfo(this.redis, sessionStreamKey(sessionId));
    return info?.firstSeq ?? null;
  }

  open(
    sessionId: string,
    afterSeq: number,
    handler: (entry: { seq: number; event: SessionEvent }) => void,
  ): Disposable & { started: Promise<void> } {
    const key = sessionStreamKey(sessionId);
    const blockMs = this.opts?.blockMs ?? 30_000;
    let stopped = false;
    // Dedicated connection: a blocking XREAD must never share its connection
    // with publishers or other readers (ioredis serializes per connection).
    const conn = this.redis.duplicate();

    // Resolves once the resume cursor is established — the caller may then
    // safely PG-fill the gap [afterSeq, firstRetainedSeq) without racing.
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    void (async () => {
      const info = await streamInfo(conn, key);
      // Entries older than the retained window are served from PG by the
      // caller; here we only ensure the live cursor never rewinds past what
      // Redis still holds. Stream ids carry the PG seq.
      let cursor: string;
      if (info && info.firstSeq !== null) {
        const lowerBound = Math.max(afterSeq, info.firstSeq - 1);
        cursor = seqToId(lowerBound);
      } else {
        cursor = seqToId(afterSeq);
      }
      markStarted();

      while (!stopped) {
        const res = (await conn.xread('COUNT', 128, 'BLOCK', blockMs, 'STREAMS', key, cursor)) as
          [string, [string, string[]][]][] | null;
        if (!res) continue; // timeout — loop (BLOCK is also our shutdown point)
        for (const [, entries] of res) {
          for (const [id, fields] of entries) {
            cursor = id;
            if (stopped) return;
            const raw = fields[fields.indexOf('data') + 1];
            if (raw === undefined) continue;
            handler({ seq: idToSeq(id), event: sessionEventSchema.parse(JSON.parse(raw)) });
          }
        }
      }
    })().catch((err) => {
      if (!stopped) {
        console.error(`[RedisSessionEventReader] read loop crashed for ${key}`, err);
      }
    });

    const handle = {
      started,
      dispose: () => {
        stopped = true;
        // Disconnect (not quit): the loop may be parked in a blocking XREAD
        // and would not process QUIT until it unblocks.
        conn.disconnect();
      },
      [Symbol.dispose]() {
        this.dispose();
      },
    };
    return handle;
  }
}
