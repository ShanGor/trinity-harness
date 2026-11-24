import { isDeepStrictEqual } from 'node:util';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  newFactSchema,
  revisionFenceSchema,
  candidateSubmissionSchema,
  candidateDecisionSchema,
  factInvalidationSchema,
  evolutionPageQuerySchema,
  memoryFactSchema,
  memoryCandidateSchema,
  playbookSchema,
  sessionEventSchema,
  removedPromptIds,
  topicEpisodeSchema,
  recallResultSchema,
  scheduleDefinitionSchema,
  memoryProposalParametersSchema,
  validateMemoryCommand,
  type MemoryEvolutionStorePort,
  type Identity,
  type MemoryFact,
  type Playbook,
  type CandidateSubmission,
  type CandidateDecision,
  type FactInvalidation,
  type EvolutionPageQuery,
  type MemoryEvolutionPage,
  type NewFact,
  type RevisionFence,
  type MemoryCandidate,
  type ConsolidationJournal,
} from '@trinity-harness/contracts';
import type { Db } from './client.js';
import {
  memoryEvolutionOwners as owners,
  memoryFacts as facts,
  memoryFactEvents as factEvents,
  memoryCandidates as candidates,
  memoryCandidateEvents as candidateEvents,
  memoryPlaybooks as playbooks,
  memoryPlaybookEvents as playbookEvents,
  memoryEvents,
  userPersonas,
  sessions,
  sessionEvents,
  conversationEpisodes,
  episodeChanges,
  assistantSchedules,
  scheduleOccurrences,
} from './schema.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Source = NewFact['source'];
const scope = (
  t: { tenantId: AnyPgColumn; userId: AnyPgColumn },
  owner: Identity,
): ReturnType<typeof and> => and(eq(t.tenantId, owner.tenantId), eq(t.userId, owner.userId));
function fail(code = 'MEMORY_SOURCE_UNAVAILABLE'): never {
  throw Object.assign(
    new Error(
      code === 'MEMORY_CONFLICT'
        ? 'Memory changed; refresh before editing.'
        : 'Memory source or authorization is unavailable.',
    ),
    { code },
  );
}
function safeFailure(error: unknown): never {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('MEMORY_')
  )
    throw error;
  throw Object.assign(new Error('Durable memory is unavailable.'), { code: 'MEMORY_UNAVAILABLE' });
}
function unquoted(text: string): string {
  // Preserve boundaries: deleting quoted spans can manufacture an exact-looking quote.
  return text
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`]*`|"[^"]*"|“[^”]*”|「[^」]*」/g, '\0')
    .split('\n')
    .map((line) => (/^\s*>/.test(line) ? '\0' : line))
    .join('\n');
}

async function policy(
  tx: Tx | Db,
  owner: Identity,
): Promise<{ revision: number; floor: number; autoSave: boolean }> {
  const [persona] = await tx.select().from(userPersonas).where(scope(userPersonas, owner));
  const [last] = await tx
    .select()
    .from(memoryEvents)
    .where(scope(memoryEvents, owner))
    .orderBy(desc(memoryEvents.revision))
    .limit(1);
  const legacy = last?.revision ?? 0;
  // Without a Persona, legacy corrections conservatively suppress prior generations.
  const legacyRows = persona
    ? []
    : await tx
        .select()
        .from(memoryEvents)
        .where(
          and(
            scope(memoryEvents, owner),
            sql`((${memoryEvents.payload}->>'revision')::bigint > 1 or ${memoryEvents.payload}->>'status' = 'forgotten')`,
          ),
        )
        .limit(1);
  const suppressed = legacyRows.length > 0;
  return {
    revision: legacy + (persona?.revision ?? 0),
    floor: persona?.suppressionRevision ?? (suppressed ? legacy : 0),
    autoSave: persona?.autoSaveEnabled !== false,
  };
}

