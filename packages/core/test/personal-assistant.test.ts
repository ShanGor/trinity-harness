import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  parsePermissionPolicy,
  suggestTopic,
  type MemoryStorePort,
  type ConversationIndexPort,
  type SessionMeta,
  type SessionMetaStore,
  type RecallReceipt,
  type SessionEvent,
} from '@trinity-harness/contracts';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  PersonalContext,
  personalModelMessages,
  validateMemoryCommand,
  writeFileTool,
} from '../src/index.js';
import { FakeLLM, textChunks, toolCallThenFinish } from '../src/testing/fake-llm.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';

const at = '2026-10-20T09:00:00.000Z';
function meta(): SessionMeta {
  return {
    id: randomUUID(),
    userId: randomUUID(),
    tenantId: randomUUID(),
    title: 'Main chat',
    kind: 'chat',
    sessionRole: 'main',
    scope: 'personal',
    workspaceUri: null,
    createdAt: at,
  };
}
function emptyReceipt(promptId: string): RecallReceipt {
  return { promptId, policyRevision: 1, memories: [], episodes: [], omitted: false };
}

it.each(['workspace-write', 'read-only'])(
  'gives Chat configured tools while enforcing %s policy',
  async (policy) => {
    const store = new MemorySessionStore();
    const owner = meta();
    await store.append(owner.id, [
      {
        eventId: randomUUID(),
        at,
        type: 'session/created',
        workspaceUri: '/ws',
        kind: 'chat',
        sessionRole: 'side',
      },
    ]);
    const sandbox = new FakeSandbox();
    const tools = new CoreToolRegistry(sandbox);
    tools.register(writeFileTool);
    const browser = vi.fn(async () => ({ value: { title: 'Observed docs' }, isError: false }));
    tools.register({
      name: 'browser',
      description: 'Read docs',
      parameters: z.object({ operation: z.literal('read_page') }),
      execute: browser,
    });
    const prepare = vi.fn(async () => undefined);
    const augmented = vi.fn(async () => 'Current workspace context');
    const llm = new FakeLLM(
      () => toolCallThenFinish('docs', 'browser', { operation: 'read_page' }),
      () =>
        toolCallThenFinish('file', 'write_file', { path: 'notes.txt', content: 'observed docs' }),
      () => textChunks('Research done.'),
    );
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools,
      store,
      workspaceRoot: '/ws',
      skills: { prepare, load: vi.fn() },
      augmentSystem: augmented,
    });
    await loop.run(
      owner.id,
      'Research and save notes',
      { emit: () => undefined },
      { policy: parsePermissionPolicy(policy) },
    );
    expect(llm.requests[0]!.tools?.map((tool) => tool.name)).toEqual(['write_file', 'browser']);
    expect(llm.requests[0]!.system).toContain('ad-hoc Chat');
    expect(llm.requests[0]!.system).toContain('Current workspace context');
    expect(prepare).toHaveBeenCalled();
    expect(augmented).toHaveBeenCalled();
    expect(browser).toHaveBeenCalledTimes(1);
    expect(sandbox.files.has('notes.txt')).toBe(policy === 'workspace-write');
    expect(
      (await store.load(owner.id)).find(
        (event) => event.type === 'tool/result' && event.callId === 'file',
      ),
    ).toMatchObject({ isError: policy === 'read-only' });
  },
);

it('fails closed for a null or mismatched Chat workspace before model dispatch', async () => {
  for (const workspaceUri of [null, '/other']) {
    const store = new MemorySessionStore();
    const id = randomUUID();
    await store.append(id, [
      { eventId: randomUUID(), at, type: 'session/created', kind: 'chat', workspaceUri },
    ]);
    const llm = new FakeLLM();
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools: new CoreToolRegistry(new FakeSandbox()),
      store,
      workspaceRoot: '/ws',
    });
    expect((await loop.run(id, 'Research', { emit: () => undefined })).reason).toBe('error');
    expect(llm.requests).toEqual([]);
    expect((await store.load(id)).at(-1)).toMatchObject({
      type: 'turn/end',
      detail: 'Chat workspace must be bound before execution',
    });
  }
});

