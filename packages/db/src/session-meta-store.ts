import type {
  Identity,
  PermissionPolicy,
  SessionMeta,
  SessionMetaStore,
} from '@trinity-harness/contracts';
import { and, desc, eq, inArray, isNull, or, sql, getTableColumns } from 'drizzle-orm';

import type { Db } from './client.js';
import { sessions, teamMembers, sessionEvents } from './schema.js';
import { computeEventHash, GENESIS_HASH } from './session-store.js';
import { randomUUID } from 'node:crypto';

/** Default per-session permission policy (docs/design.md §12.1). */
export const DEFAULT_SESSION_POLICY = 'workspace-write';

function policyText(policy: PermissionPolicy | string): string {
  return typeof policy === 'string' ? policy : JSON.stringify(policy);
}

function toMeta(
  row: typeof sessions.$inferSelect & { taskState?: SessionMeta['taskState'] },
): SessionMeta {
  const meta: SessionMeta = {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    title: row.title,
    workspaceUri: row.workspaceUri,
    ...(row.kind ? { kind: row.kind as 'chat' | 'work' } : {}),
    ...(row.sessionRole ? { sessionRole: row.sessionRole as 'main' | 'side' | 'task' } : {}),
    ...(row.creationOperationId ? { creationOperationId: row.creationOperationId } : {}),
    ...(row.originSessionId ? { originSessionId: row.originSessionId } : {}),
    scope: (row.scope as 'personal' | 'team') ?? 'personal',
    ...(row.scopeId !== null ? { scopeId: row.scopeId } : {}),
    ...(row.policy !== null ? { policy: row.policy } : {}),
    createdAt: new Date(row.createdAt).toISOString(),
    ...(row.taskState ? { taskState: row.taskState } : {}),
  };
  if (row.closedAt) {
    meta.closedAt = new Date(row.closedAt).toISOString();
  }
  return meta;
}

/** PostgreSQL-backed {@link SessionMetaStore} (docs/design.md §15 `sessions`). */
export class PgSessionMetaStore implements SessionMetaStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(meta: Omit<SessionMeta, 'createdAt'>): Promise<void> {
    await this.db.insert(sessions).values({
      id: meta.id,
      tenantId: meta.tenantId,
      userId: meta.userId,
      title: meta.title,
      workspaceUri: meta.workspaceUri,
      kind: meta.kind,
      sessionRole: meta.sessionRole,
      creationOperationId: meta.creationOperationId,
      originSessionId: meta.originSessionId,
      scope: meta.scope ?? 'personal',
      scopeId: meta.scopeId ?? null,
      policy: meta.policy ?? DEFAULT_SESSION_POLICY,
      forkedFrom: meta.forkedFrom,
      closedAt: meta.closedAt ?? null,
    });
  }

  async findByOperation(
    tenantId: string,
    userId: string,
    operationId: string,
  ): Promise<SessionMeta | null> {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.tenantId, tenantId),
          eq(sessions.userId, userId),
          eq(sessions.creationOperationId, operationId),
        ),
      )
      .limit(1);
    return row ? toMeta(row) : null;
  }

  async getMain(tenantId: string, userId: string): Promise<SessionMeta | null> {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.tenantId, tenantId),
          eq(sessions.userId, userId),
          eq(sessions.sessionRole, 'main'),
        ),
      )
      .limit(1);
    return row ? toMeta(row) : null;
  }

  async get(sessionId: string): Promise<SessionMeta | null> {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    return row ? toMeta(row) : null;
  }

  async bindChatWorkspace(sessionId: string, workspaceUri: string): Promise<SessionMeta> {
    if (!workspaceUri.trim()) throw new Error('Chat workspace is required');
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${sessionId}))`);
      const [row] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .for('update');
      if (!row || row.closedAt || row.kind !== 'chat' || row.scope !== 'personal')
        throw new Error('Chat workspace unavailable');
      if (row.workspaceUri !== null) {
        if (row.workspaceUri !== workspaceUri) throw new Error('Chat workspace is immutable');
        return toMeta(row);
      }
      const [last] = await tx
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId))
        .orderBy(desc(sessionEvents.seq))
        .limit(1);
      if (!last) throw new Error('Chat creation event is required');
      const event = {
        type: 'session/workspace_bound' as const,
        eventId: randomUUID(),
        at: this.now().toISOString(),
        workspaceUri,
      };
      const seq = last.seq + 1n;
      await tx.insert(sessionEvents).values({
        sessionId,
        seq,
        type: event.type,
        payload: event,
        actor: 'system',
        prevHash: computeEventHash(sessionId, Number(seq), last.prevHash ?? GENESIS_HASH, event),
      });
      await tx.update(sessions).set({ workspaceUri }).where(eq(sessions.id, sessionId));
      return toMeta({ ...row, workspaceUri });
    });
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
            and(eq(sessions.userId, identity.userId), eq(sessions.scope, 'personal')),
            and(eq(sessions.scope, 'team'), inArray(sessions.scopeId, myTeamIds)),
          ),
    );
    const latest = sql`(select payload from ${sessionEvents} e where e.session_id = ${sessions.id} and e.type in ('message/user','turn/start','turn/end','approval/requested','approval/resolved') order by e.seq desc limit 1)`;
    const rows = await this.db
      .select({
        ...getTableColumns(sessions),
        taskState: sql<NonNullable<SessionMeta['taskState']>>`case
        when ${latest}->>'type' = 'message/user' then 'queued'
        when ${latest}->>'type' = 'approval/requested' then 'needs_approval'
        when ${latest}->>'type' in ('turn/start','approval/resolved') then 'running'
        when ${latest}->>'type' = 'turn/end' then case ${latest}->>'reason' when 'completed' then 'completed' when 'aborted' then 'cancelled' else 'failed' end
        else 'draft' end`,
      })
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