/** Filter derived sources before ordering/limiting; repeat exact provenance after the read. */
function sourceFence(
  source: ReturnType<typeof sql>,
  owner: Identity,
  floor: number,
): ReturnType<typeof sql> {
  return sql`exists (select 1 from conversation_episodes e join sessions s on s.id = e.session_id
    where e.tenant_id = ${owner.tenantId} and e.user_id = ${owner.userId}
    and s.tenant_id = e.tenant_id and s.user_id = e.user_id and s.scope = 'personal' and s.closed_at is null
    and e.payload->>'episodeId' = (${source})->>'sourceEpisodeId'
    and e.payload->>'promptId' = (${source})->>'sourceEventId'
    and e.session_id::text = (${source})->>'sourceSessionId'
    and coalesce((e.payload->>'policyRevision')::bigint, 0) >= ${floor}
    and not coalesce((e.payload->>'excluded')::boolean, false)
    and not coalesce((select (c.payload->>'excluded')::boolean from episode_changes c where c.tenant_id = e.tenant_id and c.user_id = e.user_id and c.episode_id = e.payload->>'episodeId' order by c.id desc limit 1), false)
    and not exists (select 1 from session_events r where r.session_id = e.session_id and r.type = 'message/removed' and r.payload->>'promptId' = e.payload->>'promptId'))`;
}

