import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  memorySearchTerms,
  personaToolParametersSchema,
  isNightlyMemorySource,
  type MemoryStorePort,
  type SessionMetaStore,
  type UserStore,
  type SessionMeta,
  type Persona,
  type PersonaChange,
  type RunTurnOptions,
  type TopicEpisode,
} from '@trinity-harness/contracts';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  PersonalContext,
  createPersonaTool,
  editPersona,
} from '../src/index.js';
import { FakeLLM, textChunks, toolCallThenFinish } from '../src/testing/fake-llm.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';

const at = '2026-11-09T00:00:00.000Z';
async function fixture(autoSaveEnabled = true) {
  const store = new MemorySessionStore();
  const tenantId = randomUUID();
  const userId = randomUUID();
  let persona: Persona | undefined;
  if (!autoSaveEnabled)
    persona = { content: '', revision: 1, updatedAt: at, autoSaveEnabled: false };
  const writes: PersonaChange[] = [];
  const memory: MemoryStorePort = {
    snapshot: async () => ({
      revision: persona?.revision ?? 0,
      items: [],
      hasSuppression: !!persona,
      ...(persona ? { persona } : {}),
    }),
    change: vi.fn(),
    savePersona: vi.fn(async (_identity, change) => {
      if (change.expectedRevision !== (persona?.revision ?? 0)) throw new Error('conflict');
      writes.push(change);
      persona = {
        content: change.content,
        revision: change.expectedRevision + 1,
        updatedAt: at,
        autoSaveEnabled: persona?.autoSaveEnabled ?? true,
      };
      return persona;
    }),
  };
  const sessions = new Map<string, SessionMeta>();
  const metas = { get: async (id: string) => sessions.get(id) ?? null } as SessionMetaStore;
  const users: Pick<UserStore, 'findById'> = {
    findById: async () => ({
      id: userId,
      tenantId,
      role: 'developer',
      email: 'test@example.com',
      createdAt: at,
    }),
  };
  const index = {
    history: async () => ({ episodes: [], nextBefore: null }),
    revise: vi.fn(),
    evidence: vi.fn<(...args: unknown[]) => Promise<TopicEpisode | null>>(async () => null),
  };
  const context = new PersonalContext(memory, index, store);
  const tools = new CoreToolRegistry(new FakeSandbox());
  tools.register(createPersonaTool({ memory, metas, store, users, index }));
  const session = async (scope: 'personal' | 'team' = 'personal'): Promise<SessionMeta> => {
    const meta: SessionMeta = {
      id: randomUUID(),
      userId,
      tenantId,
      scope,
      title: 'Personal chat',
      kind: 'chat',
      sessionRole: 'side',
      workspaceUri: '/workspace',
      createdAt: at,
    };
    sessions.set(meta.id, meta);
    await store.append(meta.id, [
      {
        type: 'session/created',
        eventId: randomUUID(),
        at,
        kind: 'chat',
        sessionRole: 'side',
        workspaceUri: '/workspace',
      },
    ]);
    return meta;
  };
  const run = async (meta: SessionMeta, prompt: string, llm: FakeLLM, options?: RunTurnOptions) =>
    new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools,
      store,
      workspaceRoot: '/workspace',
      personalContext: context,
      sessionMetas: metas,
      verification: true,
    }).run(
      meta.id,
      prompt,
      { emit: () => undefined },
      { actor: userId, contextGuard: async () => undefined, ...options },
    );
  return {
    store,
    memory,
    tools,
    session,
    run,
    writes,
    index,
    get persona() {
      return persona;
    },
  };
}

