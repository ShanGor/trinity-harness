import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import {
  scheduleCreateSchema,
  scheduleDefinitionSchema,
  scheduleRecordSchema,
  inboxItemSchema,
  nextScheduleInstant,
  scheduledRequest,
  reviewWithinCatchupWindow,
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
      .where(
        sql`${scheduleOccurrences.id} = (
          select (q.payload->'trigger'->>'occurrenceId')::uuid from ${sessionEvents} q
          where q.session_id = ${sessionId} and q.type = 'prompt/queued'
          and q.payload->'trigger'->>'kind' = 'schedule' limit 1
        )`,
      )
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
      target.userId !== actor ||
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
          reviewCatchupInitialized: true,
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
        .set({
          enabled,
          revision: revision + 1,
          nextFireAt: next?.toISOString() ?? null,
          reviewCatchupInitialized: true,
        })
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
        attempts: row.attempts,
        retryAt: row.retryAt ? new Date(row.retryAt).toISOString() : null,
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
      reason='outcome', read_at=null,
      retry_at=case when e.type='turn/end' and e.payload->>'reason'='error' and o.attempts < 3
        and exists (select 1 from assistant_schedules s where s.id=o.schedule_id and s.definition->>'consolidation'='review')
        and not exists (select 1 from session_events call where call.session_id=o.session_id and call.type='tool/call' and call.payload->>'name' is distinct from 'recall')
        then (e.payload->>'at')::timestamptz + interval '5 minutes' * greatest(1, o.attempts) else null end
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
            sql`(${assistantSchedules.definition}->>'consolidation' is distinct from 'review' or not exists (
              select 1 from ${scheduleOccurrences} active where active.schedule_id = ${assistantSchedules.id} and active.status = 'queued'
            ))`,
            sql`(${assistantSchedules.definition}->>'consolidation' is distinct from 'review' or not exists (
              select 1 from ${scheduleOccurrences} waiting where waiting.schedule_id = ${assistantSchedules.id}
              and waiting.revision = ${assistantSchedules.revision} and waiting.scheduled_at = ${assistantSchedules.nextFireAt}
              and waiting.status = 'failed' and waiting.retry_at > ${at.toISOString()}
            ))`,
            sql`(${assistantSchedules.nextFireAt} <= ${at.toISOString()} or
              (${assistantSchedules.definition}->>'consolidation' = 'review' and not ${assistantSchedules.reviewCatchupInitialized}))`,
          ),
        )
        .orderBy(assistantSchedules.nextFireAt)
        .limit(50)
        .for('update', { skipLocked: true });
      for (const schedule of due) {
        signal?.throwIfAborted();
        const definition = scheduleDefinitionSchema.parse(schedule.definition);
        const review = definition.consolidation === 'review';
        let scheduledAt = new Date(schedule.nextFireAt!);
        // One-time migration recovery can discover dates skipped by the old scheduler.
        // Resumed revisions deliberately start at their recorded future instant.
        if (review && !schedule.reviewCatchupInitialized && schedule.revision === 1) {
          scheduledAt =
            nextScheduleInstant(definition, new Date(schedule.createdAt)) ?? scheduledAt;
        }
        const advance = async (after: Date): Promise<void> => {
          const next = nextScheduleInstant(definition, after);
          await tx
            .update(assistantSchedules)
            .set({
              nextFireAt: next?.toISOString() ?? null,
              enabled: !!next,
              reviewCatchupInitialized: true,
            })
            .where(eq(assistantSchedules.id, schedule.id));
        };
        if (scheduledAt > at) {
          await tx
            .update(assistantSchedules)
            .set({ reviewCatchupInitialized: true })
            .where(eq(assistantSchedules.id, schedule.id));
          continue;
        }
        const [previous] = await tx
          .select()
          .from(scheduleOccurrences)
          .where(
            and(
              eq(scheduleOccurrences.scheduleId, schedule.id),
              eq(scheduleOccurrences.revision, schedule.revision),
              eq(scheduleOccurrences.scheduledAt, scheduledAt.toISOString()),
            ),
          )
          .limit(1);
        if (review && previous?.status === 'queued') continue;
        if (review && (previous?.status === 'completed' || previous?.status === 'cancelled')) {
          await advance(scheduledAt);
          continue;
        }
        const attempt = Math.max(previous?.attempts ?? 0, previous?.sessionId ? 1 : 0) + 1;
        if (review && previous?.status === 'failed') {
          // Never rerun uncertain effects. Only pure recall-only failures can start a fresh attempt.
          const [effect] = previous.sessionId
            ? await tx
                .select({ seq: sessionEvents.seq })
                .from(sessionEvents)
                .where(
                  and(
                    eq(sessionEvents.sessionId, previous.sessionId),
                    eq(sessionEvents.type, 'tool/call'),
                    sql`${sessionEvents.payload}->>'name' is distinct from 'recall'`,
                  ),
                )
                .limit(1)
            : [];
          if (attempt > 3 || effect || !previous.retryAt) {
            await tx
              .update(scheduleOccurrences)
              .set({ retryAt: null })
              .where(eq(scheduleOccurrences.id, previous.id));
            await advance(scheduledAt);
            continue;
          }
          if (new Date(previous.retryAt) > at) continue;
        }
        // Expired history gets one visible gap marker, then jump into the bounded window.
        const expired = review && !reviewWithinCatchupWindow(definition, scheduledAt, at);
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

        if (review && previous?.status === 'failed' && previous.sessionId && allowed) {
          const [original] = await tx
            .select()
            .from(sessions)
            .where(eq(sessions.id, previous.sessionId))
            .limit(1);
          if (
            !original ||
            original.closedAt ||
            original.workspaceUri !== source.workspaceUri ||
            original.userId !== source.userId ||
            original.tenantId !== source.tenantId ||
            original.policy !==
              JSON.stringify(parsePermissionPolicy(source.policy ?? 'workspace-write'))
          ) {
            await tx
              .update(scheduleOccurrences)
              .set({ retryAt: null, reason: 'access_revoked', readAt: null })
              .where(eq(scheduleOccurrences.id, previous.id));
            await tx
              .update(assistantSchedules)
              .set({ enabled: false, reviewCatchupInitialized: true })
              .where(eq(assistantSchedules.id, schedule.id));
            continue;
          }
        }
        // Reviews wait for active runs rather than losing a calendar day to overlap.
        if (review && active && allowed) continue;
        // Ordinary schedules retain their existing one-minute grace and skip policy.
        const reason = !allowed
          ? 'access_revoked'
          : expired
            ? 'expired'
            : !review && at.getTime() - scheduledAt.getTime() > 60_000
              ? 'missed'
              : active
                ? 'overlap'
                : 'due';
        const id = review && previous ? previous.id : randomUUID(),
          sessionId = randomUUID(),
          promptId = randomUUID();
        const values = {
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
          attempts: reason === 'due' ? attempt : (previous?.attempts ?? 0),
          retryAt: null,
          readAt: null,
        };
        // The schedule row lock serializes retries and competing control workers.
        const [inserted] =
          review && previous
            ? await tx
                .update(scheduleOccurrences)
                .set(values)
                .where(eq(scheduleOccurrences.id, previous.id))
                .returning()
            : await tx.insert(scheduleOccurrences).values(values).onConflictDoNothing().returning();
        if (inserted && reason === 'due' && source) {
          const policy = parsePermissionPolicy(source.policy ?? 'workspace-write');
          await tx.insert(sessions).values({
            id: sessionId,
            tenantId: schedule.tenantId,
            userId: schedule.userId,
            title: definition.title,
            workspaceUri: source.workspaceUri,
            kind: 'work',
            sessionRole: 'task',
            creationOperationId: attempt > 1 ? promptId : id,
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
              creationOperationId: attempt > 1 ? promptId : id,
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
              content: [{ kind: 'text', text: scheduledRequest(definition, scheduledAt) }],
              trigger: {
                kind: 'schedule',
                ...(definition.consolidation
                  ? { consolidation: definition.consolidation, attempt }
                  : {}),
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
            await tx.insert(sessionEvents).values({
              sessionId,
              seq: BigInt(index + 1),
              type: event.type,
              payload: event,
              actor: schedule.userId,
              prevHash: hash,
            });
          }
        }
        // Keep the review cursor on its day until a durable terminal result is reconciled.
        if (review && reason === 'due') {
          await tx
            .update(assistantSchedules)
            .set({ nextFireAt: scheduledAt.toISOString(), reviewCatchupInitialized: true })
            .where(eq(assistantSchedules.id, schedule.id));
          continue;
        }
        if (review && expired && allowed) {
          let oldest = nextScheduleInstant(definition, new Date(at.getTime() - 8 * 86_400_000));
          while (oldest && oldest <= at && !reviewWithinCatchupWindow(definition, oldest, at)) {
            oldest = nextScheduleInstant(definition, oldest);
          }
          await tx
            .update(assistantSchedules)
            .set({
              nextFireAt: oldest?.toISOString() ?? null,
              enabled: !!oldest,
              reviewCatchupInitialized: true,
            })
            .where(eq(assistantSchedules.id, schedule.id));
          continue;
        }
        const next = nextScheduleInstant(definition, review ? scheduledAt : at);
        await tx
          .update(assistantSchedules)
          .set({
            nextFireAt: next?.toISOString() ?? null,
            enabled: !!next && !!allowed,
            reviewCatchupInitialized: true,
          })
          .where(eq(assistantSchedules.id, schedule.id));
      }
    });
  }
}