/** Runs under source/session + episode + owner locks for writes, with a second policy fence for reads. */
async function sourceAllowed(
  tx: Tx | Db,
  owner: Identity,
  source: Source,
  floor: number,
): Promise<boolean> {
  const [session] = await tx
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.id, source.sourceSessionId),
        scope(sessions, owner),
        eq(sessions.scope, 'personal'),
      ),
    );
  if (!session || session.closedAt) return false;
  const rows = await tx
    .select({ payload: sessionEvents.payload })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.sessionId, source.sourceSessionId),
        sql`(${sessionEvents.payload}->>'eventId' = ${source.sourceEventId} or (${sessionEvents.type} = 'message/removed' and ${sessionEvents.payload}->>'promptId' = ${source.sourceEventId}))`,
      ),
    )
    .limit(3);
  const events = rows.map((r) => sessionEventSchema.parse(r.payload));
  const event = events.find((e) => e.eventId === source.sourceEventId);
  if (
    event?.type !== 'message/user' ||
    event.trigger ||
    removedPromptIds(events).has(event.eventId) ||
    !unquoted(
      event.content.flatMap((b) => (b.kind === 'text' ? [b.text] : [])).join('\n'),
    ).includes(source.sourceQuote)
  )
    return false;
  const [row] = await tx
    .select()
    .from(conversationEpisodes)
    .where(
      and(
        scope(conversationEpisodes, owner),
        eq(conversationEpisodes.sessionId, source.sourceSessionId),
        sql`${conversationEpisodes.payload}->>'episodeId' = ${source.sourceEpisodeId}`,
      ),
    );
  if (!row) return false;
  const episode = topicEpisodeSchema.parse(row.payload);
  const [change] = await tx
    .select()
    .from(episodeChanges)
    .where(and(scope(episodeChanges, owner), eq(episodeChanges.episodeId, source.sourceEpisodeId)))
    .orderBy(desc(episodeChanges.id))
    .limit(1);
  const excluded = change
    ? z.object({ excluded: z.boolean().optional() }).parse(change.payload).excluded
    : episode.excluded;
  return (
    !episode.excluded &&
    !excluded &&
    episode.promptId === source.sourceEventId &&
    episode.policyRevision >= floor
  );
}
async function locks(
  tx: Tx,
  owner: Identity,
  sources: Source[],
  journal?: ConsolidationJournal,
): Promise<void> {
  for (const id of [
    ...new Set([...sources.map((s) => s.sourceSessionId), ...(journal ? [journal.sessionId] : [])]),
  ].sort())
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
  for (const id of [...new Set(sources.map((s) => s.sourceEpisodeId))].sort())
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`episode:${owner.tenantId}:${owner.userId}:${id}`}))`,
    );
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`memory:${owner.tenantId}:${owner.userId}`}))`,
  );
}
async function currentRevision(tx: Tx | Db, owner: Identity): Promise<number> {
  const [row] = await tx.select().from(owners).where(scope(owners, owner));
  return row?.revision ?? 0;
}
async function advance(tx: Tx, owner: Identity, revision: number): Promise<void> {
  await tx
    .insert(owners)
    .values({ tenantId: owner.tenantId, userId: owner.userId, revision })
    .onConflictDoUpdate({ target: [owners.tenantId, owners.userId], set: { revision } });
}
function draftSources(draft: CandidateSubmission['draft']): Source[] {
  return draft.type === 'fact' ? [draft.fact.source] : draft.playbook.sources;
}
async function auditConsolidation(
  tx: Tx,
  owner: Identity,
  command: CandidateSubmission,
): Promise<void> {
  const { journal, draft } = command;
  const [origin] = await tx
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.id, journal.sessionId),
        scope(sessions, owner),
        eq(sessions.scope, 'personal'),
      ),
    );
  if (!origin || origin.closedAt) fail();
  const events = (
    await tx
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, journal.sessionId))
      .orderBy(sessionEvents.seq)
  ).map((r) => sessionEventSchema.parse(r.payload));
  const start = events.findIndex((e) => e.eventId === journal.promptId);
  const prompt = events[start];
  if (
    prompt?.type !== 'message/user' ||
    prompt.trigger?.consolidation !== 'memory' ||
    removedPromptIds(events).has(prompt.eventId)
  )
    fail();
  const [run] = await tx
    .select({ definition: assistantSchedules.definition, sessionId: scheduleOccurrences.sessionId })
    .from(scheduleOccurrences)
    .innerJoin(assistantSchedules, eq(assistantSchedules.id, scheduleOccurrences.scheduleId))
    .where(
      and(
        eq(scheduleOccurrences.id, prompt.trigger.occurrenceId),
        scope(scheduleOccurrences, owner),
        eq(scheduleOccurrences.promptId, prompt.eventId),
      ),
    );
  if (
    !run ||
    run.sessionId !== journal.sessionId ||
    scheduleDefinitionSchema.parse(run.definition).consolidation !== 'memory'
  )
    fail();
  const selection = events.findLast(
    (e) => e.type === 'memory/selection' && e.receipt.promptId === prompt.eventId,
  );
  if (
    selection?.type !== 'memory/selection' ||
    selection.receipt.policyRevision !== command.expectedPolicyRevision
  )
    fail();
  const turn = events.slice(start + 1);
  if (turn.some((e) => e.type === 'message/user' || e.type === 'turn/end')) fail();
  const callIndex = turn.findIndex((e) => e.type === 'tool/call' && e.callId === journal.callId);
  const call = turn[callIndex];
  if (
    call?.type !== 'tool/call' ||
    call.name !== 'memory_propose' ||
    JSON.stringify(memoryProposalParametersSchema.parse(call.args)) !==
      JSON.stringify({ draft, expectedRevision: command.expectedRevision })
  )
    fail();
  for (const source of draftSources(draft)) {
    const [row] = await tx
      .select()
      .from(conversationEpisodes)
      .where(
        and(
          scope(conversationEpisodes, owner),
          sql`${conversationEpisodes.payload}->>'episodeId' = ${source.sourceEpisodeId}`,
        ),
      );
    if (!row || topicEpisodeSchema.parse(row.payload).at > prompt.trigger.scheduledAt) fail();
    const delivered = turn.slice(0, callIndex).some((e, index) => {
      if (e.type !== 'tool/result' || e.isError) return false;
      if (
        !turn
          .slice(0, index)
          .some((c) => c.type === 'tool/call' && c.callId === e.callId && c.name === 'recall')
      )
        return false;
      const result = recallResultSchema.safeParse(e.value);
      return (
        result.success &&
        result.data.policyRevision === command.expectedPolicyRevision &&
        result.data.episodeId === source.sourceEpisodeId &&
        result.data.sources?.some(
          (s) =>
            s.eventId === source.sourceEventId &&
            s.sessionId === source.sourceSessionId &&
            s.text.includes(source.sourceQuote),
        )
      );
    });
    if (!delivered) fail();
  }
}