it('persists the exact memory selection before dispatch, and ignores old checkpoints after forgetting', async () => {
  const store = new MemorySessionStore();
  const owner = meta();
  await store.append(owner.id, [
    { eventId: randomUUID(), at, type: 'session/created', workspaceUri: '/ws', kind: 'chat' },
    {
      eventId: randomUUID(),
      at,
      type: 'compaction/summary',
      checkpoint: true,
      fromSeq: 1,
      toSeq: 1,
      summary: 'OLD FORGOTTEN VALUE',
    },
  ]);
  const llm = new FakeLLM((request) => {
    expect(JSON.stringify(request.messages)).not.toContain('OLD FORGOTTEN VALUE');
    return textChunks('I do not have a saved value.');
  });
  const select = vi.fn(async (_meta: SessionMeta, promptId: string) => emptyReceipt(promptId));
  const metas = { get: async () => owner } as unknown as SessionMetaStore;
  const loop = new CoreAgentLoop({
    llm,
    model: 'fake/model',
    tools: new CoreToolRegistry(new FakeSandbox()),
    store,
    workspaceRoot: '/ws',
    personalContext: { select },
    sessionMetas: metas,
  });
  await loop.run(owner.id, 'What is my preference?', { emit: () => undefined });
  const events = await store.load(owner.id);
  expect(events.findIndex((event) => event.type === 'memory/selection')).toBeLessThan(
    events.findIndex((event) => event.type === 'model/usage'),
  );
  expect(select).toHaveBeenCalledTimes(1);
});

it('does not retrieve personal memory for team execution and fences suppressed episode recall', async () => {
  const snapshot = vi.fn(async () => ({ revision: 9, items: [], hasSuppression: true }));
  const history = vi.fn(async () => ({
    episodes: [
      {
        episodeId: 'old',
        promptId: 'old',
        policyRevision: 0,
        excluded: false,
        request: 'old topic',
      },
    ],
    nextBefore: null,
  }));
  const context = new PersonalContext(
    { snapshot } as unknown as MemoryStorePort,
    { history } as unknown as ConversationIndexPort,
  );
  const owner = meta();
  await context.select({ ...owner, scope: 'team', scopeId: randomUUID() }, randomUUID(), 'Recall');
  expect(snapshot).not.toHaveBeenCalled();
  expect(history).not.toHaveBeenCalled();
  expect(await context.select(owner, randomUUID(), 'Recall')).toMatchObject({
    policyRevision: 9,
    omitted: false,
    episodes: [],
  });
  expect(history).not.toHaveBeenCalled();
});

it('keeps active tool pairs while excluding historical selections from a fresh request', () => {
  const promptId = randomUUID();
  const events: SessionEvent[] = [
    {
      eventId: randomUUID(),
      at,
      type: 'memory/selection',
      receipt: {
        ...emptyReceipt(randomUUID()),
        memories: [
          {
            memoryId: randomUUID(),
            revision: 1,
            subject: 'me',
            predicate: 'value',
            value: 'old',
            status: 'active',
            recordedAt: at,
          },
        ],
      },
    },
    {
      eventId: promptId,
      at,
      type: 'message/user',
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'Current' }],
    },
    { eventId: randomUUID(), at, type: 'tool/call', callId: 'call', name: 'read_blob', args: {} },
    {
      eventId: randomUUID(),
      at,
      type: 'tool/result',
      callId: 'call',
      value: { text: 'evidence' },
      isError: false,
    },
  ];
  const messages = personalModelMessages(events, emptyReceipt(promptId));
  expect(messages.some((message) => message.role === 'tool' && message.toolCallId === 'call')).toBe(
    true,
  );
  expect(JSON.stringify(messages)).not.toContain('"value":"old"');
});

describe('topic indexing and explicit saves', () => {
  it('keeps uncertain topic labels from inheriting an unrelated prior subject', () => {
    const previous = [{ topic: 'Trinity UI', request: 'Redesign Trinity UI' }];
    expect(suggestTopic('Can you expand on that?', previous)).toBe('Can you expand on that?');
    expect(suggestTopic('Unrelated: Kyoto trip', previous)).toBe('Kyoto trip');
    expect(
      suggestTopic('Back to Trinity UI', [
        { topic: 'Kyoto', request: 'Travel dates' },
        ...previous,
      ]),
    ).toBe('Trinity UI');
  });
  it('rejects credential saves without echoing content', () => {
    expect(() =>
      validateMemoryCommand({
        operationId: randomUUID(),
        memoryId: randomUUID(),
        expectedRevision: 0,
        operation: 'save',
        subject: 'Me',
        predicate: 'API key',
        value: 'secret-value',
      }),
    ).toThrow('Credentials must use secret storage');
  });
});