it('automatically saves a name, recalls it across sessions, corrects it and forgets it without aborting the turn', async () => {
  const f = await fixture();
  const first = await f.session();
  const introduced = new FakeLLM(
    () =>
      toolCallThenFinish('save-name', 'persona', {
        operation: 'update',
        expectedRevision: 0,
        sourceQuote: '我叫小张',
        edits: [{ oldText: '', newText: '## 基本信息\n我叫小张。' }],
      }),
    () => textChunks('我记住了。'),
  );
  await f.run(first, '你好，我叫小张。', introduced);
  expect(
    (await f.store.load(first.id)).findLast((event) => event.type === 'turn/end'),
  ).toMatchObject({ reason: 'completed' });
  expect(f.writes[0]?.source).toMatchObject({ sessionId: first.id, excerpt: '我叫小张' });
  expect(introduced.requests[1]?.messages.map((message) => message.content).join('\n')).toContain(
    '我叫小张。',
  );
  const selections = (await f.store.load(first.id)).filter(
    (event) => event.type === 'memory/selection',
  );
  expect(selections).toHaveLength(2);
  const second = await f.session();
  const recalled = new FakeLLM(() => textChunks('你叫小张。'));
  expect((await f.run(second, '我叫什么名字？', recalled)).reason).toBe('completed');
  expect(JSON.stringify(recalled.requests[0]?.messages)).toContain('我叫小张');
  const correct = new FakeLLM(
    () =>
      toolCallThenFinish('correct-name', 'persona', {
        operation: 'update',
        expectedRevision: 1,
        sourceQuote: '我现在叫小李',
        edits: [{ oldText: '小张', newText: '小李' }],
      }),
    () => textChunks('已更正。'),
  );
  expect((await f.run(second, '更正一下，我现在叫小李。', correct)).reason).toBe('completed');
  expect(f.persona?.content).toContain('小李');
  const forget = new FakeLLM(
    () =>
      toolCallThenFinish('forget-name', 'persona', {
        operation: 'update',
        expectedRevision: 2,
        sourceQuote: '忘记我的名字',
        edits: [{ oldText: '我叫小李。', newText: '' }],
      }),
    () => textChunks('已忘记。'),
  );
  expect((await f.run(second, '请忘记我的名字。', forget)).reason).toBe('completed');
  expect(f.persona?.content).not.toContain('小李');
  const third = await f.session();
  const unknown = new FakeLLM(() => textChunks('当前没有保存你的名字。'));
  await f.run(third, '我叫什么？', unknown);
  expect(JSON.stringify(unknown.requests[0]?.messages)).not.toContain('小李');
});

it('honors auto-save off, while allowing an explicit remember request', async () => {
  const f = await fixture(false);
  const session = await f.session();
  const model = (quote: string) =>
    new FakeLLM(
      () =>
        toolCallThenFinish(randomUUID(), 'persona', {
          operation: 'update',
          expectedRevision: 1,
          sourceQuote: quote,
          edits: [{ oldText: '', newText: '我叫小张。' }],
        }),
      () => textChunks('完成。'),
    );
  await f.run(session, '我叫小张。', model('我叫小张'));
  expect(f.writes).toHaveLength(0);
  expect((await f.run(session, '请记住我叫小张。', model('请记住我叫小张'))).reason).toBe(
    'completed',
  );
  expect(f.writes).toHaveLength(1);
  expect(f.persona?.autoSaveEnabled).toBe(false);
});

it.each(['> 我叫小张', '```text\n我叫小张\n```', '请翻译："我叫小张"', '今天请帮我查天气'])(
  'rejects sources from quotes/code or absent from the user: %s',
  async (prompt) => {
    const f = await fixture();
    const session = await f.session();
    await f.run(
      session,
      prompt,
      new FakeLLM(
        () =>
          toolCallThenFinish('poison', 'persona', {
            operation: 'update',
            expectedRevision: 0,
            sourceQuote: '我叫小张',
            edits: [{ oldText: '', newText: '我叫小张。' }],
          }),
        () => textChunks('完成。'),
      ),
    );
    expect(f.writes).toHaveLength(0);
  },
);

it('rejects team writes and child writes', async () => {
  const f = await fixture();
  const session = await f.session('team');
  await f.run(
    session,
    '我叫小张',
    new FakeLLM(
      () =>
        toolCallThenFinish('team', 'persona', {
          operation: 'update',
          expectedRevision: 0,
          sourceQuote: '我叫小张',
          edits: [{ oldText: '', newText: '小张' }],
        }),
      () => textChunks('完成。'),
    ),
  );
  expect(f.writes).toHaveLength(0);
  const personal = await f.session();
  const result = await f.tools.execute(
    {
      name: 'persona',
      id: 'child',
      args: {
        operation: 'update',
        expectedRevision: 0,
        sourceQuote: '我叫小张',
        edits: [{ oldText: '', newText: '小张' }],
      },
    },
    { sessionId: personal.id, workspaceRoot: '/workspace' },
  );
  expect(result.isError).toBe(true);
  expect(f.writes).toHaveLength(0);
});

