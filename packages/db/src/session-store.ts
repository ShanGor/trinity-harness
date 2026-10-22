import { createHash } from 'node:crypto';

import type { SessionEvent } from '@trinity-harness/contracts';
import {
  projectMessages,
  sessionEventSchema,
  topicEpisodeSchema,
  suggestTopic,
} from '@trinity-harness/contracts';
import type { AppendOptions, Message, SeqRange, SessionStore } from '@trinity-harness/contracts';
import { and, asc, desc, eq, gt, lt, lte, sql } from 'drizzle-orm';

import type { Db } from './client.js';
import { sessionEvents, sessions, conversationEpisodes } from './schema.js';

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

      if (events.length === 1 && events[0]?.type === 'session/created' && last)
        return { from: 1, to: 1 };

      if (events.length === 1 && events[0]?.type === 'activity/reference') {
        const reference = events[0];
        const [prior] = await tx
          .select({ seq: sessionEvents.seq })
          .from(sessionEvents)
          .where(
            and(
              eq(sessionEvents.sessionId, sessionId),
              eq(sessionEvents.type, 'activity/reference'),
              sql`${sessionEvents.payload}->>'sourceSessionId' = ${reference.sourceSessionId}`,
              sql`${sessionEvents.payload}->>'sourceEventId' = ${reference.sourceEventId}`,
            ),
          )
          .limit(1);
        if (prior) return { from: Number(prior.seq), to: Number(prior.seq) };
      }

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
        if (event.type === 'turn/end' && event.reason === 'completed' && event.promptId) {
          const [owner] = await tx
            .select()
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .limit(1);
          if (owner?.kind && owner.scope === 'personal') {
            const [source] = await tx
              .select()
              .from(sessionEvents)
              .where(
                and(
                  eq(sessionEvents.sessionId, sessionId),
                  sql`${sessionEvents.payload}->>'eventId' = ${event.promptId}`,
                ),
              )
              .limit(1);
            if (source) {
              const user = sessionEventSchema.parse(source.payload);
              const [answer] = await tx
                .select()
                .from(sessionEvents)
                .where(
                  and(
                    eq(sessionEvents.sessionId, sessionId),
                    eq(sessionEvents.type, 'message/assistant'),
                    gt(sessionEvents.seq, source.seq),
                    lte(sessionEvents.seq, seq),
                  ),
                )
                .orderBy(desc(sessionEvents.seq))
                .limit(1);
              const final = answer ? sessionEventSchema.parse(answer.payload) : null;
              if (
                user.type === 'message/user' &&
                final?.type === 'message/assistant' &&
                final.phase !== 'progress'
              ) {
                const text = (content: typeof user.content): string =>
                  content
                    .filter((block) => block.kind === 'text')
                    .map((block) => (block.kind === 'text' ? block.text : ''))
                    .join('\n');
                const prior = await tx
                  .select()
                  .from(conversationEpisodes)
                  .where(
                    and(
                      eq(conversationEpisodes.tenantId, owner.tenantId),
                      eq(conversationEpisodes.userId, owner.userId),
                    ),
                  )
                  .orderBy(desc(conversationEpisodes.id))
                  .limit(12);
                const request = text(user.content).slice(0, 4000);
                const [selection] = await tx
                  .select()
                  .from(sessionEvents)
                  .where(
                    and(
                      eq(sessionEvents.sessionId, sessionId),
                      eq(sessionEvents.type, 'memory/selection'),
                      sql`${sessionEvents.payload}->'receipt'->>'promptId' = ${user.eventId}`,
                    ),
                  )
                  .orderBy(desc(sessionEvents.seq))
                  .limit(1);
                const selectionEvent = selection
                  ? sessionEventSchema.parse(selection.payload)
                  : null;
                const episode = topicEpisodeSchema.parse({
                  policyRevision:
                    selectionEvent?.type === 'memory/selection'
                      ? selectionEvent.receipt.policyRevision
                      : 0,
                  answerSeq: Number(answer!.seq),
                  episodeId: user.eventId,
                  promptId: user.eventId,
                  sessionId,
                  fromSeq: Number(source.seq),
                  toSeq: Number(seq),
                  at: user.at,
                  request,
                  outcome: text(final.content).slice(0, 6000),
                  topic: suggestTopic(
                    request,
                    prior.map((row) => topicEpisodeSchema.parse(row.payload)),
                  ),
                  excluded: false,
                });
                await tx
                  .insert(conversationEpisodes)
                  .values({
                    tenantId: owner.tenantId,
                    userId: owner.userId,
                    sessionId,
                    promptId: user.eventId,
                    payload: episode,
                  })
                  .onConflictDoNothing();
              }
            }
          }
        }
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

  async loadPage(
    sessionId: string,
    opts: { beforeSeq?: number; limit: number },
  ): Promise<{
    entries: { seq: number; event: SessionEvent }[];
    nextBefore: number | null;
    lastSeq: number;
  }> {
    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.sessionId, sessionId),
          opts.beforeSeq === undefined ? undefined : lt(sessionEvents.seq, BigInt(opts.beforeSeq)),
        ),
      )
      .orderBy(desc(sessionEvents.seq))
      .limit(Math.min(300, opts.limit) + 1);
    const page = rows.slice(0, opts.limit).reverse();
    return {
      entries: page.map((row) => ({
        seq: Number(row.seq),
        event: sessionEventSchema.parse(row.payload),
      })),
      nextBefore: rows.length > opts.limit ? Number(page[0]!.seq) : null,
      lastSeq: Number(rows[0]?.seq ?? 0),
    };
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