it('drains queued prompts in source order after reversed delivery and deduplicates completed turns', async () => {
  const { runOrderedPrompts } = await import('../src/personal-assistant/ordered-turns.js');
  const store = new MemorySessionStore();
  const owner = meta();
  const ids = [randomUUID(), randomUUID()];
  await store.append(
    owner.id,
    ids.map((promptId, i) => ({
      eventId: randomUUID(),
      at,
      type: 'prompt/queued' as const,
      promptId,
      content: [{ kind: 'text' as const, text: `request ${i}` }],
      actor: owner.userId,
      tenantId: owner.tenantId,
      policy: parsePermissionPolicy('read-only'),
    })),
  );
  const calls: string[] = [];
  const run = {
    run: async <T>(_id: string, operation: () => Promise<T>): Promise<T> => operation(),
  };
  const task = {
    sessionId: owner.id,
    actor: owner.userId,
    tenantId: owner.tenantId,
    promptSeq: 2,
    prompt: 'request 1',
    policy: parsePermissionPolicy('read-only'),
  };
  const execute = async (ordered: typeof task): Promise<void> => {
    calls.push(ordered.prompt);
    const user = (await store.load(owner.id))[ordered.promptSeq - 1]!;
    expect(user.type).toBe('message/user');
    await store.append(owner.id, [
      { type: 'turn/end', eventId: randomUUID(), at, reason: 'completed', promptId: user.eventId },
    ]);
  };
  await runOrderedPrompts(run, store, task, execute);
  await runOrderedPrompts(run, store, { ...task, promptSeq: 1 }, execute);
  expect(calls).toEqual(['request 0', 'request 1']);
});

it('cancels unpromoted queued prompts without fabricating assistant turns', async () => {
  const { runOrderedPrompts } = await import('../src/personal-assistant/ordered-turns.js');
  const store = new MemorySessionStore();
  const owner = meta();
  await store.append(owner.id, [
    {
      eventId: randomUUID(),
      at,
      type: 'prompt/queued',
      promptId: randomUUID(),
      content: [{ kind: 'text', text: 'queued' }],
      actor: owner.userId,
      tenantId: owner.tenantId,
      policy: parsePermissionPolicy('read-only'),
    },
    { type: 'turn/cancel_requested', eventId: randomUUID(), at, throughPromptSeq: 1 },
  ]);
  const execute = vi.fn();
  await runOrderedPrompts(
    { run: async <T>(_id: string, operation: () => Promise<T>): Promise<T> => operation() },
    store,
    {
      sessionId: owner.id,
      promptSeq: 1,
      prompt: 'queued',
      actor: owner.userId,
      tenantId: owner.tenantId,
      policy: parsePermissionPolicy('read-only'),
    },
    execute,
  );
  expect(execute).not.toHaveBeenCalled();
  const events = await store.load(owner.id);
  expect(events.at(-1)?.type).toBe('prompt/discarded');
  expect(
    events.some((event) => event.type === 'message/user' || event.type === 'message/assistant'),
  ).toBe(false);
});

it('stops before another model request when memory is corrected during an active turn', async () => {
  const store = new MemorySessionStore();
  const owner = meta();
  await store.append(owner.id, [
    { type: 'session/created', eventId: randomUUID(), at, kind: 'chat', workspaceUri: '/ws' },
  ]);
  let revision = 1;
  const llm = new FakeLLM(() => {
    revision = 2;
    return toolCallThenFinish('denied', 'write_file', { path: 'a', content: 'b' });
  });
  const loop = new CoreAgentLoop({
    llm,
    model: 'fake/model',
    tools: new CoreToolRegistry(new FakeSandbox()),
    store,
    workspaceRoot: '/ws',
    sessionMetas: { get: async () => owner } as unknown as SessionMetaStore,
    personalContext: {
      validate: async (_meta, receipt) => {
        if (receipt.policyRevision !== revision)
          throw new Error('Memory or recall permissions changed during this response.');
      },
      select: async (_meta, promptId) => ({ ...emptyReceipt(promptId), policyRevision: revision }),
    },
  });
  expect((await loop.run(owner.id, 'Inspect', { emit: () => undefined })).reason).toBe('error');
  expect(llm.requests).toHaveLength(1);
  expect((await store.load(owner.id)).at(-1)).toMatchObject({
    type: 'turn/end',
    detail: expect.stringContaining('Memory or recall permissions changed'),
  });
});