describe('memory patches and search', () => {
  it('preserves custom Markdown and fails ambiguous or oversized patches', () => {
    expect(editPersona('# 自定义\n小张\n喜欢茶', [{ oldText: '小张', newText: '小李' }])).toBe(
      '# 自定义\n小李\n喜欢茶',
    );
    expect(() => editPersona('小张 小张', [{ oldText: '小张', newText: '' }])).toThrow(
      'exactly once',
    );
    expect(() => editPersona('名字', [{ oldText: '缺失', newText: '' }])).toThrow();
    expect(() => editPersona('x'.repeat(16000), [{ oldText: '', newText: 'x' }])).toThrow('full');
  });
  it('segments Chinese and retains single-character names without query punctuation', () => {
    expect(memorySearchTerms('你知道我的名字吗？')).toContain('名字');
    expect(memorySearchTerms('我姓李')).toContain('李');
    expect(memorySearchTerms('What was the response language?')).toContain('language');
  });
});

it('uses a stable suppression floor so adding new facts does not hide unrelated older history', async () => {
  const store = new MemorySessionStore();
  const id = randomUUID();
  const first = randomUUID();
  const current = randomUUID();
  const owner: SessionMeta = {
    id,
    tenantId: randomUUID(),
    userId: randomUUID(),
    title: 'test',
    workspaceUri: '/workspace',
    scope: 'personal',
    createdAt: at,
    kind: 'chat',
    sessionRole: 'side',
  };
  await store.append(id, [
    {
      type: 'message/user',
      eventId: first,
      at,
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'Earlier project decision' }],
    },
    {
      type: 'message/assistant',
      eventId: randomUUID(),
      at,
      surfaceOp: 'append',
      phase: 'final',
      content: [{ kind: 'text', text: 'We chose PostgreSQL' }],
    },
    { type: 'turn/end', eventId: randomUUID(), at, promptId: first, reason: 'completed' },
    {
      type: 'message/user',
      eventId: current,
      at,
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'continue' }],
    },
  ]);
  const memory = {
    snapshot: async () => ({
      revision: 5,
      suppressionRevision: 2,
      hasSuppression: true,
      persona: { content: 'New addition', revision: 5, updatedAt: at },
      items: [],
    }),
  } as unknown as MemoryStorePort;
  const context = new PersonalContext(
    memory,
    {
      evidence: async () => ({ policyRevision: 3, excluded: false }) as never,
      history: async () => ({ episodes: [], nextBefore: null }),
      revise: vi.fn(),
    },
    store,
  );
  expect((await context.select(owner, current, 'continue')).dialogue).toHaveLength(1);
});

it('retires earlier recall pairs after its own write while retaining the append-only audit', async () => {
  const f = await fixture();
  const session = await f.session();
  f.tools.register({
    name: 'recall',
    description: 'fixture',
    parameters: z.object({}),
    effect: { kind: 'read', scope: 'reference' },
    execute: async () => ({
      isError: false,
      value: { episodes: [], policyRevision: 0, note: 'OLD-RECALLED-NAME' },
    }),
  });
  const llm = new FakeLLM(
    () => toolCallThenFinish('old-recall', 'recall', {}),
    () =>
      toolCallThenFinish('remember-after-recall', 'persona', {
        operation: 'update',
        expectedRevision: 0,
        sourceQuote: '我叫小张',
        edits: [{ oldText: '', newText: '我叫小张。' }],
      }),
    () => textChunks('记住了。'),
  );
  expect((await f.run(session, '我叫小张，之前说了什么？', llm)).reason).toBe('completed');
  expect(llm.requests).toHaveLength(3);
  expect(JSON.stringify(llm.requests[2]?.messages)).not.toContain('OLD-RECALLED-NAME');
  expect(JSON.stringify(await f.store.load(session.id))).toContain('OLD-RECALLED-NAME');
});

