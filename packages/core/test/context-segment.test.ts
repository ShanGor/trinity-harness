import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  ConversationIndexPort,
  MemoryStorePort,
  RecallReceipt,
  SessionMeta,
  SessionMetaStore,
} from '@trinity-harness/contracts';
import { sessionEventSchema } from '@trinity-harness/contracts';
import { selectContextSegment } from '../src/personal-assistant/context-segment.js';
import { fitDialogue } from '../src/personal-assistant/memory.js';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  PersonalContext,
  personalModelMessages,
} from '../src/index.js';
import { FakeLLM, textChunks } from '../src/testing/fake-llm.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';

const at = '2026-11-02T23:59:00.000Z';
const configuration = 'a'.repeat(64);
const stamp = () => ({ eventId: randomUUID(), at });
function turn(seq: number, length = 100): NonNullable<RecallReceipt['dialogue']>[number] {
  const source = (offset: number) => ({
    eventId: randomUUID(),
    seq: seq + offset,
    from: 0,
    to: length,
    totalCharacters: length,
    text: String(seq).repeat(length).slice(0, length),
  });
  return { promptId: randomUUID(), request: source(0), answer: source(1) };
}
function receipt(dialogue: NonNullable<RecallReceipt['dialogue']>): RecallReceipt {
  return {
    version: 2,
    promptId: randomUUID(),
    policyRevision: 0,
    dialogue,
    memories: [],
    episodes: [],
    omitted: false,
  };
}
const options = () => ({ id: randomUUID(), configuration, policyRevision: 0, capacity: 4000 });

describe('stable context admission', () => {
  it('appends without sliding or rewriting retained snapshots beyond the legacy six turns', () => {
    const candidates = Array.from({ length: 8 }, (_, i) => turn(i * 3 + 1));
    const first = selectContextSegment(candidates.slice(0, 6), undefined, options());
    const prior = { ...receipt(first.dialogue), segment: first.segment };
    const next = selectContextSegment(candidates, prior, options());
    expect(next.segment).toBe(first.segment);
    expect(next.dialogue).toHaveLength(8);
    expect(next.dialogue.slice(0, 6)).toEqual(prior.dialogue);
    expect(selectContextSegment(candidates, { ...prior, ...next }, options())).toEqual(next);
  });

  it.each(['policy', 'configuration', 'source', 'capacity'] as const)(
    'records a %s rebuild',
    (reason) => {
      const candidates = [turn(1), turn(4)];
      const initial = selectContextSegment(candidates, undefined, options());
      const prior = { ...receipt(initial.dialogue), segment: initial.segment };
      const nextOptions = options();
      if (reason === 'policy') nextOptions.policyRevision = 1;
      if (reason === 'configuration') nextOptions.configuration = 'b'.repeat(64);
      if (reason === 'capacity') nextOptions.capacity = 100;
      const next = selectContextSegment(
        reason === 'source' ? candidates.slice(1) : candidates,
        prior,
        nextOptions,
      );
      expect(next.segment.reason).toBe(reason);
      expect(next.segment.revision).toBe(2);
      expect(next.segment.id).not.toBe(initial.segment.id);
      expect(JSON.stringify(next.dialogue)).not.toContain('undefined');
    },
  );

  it('keeps admitted excerpts stable and marks a pressure rebuild with exact expansion ranges', () => {
    const candidates = [turn(1, 6000)];
    const initial = selectContextSegment(candidates, undefined, options());
    const prior = { ...receipt(initial.dialogue), segment: initial.segment };
    expect(initial.dialogue[0]!.answer.to).toBeLessThan(6000);
    expect(selectContextSegment(candidates, prior, options()).dialogue).toEqual(initial.dialogue);
    const fitted = fitDialogue(prior, 500);
    expect(fitted.segment).toMatchObject({ reason: 'pressure', revision: 2, capacity: 500 });
    expect(fitted.dialogue![0]!.answer.totalCharacters).toBe(6000);
    expect(fitted.dialogue![0]!.answer.to).toBe(fitted.dialogue![0]!.answer.text.length);
  });
});