it('retains active checkpoints only for their original prompt and memory policy revision', () => {
  const promptId = randomUUID();
  const events: SessionEvent[] = [
    {
      type: 'message/user',
      eventId: promptId,
      at,
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'Current task' }],
    },
    { type: 'tool/call', eventId: randomUUID(), at, callId: 'r', name: 'read_blob', args: {} },
    {
      type: 'tool/result',
      eventId: randomUUID(),
      at,
      callId: 'r',
      value: 'Evidence',
      isError: false,
    },
    {
      type: 'compaction/summary',
      eventId: randomUUID(),
      at,
      fromSeq: 1,
      toSeq: 3,
      checkpoint: true,
      summary: 'Active checkpoint',
      memoryPromptId: promptId,
      memoryPolicyRevision: 1,
    },
  ];
  expect(JSON.stringify(personalModelMessages(events, emptyReceipt(promptId)))).toContain(
    'Active checkpoint',
  );
  expect(
    JSON.stringify(personalModelMessages(events, { ...emptyReceipt(promptId), policyRevision: 2 })),
  ).not.toContain('Active checkpoint');
});

it('propagates a parent context fence into child model and tool work', async () => {
  const store = new MemorySessionStore();
  const llm = new FakeLLM(() => textChunks('Must not be sent'));
  const loop = new CoreAgentLoop({
    llm,
    model: 'fake/model',
    tools: new CoreToolRegistry(new FakeSandbox()),
    store,
    workspaceRoot: '/ws',
  });
  const outcome = await loop.run(
    randomUUID(),
    'Child request',
    { emit: () => undefined },
    {
      contextGuard: async () => {
        throw new Error('Parent memory changed');
      },
    },
  );
  expect(outcome.reason).toBe('error');
  expect(llm.requests).toEqual([]);
});

describe('interrupted objective recall', () => {
  const request = 'Compare local models for agent accuracy, speed, stability and cost';
  async function fixture(reason: 'error' | 'aborted' | 'interrupted' | 'completed' = 'error') {
    const store = new MemorySessionStore();
    const owner = meta();
    const original = randomUUID();
    const followup = randomUUID();
    await store.append(owner.id, [
      { eventId: randomUUID(), at, type: 'session/created', kind: 'chat', workspaceUri: '/ws' },
      {
        eventId: original,
        at,
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: request }],
      },
      { eventId: randomUUID(), at, type: 'memory/selection', receipt: emptyReceipt(original) },
      {
        eventId: randomUUID(),
        at,
        type: 'message/assistant',
        phase: 'progress',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'OLD PROGRESS' }],
      },
      {
        eventId: randomUUID(),
        at,
        type: 'tool/call',
        callId: 'old-browser',
        name: 'browser',
        args: { url: 'OLD URL' },
      },
      {
        eventId: randomUUID(),
        at,
        type: 'tool/result',
        callId: 'old-browser',
        value: { text: 'OLD TOOL BODY' },
        isError: false,
      },
      ...(reason === 'interrupted'
        ? []
        : [{ eventId: randomUUID(), at, type: 'turn/end' as const, promptId: original, reason }]),
      {
        eventId: followup,
        at,
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'contine' }],
      },
    ]);
    const snapshot = vi.fn(async () => ({ revision: 1, items: [], hasSuppression: false }));
    const evidence = vi.fn(async () => null);
    const context = new PersonalContext(
      { snapshot } as unknown as MemoryStorePort,
      {
        history: async () => ({ episodes: [], nextBefore: null }),
        evidence,
      } as unknown as ConversationIndexPort,
      store,
    );
    return { store, owner, original, followup, snapshot, evidence, context };
  }

  it('fences removed source receipts and omits the original objective from fresh amended context', async () => {
    const f = await fixture('error');
    const receipt = await f.context.select(f.owner, f.followup, 'contine');
    await f.store.append(f.owner.id, [
      { type: 'message/removed', eventId: randomUUID(), at, promptId: f.original, role: 'user' },
    ]);
    await expect(f.context.validate(f.owner, receipt)).rejects.toMatchObject({
      code: 'MEMORY_CONTEXT_CHANGED',
    });
    const updated = await f.context.select(f.owner, f.followup, 'contine');
    expect(updated.interruptedTurns ?? []).toEqual([]);
    expect(
      JSON.stringify(personalModelMessages(await f.store.load(f.owner.id), receipt)),
    ).not.toContain(request);
  });

  it.each(['error', 'aborted', 'interrupted'] as const)(
    'keeps the objective after %s with empty indexed recall, including replay',
    async (reason) => {
      const f = await fixture(reason);
      const receipt = await f.context.select(f.owner, f.followup, 'contine');
      expect(receipt.interruptedTurns).toEqual([
        expect.objectContaining({ promptId: f.original, request, reason, fromSeq: 2 }),
      ]);
      const events = await f.store.load(f.owner.id);
      const messages = personalModelMessages(events, receipt);
      const body = JSON.stringify(messages);
      expect(body).toContain(request);
      expect(body).toContain('contine');
      expect(body).not.toMatch(/OLD PROGRESS|OLD URL|OLD TOOL BODY/);
      await f.context.validate(f.owner, receipt);
      expect(personalModelMessages(events, JSON.parse(JSON.stringify(receipt)))).toEqual(messages);
    },
  );

  it('sends the retained original objective on every model step of a continuation', async () => {
    const f = await fixture();
    const llm = new FakeLLM(
      () => toolCallThenFinish('current', 'read_file', { path: 'notes.txt' }),
      () => textChunks('Resumed comparison.'),
    );
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools: new CoreToolRegistry(new FakeSandbox()),
      store: f.store,
      workspaceRoot: '/ws',
      personalContext: f.context,
      sessionMetas: { get: async () => f.owner } as unknown as SessionMetaStore,
    });
    const events = await f.store.load(f.owner.id);
    await loop.run(f.owner.id, 'contine', { emit: () => undefined }, { promptSeq: events.length });
    expect(llm.requests).toHaveLength(2);
    for (const call of llm.requests) {
      expect(JSON.stringify(call.messages)).toContain(request);
      expect(JSON.stringify(call.messages)).not.toContain('OLD TOOL BODY');
    }
    const recorded = (await f.store.load(f.owner.id)).filter(
      (event) => event.type === 'memory/selection' && event.receipt.promptId === f.followup,
    );
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.at(-1)).toMatchObject({
      receipt: { interruptedTurns: [expect.objectContaining({ request })] },
    });
  });

  it('does not bypass a correction or forgetting fence with failed-turn history', async () => {
    const f = await fixture();
    f.snapshot.mockResolvedValue({ revision: 2, items: [], hasSuppression: true });
    expect(
      (await f.context.select(f.owner, f.followup, 'contine')).interruptedTurns,
    ).toBeUndefined();
  });

  it('fences an exclusion made after selection', async () => {
    const f = await fixture();
    const receipt = await f.context.select(f.owner, f.followup, 'contine');
    f.evidence.mockResolvedValue({ excluded: true } as never);
    expect(
      (await f.context.select(f.owner, f.followup, 'contine')).interruptedTurns,
    ).toBeUndefined();
    await expect(f.context.validate(f.owner, receipt)).rejects.toMatchObject({
      code: 'MEMORY_CONTEXT_CHANGED',
    });
  });

  it('does not inject completed turns or other sessions through the interrupted fallback', async () => {
    const f = await fixture('completed');
    expect(
      (await f.context.select(f.owner, f.followup, 'contine')).interruptedTurns,
    ).toBeUndefined();
    expect(
      (await f.context.select({ ...f.owner, id: randomUUID() }, randomUUID(), 'continue'))
        .interruptedTurns,
    ).toBeUndefined();
  });
});