it('does not accept a concurrent external edit as its own context refresh', async () => {
  const f = await fixture();
  const session = await f.session();
  const save = vi.mocked(f.memory.savePersona!).getMockImplementation()!;
  vi.spyOn(f.memory, 'savePersona').mockImplementation(async (identity, change) => {
    const own = await save(identity, change);
    await save(identity, {
      content: 'Manual concurrent edit',
      expectedRevision: own.revision,
      operationId: randomUUID(),
    });
    return own;
  });
  const llm = new FakeLLM(
    () =>
      toolCallThenFinish('racing-save', 'persona', {
        operation: 'update',
        expectedRevision: 0,
        sourceQuote: '我叫小张',
        edits: [{ oldText: '', newText: '我叫小张。' }],
      }),
    () => textChunks('不得生成此回答'),
  );
  expect((await f.run(session, '我叫小张', llm)).reason).toBe('error');
  expect(llm.requests).toHaveLength(1);
  expect(f.persona?.content).toBe('Manual concurrent edit');
  expect(
    (await f.store.load(session.id)).some(
      (event) => event.type === 'tool/result' && event.callId === 'racing-save',
    ),
  ).toBe(true);
});

it('rejects Persona writes originating from a nightly review even with a call journal', async () => {
  const f = await fixture();
  const meta = await f.session();
  const promptId = randomUUID();
  await f.store.append(meta.id, [
    {
      type: 'message/user',
      surfaceOp: 'append',
      eventId: promptId,
      at,
      content: [{ kind: 'text', text: 'My name is Alex' }],
      trigger: {
        kind: 'schedule',
        consolidation: 'review',
        scheduleId: randomUUID(),
        revision: 1,
        occurrenceId: randomUUID(),
        scheduledAt: at,
      },
    },
  ]);
  const result = await f.tools.execute(
    {
      name: 'persona',
      id: 'review-write',
      args: {
        operation: 'update',
        expectedRevision: 0,
        sourceQuote: 'My name is Alex',
        edits: [{ oldText: '', newText: 'Alex' }],
      },
    },
    {
      sessionId: meta.id,
      workspaceRoot: '/workspace',
      userPromptId: promptId,
      callId: 'review-write',
      personalMemoryChanged: async () => undefined,
    },
  );
  expect(result.isError).toBe(true);
  expect(f.writes).toHaveLength(0);
});

it('retains the external execution guard while enabling personal memory on normal turns', async () => {
  const f = await fixture();
  const meta = await f.session();
  const guard = vi.fn(async () => {
    throw new Error('access revoked');
  });
  await f.run(
    meta,
    'My name is Alex',
    new FakeLLM(() =>
      toolCallThenFinish('blocked', 'persona', {
        operation: 'update',
        expectedRevision: 0,
        sourceQuote: 'My name is Alex',
        edits: [{ oldText: '', newText: 'Alex' }],
      }),
    ),
    { contextGuard: guard },
  );
  expect(guard).toHaveBeenCalled();
  expect(f.writes).toHaveLength(0);
});

it('does not grant child actors personal-memory writes even with personal metadata', async () => {
  const f = await fixture();
  const meta = await f.session();
  await f.run(
    meta,
    'My name is Alex',
    new FakeLLM(
      () =>
        toolCallThenFinish('child-save', 'persona', {
          operation: 'update',
          expectedRevision: 0,
          sourceQuote: 'My name is Alex',
          edits: [{ oldText: '', newText: 'Alex' }],
        }),
      () => textChunks('Unavailable'),
    ),
    { actor: 'subagent:parent' },
  );
  expect(f.writes).toHaveLength(0);
});

