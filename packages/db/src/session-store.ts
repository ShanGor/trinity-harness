import { createHash } from 'node:crypto';

import type { SessionEvent } from '@trinity-harness/contracts';
import { projectMessages, sessionEventSchema } from '@trinity-harness/contracts';
import type { AppendOptions, Message, SeqRange, SessionStore } from '@trinity-harness/contracts';
import { and, asc, desc, eq, gt, lte, sql } from 'drizzle-orm';

import type { Db } from './client.js';
import { sessionEvents } from './schema.js';

/** prev_hash of the first event in a session. */
export const GENESIS_HASH = 'GENESIS';

/** Deterministic JSON (sorted object keys) so the hash chain is stable. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function computeEventHash(
  sessionId: string,
  seq: number,
  prevHash: string,
  payload: SessionEvent,
): string {
  return createHash('sha256')
    .update(`${sessionId}|${seq}|${prevHash}|${canonicalJson(payload)}`)
    .digest('hex');
}

/**
 * PostgreSQL-backed {@link SessionStore} (docs/design.md §7).
 *
 * Concurrency: `append` takes a per-session advisory transaction lock
 * (`pg_advisory_xact_lock`) before reading `max(seq)`, which guarantees
 * monotonic `(session_id, seq)` across concurrent writers.
 */
export class PgSessionStore implements SessionStore {
  constructor(private readonly db: Db) {}

  async append(
    sessionId: string,
    events: readonly SessionEvent[],
    opts?: AppendOptions,
  ): Promise<SeqRange> {
    if (events.length === 0) {
      throw new Error('append requires at least one event');
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${sessionId}))`);

      const [last] = await tx
        .select({ seq: sessionEvents.seq, prevHash: sessionEvents.prevHash })
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId))
        .orderBy(desc(sessionEvents.seq))
        .limit(1);

      let seq = last ? last.seq + 1n : 1n;
      let prevHash = last?.prevHash ?? GENESIS_HASH;
      const from = seq;
      const actor = opts?.actor ?? 'system';

      for (const raw of events) {
        // Narrow at the DB boundary (AGENTS.md §4.1): never trust caller shapes.
        const event = sessionEventSchema.parse(raw);
        const hash = computeEventHash(sessionId, Number(seq), prevHash, event);
        await tx.insert(sessionEvents).values({
          sessionId,
          seq,
          type: event.type,
          payload: event,
          actor,
          prevHash: hash,
        });
        prevHash = hash;
        seq += 1n;
      }

      return { from: Number(from), to: Number(seq - 1n) };
    });
  }

  async load(sessionId: string, opts?: { toSeq?: number }): Promise<SessionEvent[]> {
    const conditions = [eq(sessionEvents.sessionId, sessionId)];
    if (opts?.toSeq !== undefined) {
      conditions.push(lte(sessionEvents.seq, BigInt(opts.toSeq)));
    }
    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(and(...conditions))
      .orderBy(asc(sessionEvents.seq));
    return rows.map((row) => sessionEventSchema.parse(row.payload));
  }

  async loadRange(
    sessionId: string,
    opts: { afterSeq: number; toSeq?: number },
  ): Promise<{ seq: number; event: SessionEvent }[]> {
    const conditions = [
      eq(sessionEvents.sessionId, sessionId),
      gt(sessionEvents.seq, BigInt(opts.afterSeq)),
    ];
    if (opts.toSeq !== undefined) {
      conditions.push(lte(sessionEvents.seq, BigInt(opts.toSeq)));
    }
    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(and(...conditions))
      .orderBy(asc(sessionEvents.seq));
    return rows.map((row) => ({
      seq: Number(row.seq),
      event: sessionEventSchema.parse(row.payload),
    }));
  }

  async projectMessages(sessionId: string): Promise<Message[]> {
    return projectMessages(await this.load(sessionId));
  }

  /**
   * M3 sanctioned append-only exception (see SessionStore.remove in contracts):
   * removing a just-appended user prompt that the permission policy rejected
   * before the turn started. The PG trigger `session_events_append_only`
   * enforces the narrow contract (only a `message/user` TAIL row may go —
   * see migration 0003); a violation surfaces as a query error.
   */
  async remove(sessionId: string, seq: number): Promise<void> {
    await this.db
      .delete(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.seq, BigInt(seq))));
  }
}
