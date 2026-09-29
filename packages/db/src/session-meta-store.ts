import type {
  Identity,
  PermissionPolicy,
  SessionMeta,
  SessionMetaStore,
} from '@trinity-harness/contracts';
import { and, desc, eq } from 'drizzle-orm';

import type { Db } from './client.js';
import { sessions } from './schema.js';

/** Default per-session permission policy (docs/design.md §12.1). */
export const DEFAULT_SESSION_POLICY = 'workspace-write';

function policyText(policy: PermissionPolicy | string): string {
  return typeof policy === 'string' ? policy : JSON.stringify(policy);
}

function toMeta(row: typeof sessions.$inferSelect): SessionMeta {
  const meta: SessionMeta = {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    title: row.title,
    workspaceUri: row.workspaceUri,
    ...(row.policy !== null ? { policy: row.policy } : {}),
    createdAt: new Date(row.createdAt).toISOString(),
  };
  if (row.closedAt) {
    meta.closedAt = new Date(row.closedAt).toISOString();
  }
  return meta;
}

/** PostgreSQL-backed {@link SessionMetaStore} (docs/design.md §15 `sessions`). */
export class PgSessionMetaStore implements SessionMetaStore {
  constructor(private readonly db: Db) {}

  async create(meta: Omit<SessionMeta, 'createdAt'>): Promise<void> {
    await this.db.insert(sessions).values({
      id: meta.id,
      tenantId: meta.tenantId,
      userId: meta.userId,
      title: meta.title,
      workspaceUri: meta.workspaceUri,
      policy: meta.policy ?? DEFAULT_SESSION_POLICY,
      forkedFrom: meta.forkedFrom,
      closedAt: meta.closedAt ?? null,
    });
  }

  async get(sessionId: string): Promise<SessionMeta | null> {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    return row ? toMeta(row) : null;
  }

  async listForIdentity(identity: Identity): Promise<SessionMeta[]> {
    const where =
      identity.role === 'admin'
        ? eq(sessions.tenantId, identity.tenantId)
        : and(eq(sessions.tenantId, identity.tenantId), eq(sessions.userId, identity.userId));
    const rows = await this.db
      .select()
      .from(sessions)
      .where(where)
      .orderBy(desc(sessions.createdAt));
    return rows.map(toMeta);
  }

  async setPolicy(sessionId: string, policy: PermissionPolicy | string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ policy: policyText(policy) })
      .where(eq(sessions.id, sessionId));
  }
}
