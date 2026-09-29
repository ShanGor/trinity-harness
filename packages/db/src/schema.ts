import {
  bigint,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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

/** Tenant isolation root (docs/design.md §12.4, §15). */
export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

/** Users are provisioned per tenant (admin API); passwords stored scrypt-hashed. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('developer'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

/** Session ownership/metadata; the event log lives in session_events. */
export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  title: text('title').notNull().default(''),
  workspaceUri: text('workspace_uri').notNull(),
  /** M3: permission policy (preset name or JSON policy; default at insert). */
  policy: text('policy'),
  forkedFrom: uuid('forked_from'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true, mode: 'string' }),
});

/**
 * Audit projection written by the audit consumer (docs/design.md §13).
 * Columnar-friendly fields for SIEM-style querying; hot table, no triggers.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    userId: text('user_id').notNull(),
    sessionId: uuid('session_id'),
    action: text('action').notNull(),
    target: text('target'),
    result: text('result').notNull(),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index('audit_log_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('audit_log_session_idx').on(t.sessionId),
  ],
);

/**
 * Approval trail (docs/design.md §12.2, §15 `approvals`): every gated tool
 * call leaves a row; the outcome columns are filled by the first reply
 * (idempotent). Mutable by design — this is NOT part of the append-only log.
 */
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').notNull(),
    sessionId: uuid('session_id').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    toolName: text('tool_name').notNull(),
    argsPreview: text('args_preview').notNull(),
    /** null while pending. */
    outcome: text('outcome'),
    decidedBy: text('decided_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'string' }),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index('approvals_session_idx').on(t.sessionId, t.createdAt),
  ],
);
