import type {
  Identity,
  PermissionPolicy,
  SessionMeta,
  SessionMetaStore,
} from '@trinity-harness/contracts';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';

import type { Db } from './client.js';
import { sessions, teamMembers } from './schema.js';

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
    scope: (row.scope as 'personal' | 'team') ?? 'personal',
    ...(row.scopeId !== null ? { scopeId: row.scopeId } : {}),
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
      scope: meta.scope ?? 'personal',
      scopeId: meta.scopeId ?? null,
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
    // Team sessions are visible to every member of the team (shared space);
    // everything else is own-sessions-only. Admin sees the whole tenant.
    const myTeamIds = this.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, identity.userId));
    const where = and(
      eq(sessions.tenantId, identity.tenantId),
      isNull(sessions.closedAt),
      identity.role === 'admin'
        ? undefined
        : or(
            eq(sessions.userId, identity.userId),
            and(eq(sessions.scope, 'team'), inArray(sessions.scopeId, myTeamIds)),
          ),
    );
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

  async setTitleIfEmpty(sessionId: string, title: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ title })
      .where(and(eq(sessions.id, sessionId), eq(sessions.title, ''), isNull(sessions.closedAt)));
  }

  async close(sessionId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ closedAt: new Date().toISOString() })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.closedAt)));
  }
}