async function fixture() {
  const store = new MemorySessionStore();
  const owner: SessionMeta = {
    id: randomUUID(),
    tenantId: randomUUID(),
    userId: randomUUID(),
    title: 'Main',
    kind: 'chat',
    sessionRole: 'main',
    scope: 'personal',
    workspaceUri: '/ws',
    createdAt: at,
  };
  await store.append(owner.id, [
    { ...stamp(), type: 'session/created', kind: 'chat', sessionRole: 'main', workspaceUri: '/ws' },
  ]);
  const snapshot = { revision: 0, items: [], hasSuppression: false };
  const memory: MemoryStorePort = { snapshot: vi.fn(async () => snapshot), change: vi.fn() };
  const index: ConversationIndexPort = {
    history: vi.fn(),
    revise: vi.fn(),
    evidence: vi.fn(async () => null),
  };
  const context = () => new PersonalContext(memory, index, store);
  async function completed(text: string, time = at): Promise<string> {
    const promptId = randomUUID();
    await store.append(owner.id, [
      {
        eventId: promptId,
        at: time,
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text }],
      },
      {
        ...stamp(),
        type: 'message/assistant',
        phase: 'final',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: `Answer ${text}` }],
      },
      { ...stamp(), type: 'turn/end', promptId, reason: 'completed' },
    ]);
    return promptId;
  }
  async function select(): Promise<RecallReceipt> {
    const promptId = randomUUID();
    await store.append(owner.id, [
      {
        eventId: promptId,
        at: '2026-11-03T09:00:00.000Z',
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'Continue' }],
      },
    ]);
    const selected = await context().select(
      owner,
      promptId,
      'Continue',
      undefined,
      at,
      4000,
      configuration,
    );
    const event = { ...stamp(), type: 'memory/selection' as const, receipt: selected };
    sessionEventSchema.parse(event);
    await store.append(owner.id, [event]);
    return selected;
  }
  return { store, owner, snapshot, memory, index, context, completed, select };
}

it('replays stable segment receipts across midnight/restarts and retains an exact rendered dialogue prefix', async () => {
  const f = await fixture();
  await f.completed('original objective');
  const first = await f.select();
  const before = personalModelMessages(await f.store.load(f.owner.id), first);
  await f.completed('next day steering', '2026-11-03T08:00:00.000Z');
  const second = await f.select();
  const after = personalModelMessages(await f.store.load(f.owner.id), second);
  expect(second.segment).toEqual(first.segment);
  expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
  expect(second.dialogue).toHaveLength(2);
  // Prefix estimates establish rendering reuse, not a provider cache hit.
  expect(JSON.stringify(after.slice(0, 2)).length).toBeGreaterThan(0);
});

it('invalidates removed/excluded sources and policy generations before reuse and effect dispatch', async () => {
  const f = await fixture();
  const removed = await f.completed('private old fact');
  const initial = await f.select();
  await f.store.append(f.owner.id, [
    { ...stamp(), type: 'message/removed', role: 'user', promptId: removed },
  ]);
  await expect(f.context().validate(f.owner, initial)).rejects.toMatchObject({
    code: 'MEMORY_CONTEXT_CHANGED',
  });
  const next = await f.select();
  expect(next.segment?.reason).toBe('source');
  expect(JSON.stringify(next.dialogue)).not.toContain('private old fact');
  f.snapshot.revision++;
  const changed = await f.select();
  expect(changed.segment?.reason).toBe('policy');
  await expect(f.context().validate(f.owner, next)).rejects.toMatchObject({
    code: 'MEMORY_CONTEXT_CHANGED',
  });
});

it('keeps system instructions identical across Main prompts while recording current IDs after reusable dialogue', async () => {
  const f = await fixture();
  const llm = new FakeLLM(
    () => textChunks('First'),
    () => textChunks('Second'),
  );
  const run = async (text: string): Promise<void> => {
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools: new CoreToolRegistry(new FakeSandbox()),
      store: f.store,
      workspaceRoot: '/ws',
      personalContext: f.context(),
      stableContextSegments: true,
      sessionMetas: { get: async () => f.owner } as unknown as SessionMetaStore,
    });
    expect((await loop.run(f.owner.id, text, { emit: () => undefined })).reason).toBe('completed');
  };
  await run('First question');
  await run('Follow-up');
  expect(llm.requests[1]!.system).toBe(llm.requests[0]!.system);
  expect(llm.requests[0]!.system).not.toContain('Current committed user request reference');
  expect(
    llm.requests[1]!.messages.some((message) =>
      message.content.includes('Current committed user request reference'),
    ),
  ).toBe(true);
  expect(llm.requests[1]!.cache).toBe(true);
});

