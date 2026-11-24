import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  createDb,
  PgMemoryEvolutionStore,
  PgSessionMetaStore,
  PgSessionStore,
  PgConversationIndex,
  PgMemoryStore,
  PgEpisodeVectorStore,
} from '../src/index.js';
import { assistantSchedules, scheduleOccurrences } from '../src/schema.js';
import type { CandidateSubmission, Identity, NewFact } from '@trinity-harness/contracts';
import { evaluationEpisodes, evaluationQuestions } from '../../memory/test/eval/fixtures.js';

// Explicit isolated database; never silently migrate the application's configured database.
const url = process.env['TRINITY_MEMORY_TEST_DATABASE_URL'];
const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
const db = createDb(pool);
const now = () => new Date('2026-11-24T00:00:00.000Z');
const evolution = new PgMemoryEvolutionStore(db, now);
const metas = new PgSessionMetaStore(db);
const events = new PgSessionStore(db);
const index = new PgConversationIndex(db);
afterAll(async () => pool.end());
async function fixture(
  options: {
    quote?: string;
    original?: string;
    mode?: 'memory' | 'review';
    omitRead?: boolean;
    future?: boolean;
    team?: boolean;
    playbook?: boolean;
  } = {},
): Promise<{ owner: Identity; command: CandidateSubmission; source: NewFact['source'] }> {
  const owner: Identity = { tenantId: randomUUID(), userId: randomUUID(), role: 'member' };
  const originalId = randomUUID();
  const sessionId = randomUUID();
  await metas.create({
    id: originalId,
    tenantId: owner.tenantId,
    userId: owner.userId,
    title: 'Source',
    ...(options.team
      ? {
          kind: 'work' as const,
          sessionRole: 'task' as const,
          workspaceUri: '/team-eval',
          scope: 'team' as const,
          scopeId: randomUUID(),
        }
      : { kind: 'chat' as const, sessionRole: 'side' as const, workspaceUri: null }),
  });
  await metas.create({
    id: sessionId,
    tenantId: owner.tenantId,
    userId: owner.userId,
    title: 'Nightly',
    kind: 'work',
    sessionRole: 'task',
    workspaceUri: '/memory-eval',
  });
  const sourceEventId = randomUUID();
  const sourceQuote = options.quote ?? 'I prefer tea.';
  const at = options.future ? '2026-11-25T00:00:00.000Z' : '2026-11-22T00:00:00.000Z';
  await events.append(originalId, [
    {
      type: 'message/user',
      eventId: sourceEventId,
      at,
      surfaceOp: 'append',
      content: [{ kind: 'text', text: options.original ?? sourceQuote }],
    },
    {
      type: 'message/assistant',
      eventId: randomUUID(),
      at,
      surfaceOp: 'append',
      phase: 'final',
      content: [{ kind: 'text', text: 'Understood.' }],
    },
    { type: 'turn/end', eventId: randomUUID(), at, reason: 'completed', promptId: sourceEventId },
  ]);
  const source = {
    sourceEpisodeId: sourceEventId,
    sourceEventId,
    sourceSessionId: originalId,
    sourceQuote,
  };
  const scheduleId = randomUUID();
  const occurrenceId = randomUUID();
  const promptId = randomUUID();
  const callId = randomUUID();
  await db.insert(assistantSchedules).values({
    id: scheduleId,
    tenantId: owner.tenantId,
    userId: owner.userId,
    operationId: randomUUID(),
    revision: 1,
    enabled: true,
    createdAt: now().toISOString(),
    definition: {
      title: 'Nightly',
      request: 'Consolidate memory',
      sourceSessionId: originalId,
      timezone: 'UTC',
      timing: { kind: 'once', at: now().toISOString() },
      consolidation: options.mode ?? 'memory',
    },
  });
  await db.insert(scheduleOccurrences).values({
    id: occurrenceId,
    scheduleId,
    tenantId: owner.tenantId,
    userId: owner.userId,
    revision: 1,
    scheduledAt: now().toISOString(),
    sessionId,
    promptId,
    title: 'Nightly',
    status: 'queued',
    reason: 'due',
  });
  const draft: CandidateSubmission['draft'] = options.playbook
    ? {
        type: 'playbook',
        playbook: {
          taskType: 'Preparing tea',
          approach: 'Check the stated preference before choosing tea.',
          pitfalls: ['Do not infer preferences from task language.'],
          sources: [source],
        },
      }
    : { type: 'fact', fact: { kind: 'preference', text: 'Prefers tea.', source } };
  const command: CandidateSubmission = {
    operationId: randomUUID(),
    expectedRevision: 0,
    expectedPolicyRevision: 0,
    draft,
    journal: { sessionId, promptId, callId },
  };
  await events.append(sessionId, [
    {
      type: 'message/user',
      eventId: promptId,
      at: now().toISOString(),
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'Consolidate memory' }],
      trigger: {
        kind: 'schedule',
        consolidation: options.mode ?? 'memory',
        scheduleId,
        revision: 1,
        occurrenceId,
        scheduledAt: now().toISOString(),
      },
    },
    {
      type: 'memory/selection',
      eventId: randomUUID(),
      at: now().toISOString(),
      receipt: {
        version: 3,
        promptId,
        policyRevision: 0,
        evolutionRevision: 0,
        memories: [],
        episodes: [],
        omitted: false,
      },
    },
    ...(options.omitRead
      ? []
      : [
          {
            type: 'tool/call' as const,
            eventId: randomUUID(),
            at: now().toISOString(),
            callId: 'recall-1',
            name: 'recall',
            args: { episodeId: sourceEventId },
          },
          {
            type: 'tool/result' as const,
            eventId: randomUUID(),
            at: now().toISOString(),
            callId: 'recall-1',
            isError: false,
            value: {
              policyRevision: 0,
              episodeId: sourceEventId,
              sources: [
                {
                  sessionId: originalId,
                  eventId: sourceEventId,
                  seq: 1,
                  at,
                  from: 0,
                  to: sourceQuote.length,
                  totalCharacters: sourceQuote.length,
                  text: sourceQuote,
                  truncated: false,
                },
              ],
            },
          },
        ]),
    {
      type: 'tool/call',
      eventId: randomUUID(),
      at: now().toISOString(),
      name: 'memory_propose',
      callId,
      args: { draft, expectedRevision: 0 },
    },
  ]);
  return { owner, command, source };
}
describe.skipIf(!url)('memory evolution PostgreSQL + pgvector acceptance', () => {
  it('measures the actual unmodified ILIKE baseline on the shared QA fixtures', async () => {
    const owner: Identity = { tenantId: randomUUID(), userId: randomUUID(), role: 'member' };
    const id = randomUUID();
    await metas.create({
      id,
      tenantId: owner.tenantId,
      userId: owner.userId,
      title: 'Eval',
      kind: 'chat',
      sessionRole: 'side',
      workspaceUri: null,
    });
    const ids: string[] = [];
    for (const e of evaluationEpisodes) {
      const promptId = randomUUID();
      ids.push(promptId);
      await events.append(id, [
        {
          type: 'message/user',
          eventId: promptId,
          at: e.at,
          surfaceOp: 'append',
          content: [{ kind: 'text', text: e.request }],
        },
        {
          type: 'message/assistant',
          eventId: randomUUID(),
          at: e.at,
          surfaceOp: 'append',
          phase: 'final',
          content: [{ kind: 'text', text: e.outcome }],
        },
        { type: 'turn/end', eventId: randomUUID(), at: e.at, reason: 'completed', promptId },
      ]);
    }
    let score = 0;
    for (const q of evaluationQuestions) {
      const page = await index.history(owner, {
        query: q.query,
        timezone: 'UTC',
        limit: 10,
        recallOnly: true,
      });
      if (
        q.expected === null ? !page.episodes.length : page.episodes[0]?.promptId === ids[q.expected]
      )
        score++;
    }
    expect(score).toBe(3);
  });
  it('keeps proposals inactive; accepts atomically and idempotently; invalidates one fact only', async () => {
    const { owner, command } = await fixture();
    const id = await evolution.submit(owner, command);
    expect(await new PgMemoryEvolutionStore(db, now).submit(owner, command)).toBe(id);
    expect(await evolution.activeFacts(owner, { limit: 10 })).toEqual([]);
    expect(await evolution.contextRevision(owner)).toBe(0);
    const decision = {
      operationId: randomUUID(),
      candidateId: id,
      decision: 'accept' as const,
      expectedRevision: 1,
      expectedPolicyRevision: 0,
    };
    await evolution.decide(owner, decision);
    await evolution.decide(owner, decision);
    expect(await evolution.activeFacts(owner, { limit: 10 })).toMatchObject([
      { text: 'Prefers tea.', validTo: null },
    ]);
    expect(await evolution.contextRevision(owner)).toBe(2);
    const invalidation = {
      operationId: randomUUID(),
      factId: id,
      expectedRevision: 2,
      expectedPolicyRevision: 0,
    };
    await evolution.invalidate(owner, invalidation);
    await evolution.invalidate(owner, invalidation);
    expect(await evolution.activeFacts(owner, { limit: 10 })).toEqual([]);
    expect((await evolution.history(owner, { limit: 10 })).facts[0]?.validTo).toBe(
      now().toISOString(),
    );
    expect((await new PgMemoryStore(db).snapshot(owner)).hasSuppression).toBe(false);
    await expect(
      evolution.decide(owner, { ...decision, decision: 'reject' }),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' });
    await expect(
      pool.query('update memory_fact_events set payload=payload where tenant_id=$1', [
        owner.tenantId,
      ]),
    ).rejects.toThrow('append-only');
  });
  it.each([
    ['quoted source', { quote: 'I prefer tea.', original: '> I prefer tea.' }],
    [
      'inline quoted source',
      { quote: 'I prefer tea.', original: 'A document says "I prefer tea."' },
    ],
    ['review-only mode', { mode: 'review' as const }],
    ['missing delivered recall', { omitRead: true }],
    [
      'manufactured unquoted match',
      { quote: 'I prefer tea.', original: 'I pre"xx"fer tea.\n"I prefer tea."' },
    ],
    ['future source', { future: true }],
    ['team source', { team: true }],
  ])('rejects %s without advancing the journal', async (_name, options) => {
    const { owner, command } = await fixture(options);
    await expect(evolution.submit(owner, command)).rejects.toMatchObject({
      code: 'MEMORY_SOURCE_UNAVAILABLE',
    });
    expect(await evolution.revision(owner)).toBe(0);
  });
  it('fences cross-owner writes, exclusions, removals, settings and post-submission policy changes', async () => {
    const { owner, command, source } = await fixture();
    await expect(
      evolution.submit({ ...owner, userId: randomUUID() }, command),
    ).rejects.toMatchObject({ code: 'MEMORY_SOURCE_UNAVAILABLE' });
    await index.revise(owner, source.sourceEpisodeId, { excluded: true });
    await expect(evolution.submit(owner, command)).rejects.toMatchObject({
      code: 'MEMORY_SOURCE_UNAVAILABLE',
    });
    await index.revise(owner, source.sourceEpisodeId, { excluded: false });
    const id = await evolution.submit(owner, command);
    await new PgMemoryStore(db).savePersona(owner, {
      content: 'Updated.',
      expectedRevision: 0,
      operationId: randomUUID(),
      autoSaveEnabled: false,
    });
    await expect(
      evolution.decide(owner, {
        candidateId: id,
        decision: 'accept',
        expectedRevision: 1,
        expectedPolicyRevision: 0,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' });
    await evolution.decide(owner, {
      candidateId: id,
      decision: 'reject',
      expectedRevision: 1,
      expectedPolicyRevision: 1,
      operationId: randomUUID(),
    });
    const other = await fixture();
    await events.append(other.source.sourceSessionId, [
      {
        type: 'message/removed',
        role: 'user',
        eventId: randomUUID(),
        at: now().toISOString(),
        promptId: other.source.sourceEventId,
      },
    ]);
    await expect(evolution.submit(other.owner, other.command)).rejects.toMatchObject({
      code: 'MEMORY_SOURCE_UNAVAILABLE',
    });
  });
  it('allows an explicit fresh owner decision after auto-save is disabled, without permitting automatic submissions', async () => {
    const f = await fixture();
    const id = await evolution.submit(f.owner, f.command);
    await new PgMemoryStore(db).savePersona(f.owner, {
      content: 'Updated.',
      expectedRevision: 0,
      operationId: randomUUID(),
      autoSaveEnabled: false,
    });
    await evolution.decide(f.owner, {
      candidateId: id,
      decision: 'accept',
      expectedRevision: 1,
      expectedPolicyRevision: 1,
      operationId: randomUUID(),
    });
    expect(await evolution.activeFacts(f.owner, { limit: 10 })).toHaveLength(1);
  });
  it('rechecks exclusion after submission before an owner accepts a candidate', async () => {
    const f = await fixture();
    const id = await evolution.submit(f.owner, f.command);
    await index.revise(f.owner, f.source.sourceEpisodeId, { excluded: true });
    await expect(
      evolution.decide(f.owner, {
        candidateId: id,
        decision: 'accept',
        expectedRevision: 1,
        expectedPolicyRevision: 0,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_SOURCE_UNAVAILABLE' });
    expect(await evolution.activeFacts(f.owner, { limit: 10 })).toEqual([]);
    expect((await evolution.pending(f.owner, { limit: 10 })).candidates).toHaveLength(1);
  });
  it('serializes competing decisions and rolls back a failed acceptance with its audit/projection', async () => {
    const { owner, command } = await fixture();
    const id = await evolution.submit(owner, command);
    const decisions = await Promise.allSettled(
      ['accept', 'reject'].map((decision) =>
        evolution.decide(owner, {
          candidateId: id,
          decision: decision as 'accept' | 'reject',
          expectedRevision: 1,
          expectedPolicyRevision: 0,
          operationId: randomUUID(),
        }),
      ),
    );
    expect(decisions.filter((d) => d.status === 'fulfilled')).toHaveLength(1);
    expect(await evolution.revision(owner)).toBe(2);
    const f = await fixture();
    const fId = await evolution.submit(f.owner, f.command);
    await expect(
      evolution.decide(
        f.owner,
        {
          candidateId: fId,
          decision: 'accept',
          expectedRevision: 1,
          expectedPolicyRevision: 0,
          operationId: randomUUID(),
        },
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect((await evolution.pending(f.owner, { limit: 10 })).candidates).toHaveLength(1);
    expect(await evolution.activeFacts(f.owner, { limit: 10 })).toEqual([]);
    expect(await evolution.revision(f.owner)).toBe(1);
  });
  it('keeps playbooks inactive until owner review and hides them after source exclusion', async () => {
    const f = await fixture({ playbook: true });
    const id = await evolution.submit(f.owner, f.command);
    expect(await evolution.list(f.owner, { limit: 10 })).toEqual([]);
    await evolution.decide(f.owner, {
      candidateId: id,
      decision: 'accept',
      operationId: randomUUID(),
      expectedRevision: 1,
      expectedPolicyRevision: 0,
    });
    expect(await evolution.list(f.owner, { limit: 10 })).toMatchObject([
      { taskType: 'Preparing tea', referenceOnly: true },
    ]);
    await index.revise(f.owner, f.source.sourceEpisodeId, { excluded: true });
    expect(await evolution.list(f.owner, { limit: 10 })).toEqual([]);
  });
  it('corrects one fact atomically, preserves unrelated facts and never resurrects a retired source', async () => {
    const f = await fixture();
    const original = { kind: 'preference' as const, text: 'Prefers tea.', source: f.source };
    const first = await evolution.propose(f.owner, original, {
      operationId: randomUUID(),
      expectedRevision: 0,
      expectedPolicyRevision: 0,
    });
    const unrelated = await evolution.propose(
      f.owner,
      { ...original, kind: 'profile', text: 'Shared original wording.' },
      { operationId: randomUUID(), expectedRevision: 1, expectedPolicyRevision: 0 },
    );
    const newPrompt = randomUUID();
    await events.append(f.source.sourceSessionId, [
      {
        type: 'message/user',
        eventId: newPrompt,
        at: now().toISOString(),
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'I now prefer coffee.' }],
      },
      {
        type: 'message/assistant',
        eventId: randomUUID(),
        at: now().toISOString(),
        surfaceOp: 'append',
        phase: 'final',
        content: [{ kind: 'text', text: 'Understood.' }],
      },
      {
        type: 'turn/end',
        eventId: randomUUID(),
        at: now().toISOString(),
        reason: 'completed',
        promptId: newPrompt,
      },
    ]);
    const replacement = {
      kind: 'preference' as const,
      text: 'Prefers coffee.',
      source: {
        ...f.source,
        sourceEpisodeId: newPrompt,
        sourceEventId: newPrompt,
        sourceQuote: 'I now prefer coffee.',
      },
    };
    const operationId = randomUUID();
    await evolution.invalidate(f.owner, {
      factId: first.factId,
      replacement,
      operationId,
      expectedRevision: 2,
      expectedPolicyRevision: 0,
    });
    const active = await evolution.activeFacts(f.owner, { limit: 10 });
    expect(active.map((fact) => fact.factId)).toEqual(
      expect.arrayContaining([unrelated.factId, operationId]),
    );
    expect(active.some((fact) => fact.factId === first.factId)).toBe(false);
    expect(
      (await evolution.history(f.owner, { limit: 10 })).facts.find(
        (fact) => fact.factId === first.factId,
      ),
    ).toMatchObject({ invalidatedBy: operationId });
    await expect(
      evolution.propose(f.owner, original, {
        operationId: randomUUID(),
        expectedRevision: 3,
        expectedPolicyRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_SOURCE_RETIRED' });
    await index.revise(f.owner, newPrompt, { excluded: true });
    expect((await evolution.activeFacts(f.owner, { limit: 1 }))[0]?.factId).toBe(unrelated.factId);
    expect((await new PgMemoryStore(db).snapshot(f.owner)).hasSuppression).toBe(false);
  });
  it('stores vectors idempotently, filters ownership/exclusions/date before ranking, and rejects stale content hashes', async () => {
    const { owner, source } = await fixture();
    const vectors = new PgEpisodeVectorStore(db, now);
    const jobs = await vectors.pending('fake/vector', 20);
    const job = jobs.find((j) => j.episode.episodeId === source.sourceEpisodeId)!;
    expect(job).toBeDefined();
    expect(
      (await vectors.pending('fake/vector', 20)).some(
        (j) => j.episode.episodeId === source.sourceEpisodeId,
      ),
    ).toBe(false);
    await vectors.complete(job, [1, 0], 'fake/vector');
    await vectors.complete(job, [1, 0], 'fake/vector');
    await expect(
      vectors.complete({ ...job, contentHash: '0'.repeat(64) }, [0, 1], 'fake/vector'),
    ).rejects.toThrow('source changed');
    const query = { timezone: 'UTC', limit: 10, recallOnly: true };
    expect(await vectors.search(owner, query, [1, 0], 'fake/vector')).toHaveLength(1);
    expect(
      await vectors.search({ ...owner, userId: randomUUID() }, query, [1, 0], 'fake/vector'),
    ).toEqual([]);
    expect(
      await vectors.search(owner, { ...query, minPolicyRevision: 1 }, [1, 0], 'fake/vector'),
    ).toEqual([]);
    expect(
      await vectors.search(owner, { ...query, date: '2026-11-23' }, [1, 0], 'fake/vector'),
    ).toEqual([]);
    await index.revise(owner, source.sourceEpisodeId, { excluded: true });
    await expect(vectors.validate(job)).rejects.toThrow('source changed');
    expect(await vectors.search(owner, query, [1, 0], 'fake/vector')).toEqual([]);
  });
});