it('retains the original interrupted objective after more than four continuation prompts', async () => {
  const store = new MemorySessionStore();
  const owner = meta();
  const original = randomUUID();
  await store.append(owner.id, [
    {
      eventId: original,
      at,
      type: 'message/user',
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'Original comparison objective' }],
    },
    { eventId: randomUUID(), at, type: 'turn/end', promptId: original, reason: 'error' },
  ]);
  for (let i = 0; i < 6; i++) {
    const promptId = randomUUID();
    await store.append(owner.id, [
      {
        eventId: promptId,
        at,
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: `Continue attempt ${i}` }],
      },
      { eventId: randomUUID(), at, type: 'turn/end', promptId, reason: 'error' },
    ]);
  }
  const current = randomUUID();
  await store.append(owner.id, [
    {
      eventId: current,
      at,
      type: 'message/user',
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'continue' }],
    },
  ]);
  const context = new PersonalContext(
    {
      snapshot: async () => ({ revision: 0, items: [], hasSuppression: false }),
    } as unknown as MemoryStorePort,
    {
      history: async () => ({ episodes: [], nextBefore: null }),
    } as unknown as ConversationIndexPort,
    store,
  );
  const receipt = await context.select(owner, current, 'continue');
  expect(receipt.interruptedTurns).toHaveLength(4);
  expect(receipt.interruptedTurns?.[0]).toMatchObject({
    promptId: original,
    request: 'Original comparison objective',
  });
  expect(receipt.interruptedTurns?.at(-1)?.request).toBe('Continue attempt 5');
});