it('retains only authorized sources after exclusion and never uses personal segments in team scope', async () => {
  const f = await fixture();
  const promptId = await f.completed('excluded history');
  const first = await f.select();
  vi.mocked(f.index.evidence!).mockResolvedValue({
    episodeId: promptId,
    promptId,
    sessionId: f.owner.id,
    topic: 'excluded',
    at,
    request: 'excluded history',
    outcome: 'excluded answer',
    excluded: true,
    policyRevision: 0,
    fromSeq: 2,
    toSeq: 4,
  });
  await expect(f.context().validate(f.owner, first)).rejects.toMatchObject({
    code: 'MEMORY_CONTEXT_CHANGED',
  });
  const next = await f.select();
  expect(next.dialogue).toEqual([]);
  expect(next.segment?.reason).toBe('source');
  const team = await f
    .context()
    .select(
      { ...f.owner, scope: 'team' },
      randomUUID(),
      'Read',
      undefined,
      at,
      4000,
      configuration,
    );
  expect(team.segment).toBeUndefined();
  expect(team.dialogue).toBeUndefined();
});

it('rejects stale concurrent admission instead of overwriting a newly committed Main prompt', async () => {
  const f = await fixture();
  const original = f.context();
  const select = vi.fn(async (...args: Parameters<PersonalContext['select']>) => {
    const selected = await original.select(...args);
    await f.store.append(f.owner.id, [
      {
        ...stamp(),
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'Concurrent prompt' }],
      },
    ]);
    return selected;
  });
  const llm = new FakeLLM(() => textChunks('Must not dispatch'));
  const loop = new CoreAgentLoop({
    llm,
    model: 'fake/model',
    tools: new CoreToolRegistry(new FakeSandbox()),
    store: f.store,
    workspaceRoot: '/ws',
    personalContext: { select },
    stableContextSegments: true,
    sessionMetas: { get: async () => f.owner } as unknown as SessionMetaStore,
  });
  expect((await loop.run(f.owner.id, 'First', { emit: () => undefined })).reason).toBe('error');
  expect(llm.requests).toHaveLength(0);
  expect((await f.store.load(f.owner.id)).some((event) => event.type === 'memory/selection')).toBe(
    false,
  );
});

it('shows the prefix tradeoff against sliding selection using identical synthetic conversation sources', () => {
  const shared = [];
  let stable: RecallReceipt | undefined;
  let legacy: RecallReceipt | undefined;
  let stablePrefix = 0;
  let slidingPrefix = 0;
  const prefix = (a: RecallReceipt | undefined, b: RecallReceipt): number => {
    if (!a) return 0;
    let characters = 0;
    for (let i = 0; i < (a.dialogue?.length ?? 0); i++) {
      if (JSON.stringify(a.dialogue![i]) !== JSON.stringify(b.dialogue?.[i])) break;
      characters += a.dialogue![i]!.request.text.length + a.dialogue![i]!.answer.text.length;
    }
    return characters;
  };
  for (let i = 0; i < 10; i++) {
    const candidates = turn(i * 3 + 1, 100);
    shared.push(candidates);
    const selected = selectContextSegment(shared, stable, { ...options(), capacity: 4000 });
    const nextStable = { ...receipt(selected.dialogue), segment: selected.segment };
    const nextLegacy = receipt(shared.slice(-6));
    stablePrefix += prefix(stable, nextStable);
    slidingPrefix += prefix(legacy, nextLegacy);
    stable = nextStable;
    legacy = nextLegacy;
  }
  expect({ stablePrefix, slidingPrefix }).toEqual({ stablePrefix: 9000, slidingPrefix: 3000 });
  // These are reusable source characters, not provider tokens, hits, or money.
});