export class PgMemoryEvolutionStore implements MemoryEvolutionStorePort {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async contextRevision(owner: Identity): Promise<number> {
    const [fact] = await this.db
      .select()
      .from(factEvents)
      .where(scope(factEvents, owner))
      .orderBy(desc(factEvents.revision))
      .limit(1)
      .catch(safeFailure);
    const [book] = await this.db
      .select()
      .from(playbookEvents)
      .where(scope(playbookEvents, owner))
      .orderBy(desc(playbookEvents.revision))
      .limit(1)
      .catch(safeFailure);
    return Math.max(fact?.revision ?? 0, book?.revision ?? 0);
  }
  async revision(owner: Identity): Promise<number> {
    return currentRevision(this.db, owner).catch(safeFailure);
  }
  private async fence(
    tx: Tx,
    owner: Identity,
    command: RevisionFence,
  ): Promise<Awaited<ReturnType<typeof policy>>> {
    if (owner.role === 'viewer') fail('MEMORY_READ_ONLY');
    if ((await currentRevision(tx, owner)) !== command.expectedRevision) fail('MEMORY_CONFLICT');
    const p = await policy(tx, owner);
    if (p.revision !== command.expectedPolicyRevision) fail('MEMORY_CONFLICT');
    return p;
  }
  private async retry(
    tx: Tx,
    owner: Identity,
    table: typeof factEvents,
    command: RevisionFence,
  ): Promise<boolean> {
    const [prior] = await tx
      .select()
      .from(table)
      .where(and(scope(table, owner), eq(table.operationId, command.operationId)));
    if (!prior) return false;
    const saved = z.object({ command: z.unknown() }).parse(prior.payload);
    if (!isDeepStrictEqual(saved.command, z.json().parse(JSON.parse(JSON.stringify(command)))))
      fail('MEMORY_CONFLICT');
    return true;
  }
  private async noResurrection(tx: Tx, owner: Identity, source: Source): Promise<void> {
    const [retired] = await tx
      .select()
      .from(facts)
      .where(
        and(
          scope(facts, owner),
          sql`${facts.payload}->>'validTo' is not null`,
          sql`${facts.payload}->'source'->>'sourceEventId' = ${source.sourceEventId}`,
          sql`${facts.payload}->'source'->>'sourceQuote' = ${source.sourceQuote}`,
        ),
      )
      .limit(1);
    if (retired) fail('MEMORY_SOURCE_RETIRED');
  }
  async submit(owner: Identity, raw: CandidateSubmission, signal?: AbortSignal): Promise<string> {
    const command = candidateSubmissionSchema.parse(raw);
    const id = command.operationId;
    return this.db
      .transaction(async (tx) => {
        await locks(tx, owner, draftSources(command.draft), command.journal);
        if (await this.retry(tx, owner, candidateEvents, command)) return id;
        const p = await this.fence(tx, owner, command);
        if (!p.autoSave) fail();
        await auditConsolidation(tx, owner, command);
        for (const source of draftSources(command.draft)) {
          if (!(await sourceAllowed(tx, owner, source, p.floor))) fail();
          await this.noResurrection(tx, owner, source);
        }
        const [duplicate] = await tx
          .select()
          .from(candidates)
          .where(
            and(
              scope(candidates, owner),
              sql`${candidates.payload}->'draft' = ${JSON.stringify(command.draft)}::jsonb`,
            ),
          )
          .limit(1);
        if (duplicate) fail('MEMORY_DUPLICATE');
        const content = JSON.stringify(command.draft);
        validateMemoryCommand({
          operationId: id,
          memoryId: id,
          expectedRevision: 0,
          operation: 'save',
          subject: 'Me',
          predicate: 'candidate',
          value: content,
        });
        const revision = command.expectedRevision + 1;
        const value: MemoryCandidate = {
          candidateId: id,
          draft: command.draft,
          journal: command.journal,
          status: 'pending',
          at: this.now().toISOString(),
          decidedAt: null,
          revision,
          policyRevision: p.revision,
        };
        signal?.throwIfAborted();
        await tx.insert(candidateEvents).values({
          tenantId: owner.tenantId,
          userId: owner.userId,
          revision,
          operationId: id,
          payload: { type: 'submitted', command, candidate: value },
        });
        await tx
          .insert(candidates)
          .values({ tenantId: owner.tenantId, userId: owner.userId, id, revision, payload: value });
        await advance(tx, owner, revision);
        return id;
      })
      .catch(safeFailure);
  }
  async propose(
    owner: Identity,
    raw: NewFact,
    expected: RevisionFence,
    signal?: AbortSignal,
  ): Promise<MemoryFact> {
    const fact = newFactSchema.parse(raw);
    const command = { ...revisionFenceSchema.parse(expected), fact };
    return this.db
      .transaction(async (tx) => {
        await locks(tx, owner, [fact.source]);
        if (await this.retry(tx, owner, factEvents, command)) {
          const [row] = await tx
            .select()
            .from(factEvents)
            .where(and(scope(factEvents, owner), eq(factEvents.operationId, command.operationId)));
          return memoryFactSchema.parse(z.object({ fact: z.unknown() }).parse(row!.payload).fact);
        }
        const p = await this.fence(tx, owner, command);
        if (!(await sourceAllowed(tx, owner, fact.source, p.floor))) fail();
        await this.noResurrection(tx, owner, fact.source);
        validateMemoryCommand({
          operation: 'save',
          operationId: command.operationId,
          memoryId: command.operationId,
          expectedRevision: 0,
          subject: 'Me',
          predicate: fact.kind,
          value: JSON.stringify(fact),
        });
        const revision = command.expectedRevision + 1;
        const value = await this.createFact(
          tx,
          owner,
          fact,
          command.operationId,
          revision,
          this.now().toISOString(),
        );
        signal?.throwIfAborted();
        await tx.insert(factEvents).values({
          tenantId: owner.tenantId,
          userId: owner.userId,
          revision,
          operationId: command.operationId,
          payload: { type: 'created', command, fact: value },
        });
        await advance(tx, owner, revision);
        return value;
      })
      .catch(safeFailure);
  }
  private async createFact(
    tx: Tx,
    owner: Identity,
    fact: NewFact,
    id: string,
    revision: number,
    at: string,
  ): Promise<MemoryFact> {
    const value: MemoryFact = { ...fact, factId: id, revision, validFrom: at, validTo: null };
    await tx
      .insert(facts)
      .values({ tenantId: owner.tenantId, userId: owner.userId, id, revision, payload: value });
    return value;
  }
  private async retire(
    tx: Tx,
    owner: Identity,
    id: string,
    revision: number,
    at: string,
    replacementId?: string,
  ): Promise<MemoryFact> {
    const [row] = await tx
      .select()
      .from(facts)
      .where(and(scope(facts, owner), eq(facts.id, id)));
    if (!row) fail();
    const prior = memoryFactSchema.parse(row.payload);
    if (prior.validTo) fail('MEMORY_CONFLICT');
    const value = {
      ...prior,
      validTo: at,
      revision,
      ...(replacementId ? { invalidatedBy: replacementId } : {}),
    };
    await tx
      .update(facts)
      .set({ payload: value })
      .where(and(scope(facts, owner), eq(facts.id, id)));
    return value;
  }
  async decide(owner: Identity, raw: CandidateDecision, signal?: AbortSignal): Promise<void> {
    const command = candidateDecisionSchema.parse(raw);
    // Discover lock names only; all authority is re-read inside the transaction.
    const [hint] = await this.db
      .select()
      .from(candidates)
      .where(and(scope(candidates, owner), eq(candidates.id, command.candidateId)))
      .catch(safeFailure);
    if (!hint) fail();
    const hintCandidate = memoryCandidateSchema.parse(hint.payload);
    await this.db
      .transaction(async (tx) => {
        await locks(tx, owner, draftSources(hintCandidate.draft));
        if (await this.retry(tx, owner, candidateEvents, command)) return;
        const p = await this.fence(tx, owner, command);
        const [row] = await tx
          .select()
          .from(candidates)
          .where(and(scope(candidates, owner), eq(candidates.id, command.candidateId)));
        if (!row) fail();
        const candidate = memoryCandidateSchema.parse(row.payload);
        if (candidate.status !== 'pending') fail('MEMORY_CONFLICT');
        const revision = command.expectedRevision + 1;
        const at = this.now().toISOString();
        if (command.decision === 'accept') {
          // The owner's fresh decision authorizes review; recheck current source/floor below.
          for (const source of draftSources(candidate.draft)) {
            if (!(await sourceAllowed(tx, owner, source, p.floor))) fail();
            await this.noResurrection(tx, owner, source);
          }
          const draft = candidate.draft;
          if (draft.type === 'fact') {
            const retired = draft.replacesFactId
              ? await this.retire(
                  tx,
                  owner,
                  draft.replacesFactId,
                  revision,
                  at,
                  candidate.candidateId,
                )
              : undefined;
            const fact = await this.createFact(
              tx,
              owner,
              draft.fact,
              candidate.candidateId,
              revision,
              at,
            );
            await tx.insert(factEvents).values({
              tenantId: owner.tenantId,
              userId: owner.userId,
              revision,
              operationId: command.operationId,
              payload: {
                type: retired ? 'corrected' : 'created',
                command,
                fact,
                ...(retired ? { retired } : {}),
              },
            });
          } else {
            const playbook: Playbook = {
              ...draft.playbook,
              playbookId: candidate.candidateId,
              at,
              revision,
              referenceOnly: true,
            };
            await tx.insert(playbooks).values({
              tenantId: owner.tenantId,
              userId: owner.userId,
              id: playbook.playbookId,
              revision,
              payload: playbook,
            });
            await tx.insert(playbookEvents).values({
              tenantId: owner.tenantId,
              userId: owner.userId,
              revision,
              operationId: command.operationId,
              payload: { type: 'created', command, playbook },
            });
          }
        }
        const value = {
          ...candidate,
          status: command.decision === 'accept' ? 'accepted' : 'rejected',
          decidedAt: at,
          revision,
        };
        signal?.throwIfAborted();
        await tx.insert(candidateEvents).values({
          tenantId: owner.tenantId,
          userId: owner.userId,
          revision,
          operationId: command.operationId,
          payload: { type: 'decided', command, candidate: value },
        });
        await tx
          .update(candidates)
          .set({ revision, payload: value })
          .where(and(scope(candidates, owner), eq(candidates.id, candidate.candidateId)));
        await advance(tx, owner, revision);
      })
      .catch(safeFailure);
  }
  async invalidate(owner: Identity, raw: FactInvalidation, signal?: AbortSignal): Promise<void> {
    const command = factInvalidationSchema.parse(raw);
    await this.db
      .transaction(async (tx) => {
        await locks(tx, owner, command.replacement ? [command.replacement.source] : []);
        if (await this.retry(tx, owner, factEvents, command)) return;
        const p = await this.fence(tx, owner, command);
        if (
          command.replacement &&
          !(await sourceAllowed(tx, owner, command.replacement.source, p.floor))
        )
          fail();
        if (command.replacement) {
          await this.noResurrection(tx, owner, command.replacement.source);
          validateMemoryCommand({
            operation: 'save',
            operationId: command.operationId,
            memoryId: command.operationId,
            expectedRevision: 0,
            subject: 'Me',
            predicate: command.replacement.kind,
            value: JSON.stringify(command.replacement),
          });
        }
        const revision = command.expectedRevision + 1;
        const at = this.now().toISOString();
        const replacementId = command.replacement ? command.operationId : undefined;
        const retired = await this.retire(tx, owner, command.factId, revision, at, replacementId);
        const fact = command.replacement
          ? await this.createFact(tx, owner, command.replacement, replacementId!, revision, at)
          : undefined;
        signal?.throwIfAborted();
        await tx.insert(factEvents).values({
          tenantId: owner.tenantId,
          userId: owner.userId,
          revision,
          operationId: command.operationId,
          payload: {
            type: fact ? 'corrected' : 'invalidated',
            command,
            retired,
            ...(fact ? { fact } : {}),
          },
        });
        await advance(tx, owner, revision);
      })
      .catch(safeFailure);
  }
  private async read(
    owner: Identity,
    raw: EvolutionPageQuery,
    table: typeof facts,
    pendingOnly = false,
  ): Promise<{ rows: { revision: number; payload: unknown }[]; nextBefore: number | null }> {
    const query = evolutionPageQuerySchema.parse(raw);
    const rows = await this.db
      .select()
      .from(table)
      .where(
        and(
          scope(table, owner),
          query.before ? lt(table.revision, query.before) : undefined,
          query.query
            ? sql`${table.payload}::text ilike ${`%${query.query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`}`
            : undefined,
          pendingOnly ? sql`${table.payload}->>'status' = 'pending'` : undefined,
          query.kind ? sql`${table.payload}->>'kind' = ${query.kind}` : undefined,
        ),
      )
      .orderBy(desc(table.revision), desc(table.id))
      .limit(query.limit + 1);
    return {
      rows: rows.slice(0, query.limit),
      nextBefore: rows.length > query.limit ? rows[query.limit - 1]!.revision : null,
    };
  }
  async history(owner: Identity, query: EvolutionPageQuery): Promise<MemoryEvolutionPage> {
    const revision = await this.revision(owner);
    const page = await this.read(owner, query, facts).catch(safeFailure);
    return {
      revision,
      facts: page.rows.map((r) => memoryFactSchema.parse(r.payload)),
      candidates: [],
      playbooks: [],
      nextBefore: page.nextBefore,
    };
  }
  async pending(owner: Identity, query: EvolutionPageQuery): Promise<MemoryEvolutionPage> {
    const revision = await this.revision(owner);
    const page = await this.read(owner, query, candidates, true).catch(safeFailure);
    const items = page.rows.map((r) => memoryCandidateSchema.parse(r.payload));
    const replacementIds = items.flatMap((item) =>
      item.draft.type === 'fact' && item.draft.replacesFactId ? [item.draft.replacesFactId] : [],
    );
    const originals = replacementIds.length
      ? await this.db
          .select()
          .from(facts)
          .where(and(scope(facts, owner), inArray(facts.id, replacementIds)))
          .limit(50)
          .catch(safeFailure)
      : [];
    return {
      revision,
      facts: originals.map((r) => memoryFactSchema.parse(r.payload)),
      candidates: items,
      playbooks: [],
      nextBefore: page.nextBefore,
    };
  }
  async activeFacts(owner: Identity, query: EvolutionPageQuery): Promise<MemoryFact[]> {
    return this.db
      .transaction(async (tx) => {
        const before = await policy(tx, owner);
        const revision = await currentRevision(tx, owner);
        const rows = await tx
          .select()
          .from(facts)
          .where(
            and(
              scope(facts, owner),
              sourceFence(sql`${facts.payload}->'source'`, owner, before.floor),
              sql`${facts.payload}->>'validTo' is null`,
              query.kind ? sql`${facts.payload}->>'kind' = ${query.kind}` : undefined,
              query.query ? sql`${facts.payload}->>'text' ilike ${`%${query.query}%`}` : undefined,
            ),
          )
          .orderBy(desc(facts.revision))
          .limit(evolutionPageQuerySchema.parse(query).limit);
        const result: MemoryFact[] = [];
        for (const row of rows) {
          const fact = memoryFactSchema.parse(row.payload);
          if (await sourceAllowed(tx, owner, fact.source, before.floor)) result.push(fact);
        }
        if (
          (await policy(tx, owner)).revision !== before.revision ||
          (await currentRevision(tx, owner)) !== revision
        )
          fail('MEMORY_CONFLICT');
        return result;
      })
      .catch(safeFailure);
  }
  async list(owner: Identity, raw: EvolutionPageQuery): Promise<Playbook[]> {
    const query = evolutionPageQuerySchema.parse(raw);
    return this.db
      .transaction(async (tx) => {
        const p = await policy(tx, owner);
        const revision = await currentRevision(tx, owner);
        const rows = await tx
          .select()
          .from(playbooks)
          .where(
            and(
              scope(playbooks, owner),
              sql`not exists (select 1 from jsonb_array_elements(${playbooks.payload}->'sources') as src where not ${sourceFence(sql`src`, owner, p.floor)})`,
              query.query ? sql`${playbooks.payload}::text ilike ${`%${query.query}%`}` : undefined,
            ),
          )
          .orderBy(desc(playbooks.revision))
          .limit(query.limit);
        const result: Playbook[] = [];
        for (const row of rows) {
          const book = playbookSchema.parse(row.payload);
          let allowed = true;
          for (const source of book.sources)
            allowed &&= await sourceAllowed(tx, owner, source, p.floor);
          if (allowed) result.push(book);
        }
        if (
          (await policy(tx, owner)).revision !== p.revision ||
          (await currentRevision(tx, owner)) !== revision
        )
          fail('MEMORY_CONFLICT');
        return result;
      })
      .catch(safeFailure);
  }
}
