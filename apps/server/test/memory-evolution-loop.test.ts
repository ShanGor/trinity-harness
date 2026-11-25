import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type {
  MemoryEvolutionStorePort,
  MemoryStorePort,
  SessionMeta,
  SessionMetaStore,
  MemoryFact,
} from '@trinity-harness/contracts';
import { memoryEvolutionEnvShape } from '@trinity-harness/contracts';
import { z } from 'zod';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  PersonalContext,
  createRecallTool,
} from '@trinity-harness/core';
import {
  FakeLLM,
  FakeSandbox,
  textChunks,
  toolCallThenFinish,
} from '@trinity-harness/core/testing';
import { EvolutionPersonalContext, createMemoryMergeTool } from '@trinity-harness/memory';

export function fakeEvolution(): MemoryEvolutionStorePort {
  return {
    revision: vi.fn(async () => 1),
    contextRevision: vi.fn(async () => 1),
    propose: vi.fn(),
    invalidate: vi.fn(),
    submit: vi.fn(),
    decide: vi.fn(),
    activeFacts: vi.fn(async () => []),
    list: vi.fn(async () => []),
    history: vi.fn(async () => ({
      revision: 1,
      facts: [],
      candidates: [],
      playbooks: [],
      nextBefore: null,
    })),
    pending: vi.fn(async () => ({
      revision: 1,
      facts: [],
      candidates: [],
      playbooks: [],
      nextBefore: null,
    })),
  };
}
it('validates the shared switch identically and defaults off', () => {
  const schema = z.object(memoryEvolutionEnvShape);
  expect(schema.parse({}).MEMORY_EVOLUTION_ENABLED).toBe(false);
  expect(schema.parse({ MEMORY_EVOLUTION_ENABLED: 'true' }).MEMORY_EVOLUTION_ENABLED).toBe(true);
  for (const value of ['TRUE', 'yes', '1', ''])
    expect(() => schema.parse({ MEMORY_EVOLUTION_ENABLED: value })).toThrow();
});
it.each(['confirmed', 'concurrent', 'uncertain', 'source-revoked'] as const)(
  'refreshes an acknowledged archival merge after its complete result and fences concurrent changes (%s)',
  async (mode) => {
    const concurrent = mode === 'concurrent';
    const store = new MemorySessionStore();
    const at = new Date().toISOString();
    const meta: SessionMeta = {
      id: randomUUID(),
      tenantId: randomUUID(),
      userId: randomUUID(),
      scope: 'personal',
      kind: 'work',
      sessionRole: 'task',
      workspaceUri: '/workspace',
      title: 'Nightly',
      createdAt: at,
    };
    const metas: SessionMetaStore = {
      get: async () => meta,
      create: vi.fn(),
      listForIdentity: async () => [meta],
      setTitleIfEmpty: vi.fn(),
      close: vi.fn(),
      setPolicy: vi.fn(),
    };
    const memory: MemoryStorePort = {
      snapshot: async () => ({ revision: 0, hasSuppression: false, items: [] }),
      change: vi.fn(),
    };
    const index = { history: async () => ({ episodes: [], nextBefore: null }), revise: vi.fn() };
    const source = {
      sourceEpisodeId: randomUUID(),
      sourceEventId: randomUUID(),
      sourceSessionId: randomUUID(),
      sourceQuote: 'I prefer tea.',
    };
    const first: MemoryFact = {
      factId: randomUUID(),
      kind: 'preference',
      text: 'Prefers tea.',
      revision: 1,
      validFrom: at,
      validTo: null,
      source,
    };
    const second: MemoryFact = { ...first, factId: randomUUID(), revision: 2 };
    const merged: MemoryFact = { ...first, factId: randomUUID(), revision: 3 };
    let revision = 2;
    let active = [first, second];
    const evolution = fakeEvolution();
    evolution.contextRevision = async () => revision;
    evolution.revision = async () => revision;
    evolution.activeFacts = async () => active;
    evolution.merge = vi.fn(async () => {
      active = mode === 'source-revoked' ? [] : [merged];
      revision = concurrent ? 4 : 3;
      if (mode === 'uncertain') throw new Error('Lost response after durable merge');
      return merged;
    });
    const tools = new CoreToolRegistry(new FakeSandbox());
    tools.register(createRecallTool({ memory, index, metas, store, evolution }));
    tools.register(
      createMemoryMergeTool({
        evolution,
        memory,
        metas,
        users: {
          findById: async () => ({
            id: meta.userId,
            tenantId: meta.tenantId,
            role: 'member',
            email: 'synthetic@example.test',
            createdAt: at,
          }),
        },
      }),
    );
    const model = new FakeLLM(
      () => toolCallThenFinish('facts', 'recall', { type: 'facts' }),
      () =>
        toolCallThenFinish('merge', 'memory_merge', {
          factIds: [first.factId, second.factId],
          expectedRevision: 2,
        }),
      () => textChunks('Merged the duplicate facts.'),
    );
    await store.append(meta.id, [
      {
        type: 'session/created',
        eventId: randomUUID(),
        at,
        kind: 'work',
        sessionRole: 'task',
        workspaceUri: '/workspace',
      },
    ]);
    const result = await new CoreAgentLoop({
      llm: model,
      model: 'fake/model',
      tools,
      store,
      workspaceRoot: '/workspace',
      sessionMetas: metas,
      personalContext: new EvolutionPersonalContext(
        new PersonalContext(memory, index, store, evolution),
        evolution,
        store,
      ),
    }).run(meta.id, 'Merge equivalent facts.', { emit: () => undefined }, { actor: meta.userId });
    expect(result.reason).toBe(mode === 'confirmed' ? 'completed' : 'error');
    expect(evolution.merge).toHaveBeenCalledTimes(1);
    const logs = await store.load(meta.id);
    const resultIndex = logs.findIndex(
      (event) => event.type === 'tool/result' && event.callId === 'merge',
    );
    expect(logs[resultIndex]).toMatchObject(
      mode === 'uncertain' ? { isError: true } : { isError: false, value: { status: 'merged' } },
    );
    if (mode === 'confirmed') {
      expect(model.requests).toHaveLength(3);
      const selectionIndex = logs.findLastIndex((event) => event.type === 'memory/selection');
      expect(selectionIndex).toBeGreaterThan(resultIndex);
      expect(logs[selectionIndex]).toMatchObject({
        receipt: { evolutionRevision: 3, policyRevision: 0 },
      });
      expect(
        model.requests[2]!.messages.some(
          (message) => message.role === 'tool' && message.toolCallId === 'facts',
        ),
      ).toBe(false);
      expect(
        model.requests[2]!.messages.some(
          (message) => message.role === 'tool' && message.toolCallId === 'merge',
        ),
      ).toBe(true);
    } else expect(model.requests).toHaveLength(2);
  },
);
it.each([false, true])(
  'commits v3 fact snapshots before dispatch and fences source/revision changes (%s)',
  async (invalidate) => {
    const store = new MemorySessionStore();
    const meta: SessionMeta = {
      id: randomUUID(),
      tenantId: randomUUID(),
      userId: randomUUID(),
      scope: 'personal',
      kind: 'chat',
      sessionRole: 'side',
      title: 'Test',
      workspaceUri: '/workspace',
      createdAt: new Date().toISOString(),
    };
    const metas: SessionMetaStore = {
      get: async () => meta,
      create: vi.fn(),
      listForIdentity: async () => [meta],
      setTitleIfEmpty: vi.fn(),
      close: vi.fn(),
      setPolicy: vi.fn(),
    };
    const memory: MemoryStorePort = {
      snapshot: async () => ({ revision: 0, hasSuppression: false, items: [] }),
      change: vi.fn(),
    };
    const index = {
      history: vi.fn(async () => ({ episodes: [], nextBefore: null })),
      revise: vi.fn(),
    };
    const fact: MemoryFact = {
      factId: randomUUID(),
      kind: 'preference',
      text: 'Prefers tea.',
      validFrom: meta.createdAt,
      validTo: null,
      revision: 1,
      source: {
        sourceEpisodeId: randomUUID(),
        sourceEventId: randomUUID(),
        sourceSessionId: randomUUID(),
        sourceQuote: 'I prefer tea.',
      },
    };
    const evolution = fakeEvolution();
    let revision = 1;
    evolution.contextRevision = async () => revision;
    evolution.activeFacts = async () => {
      return [fact];
    };
    const tools = new CoreToolRegistry(new FakeSandbox());
    tools.register(createRecallTool({ memory, index, metas, store, evolution }));
    const context = new EvolutionPersonalContext(
      new PersonalContext(memory, index, store, evolution),
      evolution,
      store,
    );
    await store.append(meta.id, [
      {
        type: 'session/created',
        eventId: randomUUID(),
        at: meta.createdAt,
        kind: 'chat',
        sessionRole: 'side',
        workspaceUri: '/workspace',
      },
    ]);
    if (invalidate) {
      const observe = context.observeRecall.bind(context);
      vi.spyOn(context, 'observeRecall').mockImplementation((receipt, results) => {
        const value = observe(receipt, results);
        revision = 2;
        return value;
      });
    }
    const model = new FakeLLM(
      () => toolCallThenFinish('facts', 'recall', { type: 'facts' }),
      () => textChunks('You prefer tea.'),
    );
    const result = await new CoreAgentLoop({
      llm: model,
      model: 'fake/model',
      tools,
      store,
      workspaceRoot: '/workspace',
      personalContext: context,
      sessionMetas: metas,
    }).run(
      meta.id,
      'What drink do I prefer?',
      { emit: () => undefined },
      { actor: meta.userId, contextGuard: async () => undefined },
    );
    expect(result.reason).toBe(invalidate ? 'error' : 'completed');
    expect(model.requests).toHaveLength(invalidate ? 1 : 2);
    if (!invalidate) {
      const logs = await store.load(meta.id);
      const receiptIndex = logs.findLastIndex((e) => e.type === 'memory/selection');
      expect(logs[receiptIndex]).toMatchObject({
        type: 'memory/selection',
        receipt: { version: 3, evolutionRevision: 1, facts: [fact] },
      });
      const modelContext = logs.findLast((e) => e.type === 'model/context');
      expect(modelContext?.type === 'model/context' && modelContext.sourceToSeq).toBeGreaterThan(
        receiptIndex,
      );
      expect(JSON.stringify(model.requests[1]!.messages)).toContain('Prefers tea.');
      const receipt = logs[receiptIndex];
      if (receipt?.type === 'memory/selection')
        await expect(
          new PersonalContext(memory, index, store).validate(meta, receipt.receipt),
        ).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_CHANGED' });
    }
  },
);
it('keeps ordinary baseline chat available while the unused fact adapter is down', async () => {
  const store = new MemorySessionStore();
  const meta: SessionMeta = {
    id: randomUUID(),
    tenantId: randomUUID(),
    userId: randomUUID(),
    scope: 'personal',
    title: 'Test',
    workspaceUri: '/workspace',
    createdAt: new Date().toISOString(),
  };
  const baseline = {
    select: vi.fn(async () => ({
      promptId: randomUUID(),
      policyRevision: 0,
      memories: [],
      episodes: [],
      omitted: false,
    })),
    validate: vi.fn(async () => undefined),
  };
  const evolution = fakeEvolution();
  evolution.contextRevision = vi.fn(async () => {
    throw new Error('offline');
  });
  const context = new EvolutionPersonalContext(baseline, evolution, store);
  const receipt = await context.select(meta, randomUUID(), 'hello');
  await context.validate(meta, receipt);
  expect(receipt.injectedFacts).toBeUndefined();
  expect(receipt.evolutionRevision).toBeUndefined();
  expect(evolution.contextRevision).toHaveBeenCalledTimes(1);
});

