import { bigint, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Append-only session event log (docs/design.md §7).
 *
 * Rules (AGENTS.md §4.3):
 * - Only INSERT and SELECT are allowed on this table. A database trigger
 *   (`session_events_append_only`, see migrations) rejects UPDATE/DELETE.
 * - `(session_id, seq)` is monotonic; seq is assigned transactionally by
 *   `PgSessionStore.append` (advisory xact lock + max(seq)+1).
 * - `prev_hash` chains rows into a tamper-evident hash chain.
 */
export const sessionEvents = pgTable(
  'session_events',
  {
    sessionId: uuid('session_id').notNull(),
    seq: bigint('seq', { mode: 'bigint' }).notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    actor: text('actor').notNull().default('system'),
    prevHash: text('prev_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

export type SessionEventRow = typeof sessionEvents.$inferSelect;
export type NewSessionEventRow = typeof sessionEvents.$inferInsert;
