import { z } from 'zod';

/**
 * Audit contracts (docs/design.md §13). Sensitive surfaces (login, session
 * creation, prompts, tool invocations) are published as `audit` bus events and
 * persisted by the independent audit consumer into `audit_log`. The bus
 * stream is a distribution layer; `audit_log` (PG) is the queryable truth.
 */

export const auditRecordSchema = z.object({
  id: z.uuid(),
  /** ISO-8601 UTC. */
  at: z.iso.datetime(),
  tenantId: z.uuid(),
  /** 'system' for unauthenticated/system actions (e.g. failed logins). */
  userId: z.string().min(1),
  sessionId: z.uuid().optional(),
  /** Dotted action, e.g. 'auth/login', 'session/prompt', 'tool/call'. */
  action: z.string().min(1),
  /** Free-form target hint (e.g. tool name, session title). Bounded. */
  target: z.string().max(500).optional(),
  result: z.enum(['ok', 'denied', 'error']),
  /** Redacted JSON detail (AGENTS.md §5: no secrets, bounded size). */
  detail: z.unknown().optional(),
});
export type AuditRecord = z.infer<typeof auditRecordSchema>;

export interface AuditQuery {
  tenantId: string;
  userId?: string | undefined;
  sessionId?: string | undefined;
  action?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface AuditPage {
  records: AuditRecord[];
  total: number;
}

/** Audit write side — implemented by packages/db, fed by the consumer. */
export interface AuditStore {
  insert(records: readonly AuditRecord[]): Promise<void>;
  query(q: AuditQuery): Promise<AuditPage>;
}

/**
 * Fire-and-forget audit emission surface for producers (server, worker).
 * Implementations publish onto the `audit` stream of the EventBus; losing an
 * audit event must never break the user-facing flow, hence `void` semantics.
 */
export interface AuditEmitter {
  emit(record: AuditRecord): void;
}