it('retires old archival recall pairs after a committed own-Persona correction', async () => {
  const store = new MemorySessionStore();
  const promptId = randomUUID();
  const meta: SessionMeta = {
    id: randomUUID(),
    tenantId: randomUUID(),
    userId: randomUUID(),
    scope: 'personal',
    title: 'Test',
    workspaceUri: '/workspace',
    createdAt: new Date().toISOString(),
  };
  await store.append(meta.id, [
    {
      type: 'message/user',
      eventId: promptId,
      at: meta.createdAt,
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'Correct my preference.' }],
    },
    {
      type: 'tool/call',
      eventId: randomUUID(),
      at: meta.createdAt,
      callId: 'old-recall',
      name: 'recall',
      args: { type: 'facts' },
    },
    {
      type: 'tool/result',
      eventId: randomUUID(),
      at: meta.createdAt,
      callId: 'old-recall',
      isError: false,
      value: { policyRevision: 0, evolutionRevision: 1, facts: [] },
    },
  ]);
  const evolution = fakeEvolution();
  evolution.contextRevision = vi.fn(async () => {
    throw new Error('old archival context is unavailable');
  });
  const receipt = {
    version: 3 as const,
    promptId,
    policyRevision: 1,
    recallAfterSeq: 3,
    memories: [],
    episodes: [],
    omitted: false,
  };
  const context = new EvolutionPersonalContext(
    { select: async () => receipt, validate: async () => undefined },
    evolution,
    store,
  );
  await context.validate(meta, receipt);
  expect(evolution.contextRevision).not.toHaveBeenCalled();
});
