import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import {
  scheduleCreateSchema,
  scheduleDefinitionSchema,
  scheduleRecordSchema,
  inboxItemSchema,
  nextScheduleInstant,
  parsePermissionPolicy,
  sessionEventSchema,
  type Identity,
  type ScheduleCreate,
  type ScheduleRecord,
  type ScheduleStore,
  type InboxItem,
  type SessionEvent,
} from '@trinity-harness/contracts';
import type { Db } from './client.js';
import {
  assistantSchedules,
  scheduleOccurrences,
  sessions,
  sessionEvents,
  users,
} from './schema.js';
import { computeEventHash, GENESIS_HASH } from './session-store.js';

function record(row: typeof assistantSchedules.$inferSelect): ScheduleRecord {
  return scheduleRecordSchema.parse({
    ...scheduleDefinitionSchema.parse(row.definition),
    id: row.id,
    revision: row.revision,
    enabled: row.enabled,
    nextFireAt: row.nextFireAt ? new Date(row.nextFireAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
  });
}
function owned(identity: Identity) {
  return and(
    eq(assistantSchedules.tenantId, identity.tenantId),
    eq(assistantSchedules.userId, identity.userId),
  );
}

/** Due occurrences and queued user-delegated work commit in one PG transaction. */
export class PgScheduleStore implements ScheduleStore {
  constructor(private readonly db: Db) {}
  async assertRunAuthorized(sessionId: string, actor: string): Promise<void> {
    const [run] = await this.db
      .select({ occurrence: scheduleOccurrences, schedule: assistantSchedules })
      .from(scheduleOccurrences)
      .innerJoin(assistantSchedules, eq(assistantSchedules.id, scheduleOccurrences.scheduleId))
      .where(eq(scheduleOccurrences.sessionId, sessionId))
      .limit(1);
    if (!run) return;
    const definition = scheduleDefinitionSchema.parse(run.schedule.definition);
    const [source] = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, definition.sourceSessionId));
    const [target] = await this.db.select().from(sessions).where(eq(sessions.id, sessionId));
    const [owner] = await this.db.select().from(users).where(eq(users.id, actor));
    if (
      !source ||
      !target ||
      !owner ||
      owner.role === 'viewer' ||
      source.closedAt ||
      target.closedAt ||
      source.userId !== actor ||
      run.occurrence.userId !== actor ||
      source.tenantId !== owner.tenantId ||
      source.tenantId !== target.tenantId ||
      source.workspaceUri !== target.workspaceUri ||
      JSON.stringify(parsePermissionPolicy(source.policy ?? 'workspace-write')) !== target.policy
    )
      throw new Error('Scheduled execution authorization changed');
  }
  async list(identity: Identity): Promise<ScheduleRecord[]> {
    return (
      await this.db
        .select()
        .from(assistantSchedules)
        .where(owned(identity))
        .orderBy(desc(assistantSchedules.createdAt))
        .limit(200)
    ).map(record);
  }
  async create(identity: Identity, raw: ScheduleCreate, at: Date): Promise<ScheduleRecord> {
    if (identity.role === 'viewer') throw new Error('Schedule permission denied');
    const input = scheduleCreateSchema.parse(raw);
    const { operationId, ...definition } = input;
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${identity.userId}, 2394))`,
      );
      const [previous] = await tx
        .select()
        .from(assistantSchedules)
        .where(and(owned(identity), eq(assistantSchedules.operationId, operationId)));
      if (previous) {
        if (
          JSON.stringify(scheduleDefinitionSchema.parse(previous.definition)) !==
          JSON.stringify(definition)
        )
          throw new Error('Schedule operation conflict');
        return record(previous);
      }
      const [source] = await tx
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.id, definition.sourceSessionId),
            eq(sessions.tenantId, identity.tenantId),
            eq(sessions.userId, identity.userId),
          ),
        );
      const [owner] = await tx
        .select()
        .from(users)
        .where(and(eq(users.id, identity.userId), eq(users.tenantId, identity.tenantId)));
      if (
        !source ||
        source.closedAt ||
        source.kind !== 'work' ||
        source.scope !== 'personal' ||
        !source.workspaceUri ||
        !owner ||
        owner.role === 'viewer'
      )
        throw new Error('An owned personal Work session is required');
      const count = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(assistantSchedules)
        .where(owned(identity));
      if ((count[0]?.n ?? 0) >= 200) throw new Error('Schedule limit reached');
      const next = nextScheduleInstant(definition, at);
      if (!next) throw new Error('Schedule must have a future occurrence');
      const [saved] = await tx
        .insert(assistantSchedules)
        .values({
          id: randomUUID(),
          tenantId: identity.tenantId,
          userId: identity.userId,
          operationId,
          revision: 1,
          definition,
          enabled: true,
          nextFireAt: next.toISOString(),
          createdAt: at.toISOString(),
        })
        .returning();
      return record(saved!);
    });
  }
  async setEnabled(
    identity: Identity,
    id: string,
    revision: number,
    enabled: boolean,
    at: Date,
  ): Promise<ScheduleRecord | null> {
    if (identity.role === 'viewer') throw new Error('Schedule permission denied');
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(assistantSchedules)
        .where(and(owned(identity), eq(assistantSchedules.id, id)))
        .for('update');
      if (!current || current.revision !== revision) return null;
      const next = enabled
        ? nextScheduleInstant(scheduleDefinitionSchema.parse(current.definition), at)
        : null;
      if (enabled && !next) throw new Error('No future occurrence');
      const [updated] = await tx
        .update(assistantSchedules)
        .set({ enabled, revision: revision + 1, nextFireAt: next?.toISOString() ?? null })
        .where(eq(assistantSchedules.id, id))
        .returning();
      return record(updated!);
    });
  }
  async inbox(identity: Identity): Promise<InboxItem[]> {
    return (
      await this.db
        .select()
        .from(scheduleOccurrences)
        .where(
          and(
            eq(scheduleOccurrences.tenantId, identity.tenantId),
            eq(scheduleOccurrences.userId, identity.userId),
          ),
        )
        .orderBy(desc(scheduleOccurrences.scheduledAt))
        .limit(100)
    ).map((row) =>
      inboxItemSchema.parse({
        id: row.id,
        scheduleId: row.scheduleId,
        title: row.title,
        status: row.status,
        reason: row.reason,
        sessionId: row.sessionId,
        at: new Date(row.scheduledAt).toISOString(),
        readAt: row.readAt ? new Date(row.readAt).toISOString() : null,
      }),
    );
  }
  async acknowledge(identity: Identity, id: string, at: Date): Promise<void> {
    await this.db
      .update(scheduleOccurrences)
      .set({ readAt: at.toISOString() })
      .where(
        and(
          eq(scheduleOccurrences.id, id),
          eq(scheduleOccurrences.tenantId, identity.tenantId),
          eq(scheduleOccurrences.userId, identity.userId),
        ),
      );
  }
  async tick(at: Date, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    // Reconcile outcomes independently of queue retention or worker availability.
    await this.db.execute(sql`update schedule_occurrences o set status=case
      when e.type='prompt/discarded' or e.payload->>'reason'='aborted' then 'cancelled'
      when e.payload->>'reason'='completed' then 'completed' else 'failed' end,
      reason='outcome', read_at=null
      from session_events e where o.status='queued' and e.session_id=o.session_id
      and e.type in ('turn/end','prompt/discarded') and e.payload->>'promptId'=o.prompt_id::text`);
    await this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(assistantSchedules)
        .where(
          and(
            eq(assistantSchedules.enabled, true),
            isNotNull(assistantSchedules.nextFireAt),
            lte(assistantSchedules.nextFireAt, at.toISOString()),
          ),
        )
        .orderBy(assistantSchedules.nextFireAt)
        .limit(50)
        .for('update', { skipLocked: true });
      for (const schedule of due) {
        signal?.throwIfAborted();
        const definition = scheduleDefinitionSchema.parse(schedule.definition);
        const scheduledAt = new Date(schedule.nextFireAt!);
        const [source] = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, definition.sourceSessionId))
          .for('share');
        const [owner] = await tx
          .select()
          .from(users)
          .where(eq(users.id, schedule.userId))
          .for('share');
        const [active] = await tx
          .select({ id: scheduleOccurrences.id })
          .from(scheduleOccurrences)
          .where(
            and(
              eq(scheduleOccurrences.scheduleId, schedule.id),
              eq(scheduleOccurrences.status, 'queued'),
            ),
          )
          .limit(1);
        const allowed =
          source &&
          owner &&
          !source.closedAt &&
          source.workspaceUri &&
          source.scope === 'personal' &&
          source.userId === schedule.userId &&
          source.tenantId === schedule.tenantId &&
          owner.tenantId === schedule.tenantId &&
          owner.role !== 'viewer';
        // One scheduler cadence of grace; downtime does not silently replay a backlog.
        const reason = !allowed
          ? 'access_revoked'
          : at.getTime() - scheduledAt.getTime() > 60_000
            ? 'missed'
            : active
              ? 'overlap'
              : 'due';
        const id = randomUUID(),
          sessionId = randomUUID(),
          promptId = randomUUID();
        const [inserted] = await tx
          .insert(scheduleOccurrences)
          .values({
            id,
            scheduleId: schedule.id,
            revision: schedule.revision,
            tenantId: schedule.tenantId,
            userId: schedule.userId,
            scheduledAt: scheduledAt.toISOString(),
            title: definition.title,
            sessionId: reason === 'due' ? sessionId : null,
            promptId: reason === 'due' ? promptId : null,
            status: reason === 'due' ? 'queued' : 'skipped',
            reason,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted && reason === 'due' && source) {
          const policy = parsePermissionPolicy(source.policy ?? 'workspace-write');
          await tx
            .insert(sessions)
            .values({
              id: sessionId,
              tenantId: schedule.tenantId,
              userId: schedule.userId,
              title: definition.title,
              workspaceUri: source.workspaceUri,
              kind: 'work',
              sessionRole: 'task',
              creationOperationId: id,
              originSessionId: source.id,
              scope: 'personal',
              policy: JSON.stringify(policy),
            });
          const events: SessionEvent[] = [
            {
              type: 'session/created',
              eventId: randomUUID(),
              at: at.toISOString(),
              workspaceUri: source.workspaceUri,
              kind: 'work',
              sessionRole: 'task',
              creationOperationId: id,
              originSessionId: source.id,
            },
            {
              type: 'prompt/queued',
              eventId: randomUUID(),
              promptId,
              at: at.toISOString(),
              actor: owner!.id,
              tenantId: schedule.tenantId,
              policy,
              content: [{ kind: 'text', text: definition.request }],
              trigger: {
                kind: 'schedule',
                scheduleId: schedule.id,
                revision: schedule.revision,
                occurrenceId: id,
                scheduledAt: scheduledAt.toISOString(),
              },
            },
          ];
          // Same append lock, sequence, schema and hash semantics as SessionStore.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${sessionId}))`);
          let hash = GENESIS_HASH;
          for (const [index, raw] of events.entries()) {
            const event = sessionEventSchema.parse(raw);
            hash = computeEventHash(sessionId, index + 1, hash, event);
            await tx
              .insert(sessionEvents)
              .values({
                sessionId,
                seq: BigInt(index + 1),
                type: event.type,
                payload: event,
                actor: schedule.userId,
                prevHash: hash,
              });
          }
        }
        const next = nextScheduleInstant(definition, at);
        await tx
          .update(assistantSchedules)
          .set({ nextFireAt: next?.toISOString() ?? null, enabled: !!next && !!allowed })
          .where(eq(assistantSchedules.id, schedule.id));
      }
    });
  }
}