it.each(['saved', 'no-read', 'excluded', 'disabled', 'rewrite'] as const)(
  'nightly consolidation validates original evidence: %s',
  async (scenario) => {
    const f = await fixture(scenario !== 'disabled');
    const original = await f.session();
    await f.run(original, 'My name is Alex', new FakeLLM(() => textChunks('Hello Alex')));
    const logs = await f.store.load(original.id);
    const user = logs.find((event) => event.type === 'message/user')!;
    const answerIndex = logs.findIndex(
      (event) => event.type === 'message/assistant' && event.phase === 'final',
    );
    const episode: TopicEpisode = {
      episodeId: user.eventId,
      promptId: user.eventId,
      sessionId: original.id,
      fromSeq: logs.indexOf(user) + 1,
      toSeq: logs.length,
      answerSeq: answerIndex + 1,
      at: user.at,
      topic: 'Introduction',
      request: 'My name is Alex',
      outcome: 'Hello Alex',
      excluded: scenario === 'excluded',
      policyRevision: scenario === 'disabled' ? 1 : 0,
    };
    f.index.evidence.mockResolvedValue(episode);
    f.tools.register({
      name: 'recall',
      description: 'Original source',
      parameters: z.object({}),
      effect: { kind: 'read', scope: 'reference' },
      execute: async () => ({
        isError: false,
        value: {
          episodeId: episode.episodeId,
          policyRevision: scenario === 'disabled' ? 1 : 0,
          sources: [
            {
              sessionId: original.id,
              eventId: user.eventId,
              seq: episode.fromSeq,
              at: user.at,
              from: 0,
              to: 18,
              text: 'My name is Alex',
              totalCharacters: 15,
              truncated: false,
            },
          ],
        },
      }),
    });
    const review = await f.session();
    const promptId = randomUUID();
    await f.store.append(review.id, [
      {
        type: 'message/user',
        surfaceOp: 'append',
        eventId: promptId,
        at,
        content: [{ kind: 'text', text: 'Consolidate earlier personal facts' }],
        trigger: {
          kind: 'schedule',
          consolidation: 'memory',
          scheduleId: randomUUID(),
          revision: 1,
          occurrenceId: randomUUID(),
          scheduledAt: '2099-01-01T00:00:00.000Z',
        },
      },
    ]);
    const save = () =>
      toolCallThenFinish('consolidate', 'persona', {
        operation: 'update',
        expectedRevision: scenario === 'disabled' ? 1 : 0,
        sourceQuote: 'My name is Alex',
        sourceEpisodeId: episode.episodeId,
        sourceEventId: user.eventId,
        edits: [
          { oldText: scenario === 'rewrite' ? 'existing' : '', newText: '- My name is Alex' },
        ],
      });
    const llm =
      scenario === 'no-read'
        ? new FakeLLM(save, () => textChunks('Done'))
        : new FakeLLM(
            () => toolCallThenFinish('read-source', 'recall', {}),
            save,
            () => textChunks('Done'),
          );
    await f.run(review, 'Consolidate earlier personal facts', llm, { promptSeq: 2 });
    expect(
      f.writes,
      JSON.stringify(
        (await f.store.load(review.id)).filter(
          (event) => event.type === 'tool/result' || event.type === 'turn/end',
        ),
      ),
    ).toHaveLength(scenario === 'saved' ? 1 : 0);
    if (scenario === 'saved')
      expect(f.writes[0]).toMatchObject({
        source: { sessionId: original.id, eventId: user.eventId, excerpt: 'My name is Alex' },
        consolidation: { sessionId: review.id, promptId, episodeId: episode.episodeId },
      });
  },
);

it('gives actionable no-effect feedback when a model submits edits as a read', () => {
  const result = personaToolParametersSchema.safeParse({
    operation: 'read',
    expectedRevision: 2,
    sourceQuote: 'Forget my name',
    edits: [{ oldText: 'Name', newText: '' }],
  });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues[0]?.message).toContain('set operation to update');
});

it('nightly source admission rejects task wording and behavioral inference', () => {
  for (const text of [
    'My name is Alex',
    'I prefer concise answers',
    '我才是真正的川川',
    '我习惯用中文交流',
  ])
    expect(isNightlyMemorySource(text)).toBe(true);
  for (const text of [
    '帮我用浏览器打开这个页面',
    'Translate this into Chinese',
    'Most earlier messages were in Chinese',
    'I am asking you to review this book',
    'source',
  ])
    expect(isNightlyMemorySource(text)).toBe(false);
});
