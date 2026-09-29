import type { ApprovalRecord, ApprovalStore } from '@trinity-harness/contracts';
import { and, desc, eq, isNull } from 'drizzle-orm';

import type { Db } from './client.js';
import { approvals } from './schema.js';

/**
 * PostgreSQL-backed {@link ApprovalStore} (docs/design.md §12.2, §15).
 * Both writes are idempotent: the consumer/worker may retry after a crash
 * without double-recording a decision (first writer wins on resolve).
 */
export class PgApprovalStore implements ApprovalStore {
  constructor(private readonly db: Db) {}

  async request(record: ApprovalRecord): Promise<void> {
    await this.db
      .insert(approvals)
      .values({
        id: record.id,
        sessionId: record.sessionId,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        argsPreview: record.argsPreview,
        outcome: record.outcome,
        decidedBy: record.decidedBy,
        createdAt: record.createdAt,
        decidedAt: record.decidedAt,
      })
      .onConflictDoNothing();
  }

  async resolve(id: string, outcome: 'allowed' | 'rejected', decidedBy: string): Promise<void> {
    // First writer wins: rows already decided keep their original outcome —
    // concurrent replies (web + acp-gateway) must not flip a decision.
    await this.db
      .update(approvals)
      .set({
        outcome,
        decidedBy,
        decidedAt: new Date().toISOString(),
      })
      .where(and(eq(approvals.id, id), isNull(approvals.outcome)));
  }

  async list(sessionId: string, limit = 100): Promise<ApprovalRecord[]> {
    const rows = await this.db
      .select()
      .from(approvals)
      .where(eq(approvals.sessionId, sessionId))
      .orderBy(desc(approvals.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      argsPreview: row.argsPreview,
      outcome: (row.outcome as ApprovalRecord['outcome']) ?? null,
      decidedBy: row.decidedBy,
      createdAt: new Date(row.createdAt).toISOString(),
      decidedAt: row.decidedAt ? new Date(row.decidedAt).toISOString() : null,
    }));
  }
}
