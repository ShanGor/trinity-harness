import type { AuditPage, AuditQuery, AuditRecord, AuditStore } from '@trinity-harness/contracts';
import { auditRecordSchema } from '@trinity-harness/contracts';
import { and, count, desc, eq, type SQL } from 'drizzle-orm';

import type { Db } from './client.js';
import { auditLog } from './schema.js';

/**
 * PostgreSQL-backed {@link AuditStore} (docs/design.md §13). Written by the
 * audit consumer (at-least-once delivery → idempotent PK insert via
 * `ON CONFLICT DO NOTHING`).
 */
export class PgAuditStore implements AuditStore {
  constructor(private readonly db: Db) {}

  async insert(records: readonly AuditRecord[]): Promise<void> {
    if (records.length === 0) return;
    const parsed = records.map((r) => auditRecordSchema.parse(r));
    await this.db.transaction(async (tx) => {
      for (const record of parsed) {
        await tx
          .insert(auditLog)
          .values({
            id: record.id,
            tenantId: record.tenantId,
            userId: record.userId,
            sessionId: record.sessionId ?? null,
            action: record.action,
            target: record.target ?? null,
            result: record.result,
            detail: record.detail ?? null,
          })
          .onConflictDoNothing();
      }
    });
  }

  async query(q: AuditQuery): Promise<AuditPage> {
    const conditions: SQL[] = [eq(auditLog.tenantId, q.tenantId)];
    if (q.userId !== undefined) conditions.push(eq(auditLog.userId, q.userId));
    if (q.sessionId !== undefined) conditions.push(eq(auditLog.sessionId, q.sessionId));
    if (q.action !== undefined) conditions.push(eq(auditLog.action, q.action));
    const where = and(...conditions);

    const limit = Math.min(q.limit ?? 100, 1000);
    const offset = q.offset ?? 0;

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select()
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(auditLog).where(where),
    ]);

    return {
      records: rows.map((row) =>
        auditRecordSchema.parse({
          id: row.id,
          at: new Date(row.createdAt).toISOString(),
          tenantId: row.tenantId,
          userId: row.userId,
          ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
          action: row.action,
          ...(row.target !== null ? { target: row.target } : {}),
          result: row.result,
          ...(row.detail !== null ? { detail: row.detail } : {}),
        }),
      ),
      total: Number(totalRow?.total ?? 0),
    };
  }
}

/** Convenience for producers building a record (id/at filled here). */
export function newAuditRecord(input: Omit<AuditRecord, 'id' | 'at'>): AuditRecord {
  return { id: crypto.randomUUID(), at: new Date().toISOString(), ...input };
}
