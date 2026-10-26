import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
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

export const assistantEnvironments = pgTable(
  'assistant_environments',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    nodeId: text('node_id').notNull(),
    generation: uuid('generation').notNull(),
    state: text('state').notNull(),
    vcpus: bigint('vcpus', { mode: 'number' }).notNull(),
    memoryMiB: bigint('memory_mib', { mode: 'number' }).notNull(),
  },
  (t) => [uniqueIndex('assistant_environment_owner').on(t.tenantId, t.userId)],
);

export const firecrackerNodeMaintenance = pgTable('firecracker_node_maintenance', {
  nodeId: text('node_id').primaryKey(),
  state: text('state').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const environmentEvents = pgTable(
  'environment_events',
  {
    id: uuid('id').primaryKey(),
    environmentId: uuid('environment_id').notNull(),
    type: text('type').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('environment_events_owner').on(t.environmentId, t.createdAt)],
);

export const assistantSchedules = pgTable(
  'assistant_schedules',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    operationId: uuid('operation_id').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    definition: jsonb('definition').notNull(),
    enabled: boolean('enabled').notNull(),
    nextFireAt: timestamp('next_fire_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [
    uniqueIndex('assistant_schedule_operation').on(t.tenantId, t.userId, t.operationId),
    index('assistant_schedule_due').on(t.enabled, t.nextFireAt),
  ],
);

export const scheduleOccurrences = pgTable(
  'schedule_occurrences',
  {
    id: uuid('id').primaryKey(),
    scheduleId: uuid('schedule_id').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true, mode: 'string' }).notNull(),
    sessionId: uuid('session_id'),
    promptId: uuid('prompt_id'),
    title: text('title').notNull(),
    status: text('status').notNull(),
    reason: text('reason').notNull(),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'string' }),
  },
  (t) => [
    uniqueIndex('schedule_occurrence_unique').on(t.scheduleId, t.revision, t.scheduledAt),
    index('schedule_inbox_owner').on(t.tenantId, t.userId, t.scheduledAt),
  ],
);

/** Managed browser authority and at-most-once dispatch journal; evidence stays in blobs/logs. */
export const browserRuntimes = pgTable('browser_runtimes', {
  sessionId: uuid('session_id').primaryKey(),
  generation: uuid('generation').notNull(),
  owner: uuid('owner').notNull(),
  status: text('status').notNull(),
});
export const browserControls = pgTable('browser_controls', {
  sessionId: uuid('session_id').primaryKey(),
  record: jsonb('record').notNull(),
});
export const browserUserInputs = pgTable(
  'browser_user_inputs',
  {
    sessionId: uuid('session_id').notNull(),
    requestId: uuid('request_id').notNull(),
    record: jsonb('record').notNull(),
    effect: text('effect'),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.requestId] })],
);
export const browserCommands = pgTable(
  'browser_commands',
  {
    sessionId: uuid('session_id').notNull(),
    callId: text('call_id').notNull(),
    requestHash: text('request_hash').notNull(),
    generation: uuid('generation').notNull(),
    result: jsonb('result'),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.callId] })],
);

/** Tenant isolation root (docs/design.md §12.4, §15). */
export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  /** M5: per-tenant token quota (docs/design.md §17); null ⇒ unlimited. */
  quota: jsonb('quota'),
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
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    title: text('title').notNull().default(''),
    workspaceUri: text('workspace_uri'),
    kind: text('kind'),
    sessionRole: text('session_role'),
    creationOperationId: uuid('creation_operation_id'),
    originSessionId: uuid('origin_session_id'),
    /**
     * Workspace scope (docs/design.md §15): 'personal' → the creator's
     * directory, 'team' → a team directory the creator is a member of.
     */
    scope: text('scope').notNull().default('personal'),
    /** Team id when scope === 'team'. */
    scopeId: uuid('scope_id'),
    /** M3: permission policy (preset name or JSON policy; default at insert). */
    policy: text('policy'),
    forkedFrom: uuid('forked_from'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'string' }),
  },
  (t) => [
    check(
      'sessions_kind_workspace_check',
      sql`((kind is null and session_role is null and workspace_uri is not null) or (kind = 'chat' and session_role in ('main', 'side') and scope = 'personal' and scope_id is null) or (kind = 'work' and session_role = 'task' and workspace_uri is not null)) is true`,
    ),
    index('sessions_scope_idx').on(t.scope, t.scopeId),
    uniqueIndex('sessions_operation_key').on(t.tenantId, t.userId, t.creationOperationId),
    uniqueIndex('sessions_main_key')
      .on(t.tenantId, t.userId)
      .where(sql`session_role = 'main'`),
  ],
);

/**
 * Teams: tenant-scoped groups sharing one workspace directory
 * (`$WORKSPACE_ROOT/<team_id>`). A user may belong to many teams.
 */
export const teams = pgTable(
  'teams',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('teams_tenant_idx').on(t.tenantId)],
);

/** Team membership (M:N users ↔ teams). The creator joins as 'owner'. */
export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    index('team_members_user_idx').on(t.userId),
  ],
);

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

/**
 * Model token usage (docs/design.md §15 `model_usage`, §17 配额). Written by
 * the Agent Loop per model request; aggregated per tenant over calendar
 * windows for quota enforcement and cost reporting. Insert-only in practice
 * (a retention job may prune old rows — unlike `session_events` this table
 * is NOT append-only-critical, it is a metering projection).
 */
export const modelUsage = pgTable(
  'model_usage',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    model: text('model').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'bigint' }).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('model_usage_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('model_usage_session_idx').on(t.sessionId),
  ],
);

/** Scope stream; revisions are serialized per tenant/owner. */
export const memoryEvents = pgTable(
  'memory_events',
  {
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    operationId: uuid('operation_id').notNull(),
    memoryId: uuid('memory_id').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId, t.revision] }),
    uniqueIndex('memory_operation_key').on(t.tenantId, t.userId, t.operationId),
  ],
);

/** Rebuildable source projection. A terminal turn and its index commit in one transaction. */
export const conversationEpisodes = pgTable(
  'conversation_episodes',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    promptId: uuid('prompt_id').notNull(),
    payload: jsonb('payload').notNull(),
  },
  (t) => [
    uniqueIndex('episode_prompt_key').on(t.sessionId, t.promptId),
    index('episode_owner_page').on(t.tenantId, t.userId, t.id),
  ],
);

export const episodeChanges = pgTable('episode_changes', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  episodeId: text('episode_id').notNull(),
  payload: jsonb('payload').notNull(),
});
