import { afterEach, describe, expect, it } from 'vitest';
import type {
  LLMPort,
  LLMRequest,
  SessionEvent,
  StreamChunk,
  TaskBudgetScope,
} from '@trinity-harness/contracts';
import { taskBudgetSchema } from '@trinity-harness/contracts';
import {
  ContextManager,
  CoreAgentLoop,
  CoreToolRegistry,
  EventTaskExecution,
  MemorySessionStore,
  bashTool,
  createSubagentTool,
  createTaskTool,
  readFileTool,
  writeFileTool,
} from '../src/index.js';
import type { AgentLoopOptions } from '../src/loop/agent-loop.js';
import { taskVerification } from '../src/loop/task-verification.js';
import { FakeLLM, textChunks, toolCallThenFinish } from '../src/testing/fake-llm.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';
import { modelRetry } from '../src/loop/model-retry.js';

const at = '2026-10-18T00:00:00.000Z';
const meta = () => ({ eventId: crypto.randomUUID(), at });
const user = (): SessionEvent => ({
  ...meta(),
  type: 'message/user',
  surfaceOp: 'append',
  content: [{ kind: 'text', text: 'Implement and verify' }],
});
const sink = { emit: () => undefined };
const request: LLMRequest = {
  model: 'fake/model',
  messages: [{ role: 'user', content: 'work' }],
  tools: [],
  maxOutputTokens: 10,
};
const scopes: TaskBudgetScope[] = [];
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.dispose();
});

function harness(llm: LLMPort, options: Partial<AgentLoopOptions> = {}) {
  const store = options.store ?? new MemorySessionStore();
  const sandbox = new FakeSandbox();
  const tools = new CoreToolRegistry(sandbox);
  tools.register(writeFileTool);
  tools.register(readFileTool);
  tools.register(bashTool);
  tools.register(createTaskTool(store));
  const loop = new CoreAgentLoop({
    llm,
    model: 'fake/model',
    workspaceRoot: '/ws',
    store,
    tools,
    wait: async () => undefined,
    ...options,
  });
  return { store, sandbox, tools, loop };
}

async function budget(overrides: Parameters<typeof taskBudgetSchema.parse>[0] = {}) {
  const store = new MemorySessionStore();
  const prompt = user();
  await store.append('parent', [prompt]);
  let now = Date.parse(at);
  const execution = new EventTaskExecution(
    store,
    taskBudgetSchema.parse({ reserveRequests: 0, reserveTokens: 0, ...(overrides as object) }),
    {},
    () => now,
  );
  const scope = await execution.open('parent', prompt.eventId);
  scopes.push(scope);
  return {
    scope,
    store,
    execution,
    prompt,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('durable shared task budget', () => {
  it('keeps default tasks unlimited across requests, tokens, elapsed time and replay', async () => {
    const store = new MemorySessionStore();
    const prompt = user();
    await store.append('parent', [prompt]);
    let now = Date.parse(at);
    const execution = new EventTaskExecution(store, undefined, {}, () => now);
    const scope = await execution.open('parent', prompt.eventId);
    scopes.push(scope);
    expect(scope.maxSteps).toBeUndefined();
    const large = { ...request, estimatedInputTokens: 2_000_001 };
    for (let index = 0; index < 130; index += 1) {
      const requestId = await scope.admit(large, index % 2 ? 'subagent' : 'assistant', 'work');
      if (index === 0)
        await scope.record({
          requestId,
          promptId: prompt.eventId,
          model: request.model,
          purpose: 'assistant',
          tokens: { inputTokens: 2_000_001, outputTokens: 10 },
        });
    }
    now += 86_400_001;
    expect(scope.signal.aborted).toBe(false);
    expect(await scope.shouldConclude(large)).toBe(false);
    expect(await scope.shouldFinalize(large)).toBe(false);

    // The persisted snapshot, including omitted ceilings, wins over new configuration.
    const resumed = await new EventTaskExecution(
      store,
      taskBudgetSchema.parse({ maxRequests: 1, maxTokens: 1, maxDurationMs: 1, maxSteps: 1 }),
      {},
      () => now,
    ).open('parent', prompt.eventId);
    scopes.push(resumed);
    expect(resumed.maxSteps).toBeUndefined();
    await expect(resumed.admit(large, 'compaction', 'work')).resolves.toBeTruthy();
    const events = await store.load('parent');
    expect(events.filter((event) => event.type === 'task/request')).toHaveLength(131);
    expect(events.filter((event) => event.type === 'model/usage')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'task/request_denied')).toHaveLength(0);
    const recorded = events.find((event) => event.type === 'task/budget');
    expect(JSON.parse(JSON.stringify(recorded)).limits).toEqual({
      maxCost: [],
      reserveRequests: 3,
      reserveTokens: 16384,
    });
  });
  it('preserves explicit request limits when resumed under unlimited defaults', async () => {
    const { scope, store, prompt } = await budget({ maxRequests: 1 });
    await scope.admit(request, 'assistant', 'work');
    const resumed = await new EventTaskExecution(store).open('parent', prompt.eventId);
    scopes.push(resumed);
    await expect(resumed.admit(request, 'assistant', 'final')).rejects.toThrow('budget exhausted');
  });
  it('propagates cancellation for an unlimited task', async () => {
    const store = new MemorySessionStore();
    const controller = new AbortController();
    const scope = await new EventTaskExecution(store).open(
      'parent',
      user().eventId,
      controller.signal,
    );
    scopes.push(scope);
    controller.abort();
    expect(scope.signal.aborted).toBe(true);
    await expect(scope.admit(request, 'assistant', 'work')).rejects.toThrow();
    expect((await store.load('parent')).some((event) => event.type === 'task/request')).toBe(false);
  });
  it('admits only one of concurrent children with one remaining request', async () => {
    const { scope, store } = await budget({ maxRequests: 1 });
    const results = await Promise.allSettled([
      scope.admit(request, 'subagent', 'work'),
      scope.admit(request, 'subagent', 'work'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await store.load('parent')).filter((event) => event.type === 'task/request_denied'),
    ).toHaveLength(1);
  });
  it('retains uncertain usage and reservations through crash recovery', async () => {
    const { scope, execution, prompt } = await budget({ maxRequests: 1 });
    await scope.admit(request, 'assistant', 'work');
    const resumed = await execution.open('parent', prompt.eventId);
    scopes.push(resumed);
    await expect(resumed.admit(request, 'assistant', 'final')).rejects.toThrow('budget exhausted');
  });
  it('settles actual tokens without counting cache/reasoning twice and deduplicates usage', async () => {
    const { scope, store } = await budget({ maxTokens: 100 });
    const requestId = await scope.admit(request, 'assistant', 'work');
    const usage = {
      requestId,
      promptId: crypto.randomUUID(),
      model: request.model,
      purpose: 'subagent' as const,
      tokens: { inputTokens: 80, outputTokens: 10, cacheReadTokens: 60, reasoningTokens: 8 },
    };
    await scope.record(usage);
    await scope.record(usage);
    expect(
      (await store.load('parent')).filter((event) => event.type === 'model/usage'),
    ).toHaveLength(1);
    await expect(scope.admit(request, 'assistant', 'final')).rejects.toThrow('budget exhausted');
  });
  it('keeps parent reserves out of child reach', async () => {
    const { scope } = await budget({ maxRequests: 2, reserveRequests: 1 });
    await scope.admit(request, 'subagent', 'work');
    await expect(scope.admit(request, 'subagent', 'final')).rejects.toThrow('budget exhausted');
    await expect(scope.admit(request, 'assistant', 'final')).resolves.toBeTruthy();
  });
  it('does not reset a deadline when resuming', async () => {
    const { execution, scope, prompt, advance } = await budget({ maxDurationMs: 1000 });
    await scope.admit(request, 'assistant', 'work');
    advance(1001);
    const resumed = await execution.open('parent', prompt.eventId);
    scopes.push(resumed);
    await expect(resumed.admit(request, 'assistant', 'final')).rejects.toThrow('deadline');
  });
  it('fails closed when a configured cost ceiling has no price', async () => {
    const { scope } = await budget({ maxCost: [{ currency: 'USD', amount: '1' }] });
    await expect(scope.admit(request, 'assistant', 'work')).rejects.toThrow('missing USD price');
  });
  it('enforces an exact-decimal cost ceiling before spending', async () => {
    const store = new MemorySessionStore();
    const prompt = user();
    await store.append('parent', [prompt]);
    const execution = new EventTaskExecution(
      store,
      taskBudgetSchema.parse({
        maxCost: [{ currency: 'USD', amount: '0' }],
        reserveRequests: 0,
        reserveTokens: 0,
      }),
      {
        'fake/model': [
          { currency: 'USD', version: 'v1', input: '1', output: '2', minInputTokens: 0 },
        ],
      },
      () => Date.parse(at),
    );
    const scope = await execution.open('parent', prompt.eventId);
    scopes.push(scope);
    await expect(scope.admit(request, 'assistant', 'final')).rejects.toThrow('budget exhausted');
  });
});

describe('task verification evidence', () => {
  it('requires current exact successful command evidence and invalidates it after edits', async () => {
    const { store, tools } = harness(new FakeLLM());
    const prompt = user();
    await store.append('s', [prompt]);
    const execute = async (id: string, name: string, args: unknown) => {
      await store.append('s', [{ ...meta(), type: 'tool/call', callId: id, name, args }]);
      const result = await tools.execute(
        { id, name, args },
        { sessionId: 's', workspaceRoot: '/ws' },
      );
      await store.append('s', [{ ...meta(), type: 'tool/result', callId: id, ...result }]);
      return result;
    };
    await execute('plan', 'task', {
      operation: 'plan',
      checks: [{ id: 'tests', requirement: 'Tests pass', kind: 'command', command: 'pnpm test' }],
    });
    await store.append('s', [
      { ...meta(), type: 'tool/call', callId: 'bad', name: 'bash', args: { command: 'echo done' } },
      { ...meta(), type: 'tool/result', callId: 'bad', isError: false, value: { exitCode: 0 } },
    ]);
    expect(
      (await execute('bad-proof', 'task', { operation: 'verify', id: 'tests', callId: 'bad' }))
        .isError,
    ).toBe(true);
    await store.append('s', [
      {
        ...meta(),
        type: 'tool/call',
        callId: 'tests',
        name: 'bash',
        args: { command: 'pnpm test' },
      },
      { ...meta(), type: 'tool/result', callId: 'tests', isError: false, value: { exitCode: 0 } },
    ]);
    expect(
      (await execute('proof', 'task', { operation: 'verify', id: 'tests', callId: 'tests' }))
        .isError,
    ).toBe(false);
    expect(taskVerification(await store.load('s'), prompt.eventId).status).toBe('verified');
    await execute('write', 'write_file', { path: 'a', content: 'changed' });
    expect(taskVerification(await store.load('s'), prompt.eventId).status).toBe('incomplete');
    expect(
      (await execute('old-proof', 'task', { operation: 'verify', id: 'tests', callId: 'tests' }))
        .isError,
    ).toBe(true);
    expect(
      (
        await execute('weaken', 'task', {
          operation: 'plan',
          checks: [{ id: 'easy', requirement: 'Skip tests', kind: 'observation' }],
        })
      ).isError,
    ).toBe(true);
  });
  it('blocks failed, missing, or previous-turn evidence', async () => {
    const { store, tools } = harness(new FakeLLM());
    await store.append('s', [
      { ...meta(), type: 'tool/call', callId: 'old', name: 'read_file', args: { path: 'a' } },
      { ...meta(), type: 'tool/result', callId: 'old', isError: false, value: { content: 'old' } },
      user(),
    ]);
    await tools.execute(
      {
        id: 'p',
        name: 'task',
        args: {
          operation: 'plan',
          checks: [{ id: 'inspect', requirement: 'Inspect result', kind: 'observation' }],
        },
      },
      { sessionId: 's', workspaceRoot: '/ws' },
    );
    for (const callId of ['old', 'missing'])
      expect(
        (
          await tools.execute(
            { id: 'v', name: 'task', args: { operation: 'verify', id: 'inspect', callId } },
            { sessionId: 's', workspaceRoot: '/ws' },
          )
        ).isError,
      ).toBe(true);
  });
  it('repairs a premature final and only completes after all checks have evidence', async () => {
    const llm = new FakeLLM(
      () =>
        toolCallThenFinish('p', 'task', {
          operation: 'plan',
          checks: [{ id: 'read', requirement: 'Inspect a', kind: 'observation' }],
        }),
      () => toolCallThenFinish('r', 'read_file', { path: 'a' }),
      () => textChunks('Done too early'),
      (req) => {
        expect(JSON.stringify(req.messages)).toContain('Repair the rejected candidate');
        return toolCallThenFinish('v', 'task', { operation: 'verify', id: 'read', callId: 'r' });
      },
      () => textChunks('Verified result'),
    );
    const { loop, store, sandbox } = harness(llm, { verification: true });
    sandbox.files.set('a', 'result');
    expect((await loop.run('s', 'inspect', sink)).reason).toBe('completed');
    expect(
      (await store.load('s'))
        .filter((event) => event.type === 'task/assessment')
        .map((event) => event.status),
    ).toEqual(['incomplete', 'verified']);
  });
  it('reports incomplete when verification cannot fit the remaining steps', async () => {
    const { loop, store } = harness(
      new FakeLLM(
        () => toolCallThenFinish('w', 'write_file', { path: 'a', content: 'x' }),
        () => textChunks('All done'),
      ),
      { verification: true, maxSteps: 2 },
    );
    expect((await loop.run('s', 'implement', sink)).reason).toBe('error');
    expect((await store.load('s')).at(-1)).toMatchObject({
      type: 'turn/end',
      detail: expect.stringContaining('Task incomplete'),
    });
  });
});

describe('bounded model recovery', () => {
  it('continues truncated output and preserves it in the final answer', async () => {
    const llm = new FakeLLM(
      () => [
        { kind: 'text-delta', text: 'First. ' },
        { kind: 'finish', reason: 'length' },
      ],
      (req) => {
        expect(JSON.stringify(req.messages)).toContain('First.');
        return textChunks('Second.');
      },
    );
    const { loop, store } = harness(llm);
    expect((await loop.run('s', 'answer', sink)).reason).toBe('completed');
    expect(
      (await store.load('s')).filter((event) => event.type === 'message/assistant').at(-1),
    ).toMatchObject({ phase: 'final', content: [{ kind: 'text', text: 'First. Second.' }] });
  });
  it('does not run tools from a truncated response', async () => {
    const llm = new FakeLLM(
      () => [
        ...toolCallThenFinish('w', 'write_file', { path: 'a', content: 'x' }).slice(0, 1),
        { kind: 'finish', reason: 'length' },
      ],
      () => textChunks('Recovered'),
    );
    const { loop, sandbox } = harness(llm);
    await loop.run('s', 'go', sink);
    expect(sandbox.files.size).toBe(0);
  });
  it('bounds repeated output-limit continuation', async () => {
    const { loop, store } = harness(
      new FakeLLM(
        ...Array.from(
          { length: 3 },
          () => () =>
            [
              { kind: 'text-delta', text: 'partial' },
              { kind: 'finish', reason: 'length' },
            ] as StreamChunk[],
        ),
      ),
    );
    expect((await loop.run('s', 'go', sink)).reason).toBe('error');
    expect((await store.load('s')).filter((event) => event.type === 'task/recovery')).toHaveLength(
      2,
    );
  });
  it('retries transient failure but does not retry authentication errors', async () => {
    const retry = new FakeLLM(
      () => {
        throw Object.assign(new Error('busy'), { statusCode: 503 });
      },
      () => textChunks('Recovered'),
    );
    expect((await harness(retry).loop.run('s', 'go', sink)).reason).toBe('completed');
    const fatal = new FakeLLM(() => {
      throw Object.assign(new Error('bad key'), { statusCode: 401 });
    });
    expect((await harness(fatal).loop.run('s', 'go', sink)).reason).toBe('error');
    expect(fatal.requests).toHaveLength(1);
  });
  it('persists provider timing and visible progress before waiting', async () => {
    let now = Date.parse(at);
    const started = now;
    const llm = new FakeLLM(
      () => {
        throw Object.assign(new Error('busy'), {
          statusCode: 429,
          responseHeaders: { 'retry-after': '30', 'x-api-key': 'private' },
        });
      },
      () => {
        expect(now).toBe(started + 30_000);
        return textChunks('Recovered');
      },
    );
    const visible: string[] = [];
    const { loop, store } = harness(llm, {
      now: () => now,
      wait: async (ms) => {
        const events = await store.load('s');
        expect(events.find((event) => event.type === 'task/recovery')).toMatchObject({
          retry: {
            statusCode: 429,
            delayMs: 30_000,
            retryAt: new Date(started + 30_000).toISOString(),
          },
        });
        expect(visible.at(-1)).toContain('HTTP 429');
        expect(visible.at(-1)).toContain(new Date(started + 30_000).toISOString());
        expect(JSON.stringify(events)).not.toContain('private');
        now += ms;
      },
    });
    expect(
      (
        await loop.run('s', 'go', {
          emit: (event) => {
            if (event.type === 'message/assistant') visible.push(event.content);
          },
        })
      ).reason,
    ).toBe('completed');
    expect(llm.requests).toHaveLength(2);
    expect(JSON.stringify(llm.requests[1]?.messages)).not.toContain('scheduled for');
  });
  it('resumes the remaining persisted wait without resetting the retry allowance', async () => {
    const store = new MemorySessionStore();
    const prompt = user();
    let now = Date.parse(at);
    const failure = Object.assign(new Error('limited'), {
      statusCode: 429,
      responseHeaders: { 'retry-after': '30' },
    });
    await store.append('s', [
      prompt,
      {
        ...meta(),
        type: 'task/recovery',
        promptId: prompt.eventId,
        kind: 'retry',
        advice: 'retry',
        retry: modelRetry(failure, 1, now),
      },
    ]);
    now += 10_000;
    const waits: number[] = [];
    const llm = new FakeLLM(() => {
      throw failure;
    });
    const { loop } = harness(llm, {
      store,
      maxRetries: 1,
      now: () => now,
      wait: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    expect((await loop.run('s', 'ignored on replay', sink, { promptSeq: 1 })).reason).toBe('error');
    expect(waits).toEqual([20_000]);
    expect(llm.requests).toHaveLength(1);
    expect((await store.load('s')).filter((event) => event.type === 'task/recovery')).toHaveLength(
      1,
    );
  });
  it.each(['elapsed', 'consumed', 'other-prompt', 'legacy'] as const)(
    'does not reapply a %s retry wait',
    async (kind) => {
      const store = new MemorySessionStore();
      const prompt = user();
      const now = Date.parse(at);
      const events: SessionEvent[] = [
        prompt,
        {
          ...meta(),
          type: 'task/recovery',
          promptId: kind === 'other-prompt' ? crypto.randomUUID() : prompt.eventId,
          kind: 'retry',
          advice: 'retry',
          ...(kind === 'legacy'
            ? {}
            : {
                retry: modelRetry(
                  { statusCode: 429, responseHeaders: { 'retry-after': '30' } },
                  1,
                  now,
                ),
              }),
        },
      ];
      if (kind === 'consumed')
        events.push({ ...meta(), type: 'task/step', promptId: prompt.eventId });
      await store.append('s', events);
      const { loop } = harness(new FakeLLM(() => textChunks('Done')), {
        store,
        now: () => now + (kind === 'elapsed' ? 40_000 : 0),
        wait: async () => {
          throw new Error('Unexpected wait');
        },
      });
      expect((await loop.run('s', 'go', sink, { promptSeq: 1 })).reason).toBe('completed');
    },
  );
  it('stops during a provider cooldown without issuing another request', async () => {
    const controller = new AbortController();
    const llm = new FakeLLM(() => {
      throw Object.assign(new Error('limited'), {
        statusCode: 429,
        responseHeaders: { 'retry-after': '300' },
      });
    });
    const { loop, store } = harness(llm, {
      now: () => Date.parse(at),
      wait: async (ms, signal) => {
        expect(ms).toBe(300_000);
        await store.append('s', [
          { ...meta(), type: 'turn/cancel_requested', throughPromptSeq: 1 },
        ]);
        controller.abort();
        signal?.throwIfAborted();
      },
    });
    expect((await loop.run('s', 'go', sink, { signal: controller.signal })).reason).toBe('aborted');
    expect(llm.requests).toHaveLength(1);
  });
  it('honors provider cooldowns after a partial interrupted answer', async () => {
    let now = Date.parse(at);
    let calls = 0;
    const waits: number[] = [];
    const llm: LLMPort = {
      stream: async () =>
        (async function* () {
          calls++;
          if (calls === 1) {
            yield { kind: 'text-delta', text: 'First. ' } as const;
            throw Object.assign(new Error('limited'), {
              statusCode: 429,
              responseHeaders: { 'retry-after': '10' },
            });
          }
          yield* textChunks('Second.');
        })(),
    };
    const { loop, store } = harness(llm, {
      now: () => now,
      wait: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    expect((await loop.run('s', 'go', sink)).reason).toBe('completed');
    expect(waits).toEqual([10_000]);
    expect(
      (await store.load('s')).filter((event) => event.type === 'message/assistant').at(-1),
    ).toMatchObject({ phase: 'final', content: [{ kind: 'text', text: 'First. Second.' }] });
  });
  it('propagates an inherited task deadline to the retry wait', async () => {
    const lifetime = new AbortController();
    const scope: TaskBudgetScope = {
      signal: lifetime.signal,
      maxSteps: undefined,
      shouldConclude: async () => false,
      shouldFinalize: async () => false,
      admit: async () => crypto.randomUUID(),
      record: async () => undefined,
      dispose: () => undefined,
    };
    const llm = new FakeLLM(() => {
      throw Object.assign(new Error('overloaded'), {
        statusCode: 529,
        responseHeaders: { 'retry-after': '60' },
      });
    });
    const { loop, store } = harness(llm, {
      now: () => Date.parse(at),
      wait: async (ms, signal) => {
        expect(ms).toBe(60_000);
        lifetime.abort(new DOMException('Task deadline reached', 'TimeoutError'));
        expect(signal?.aborted).toBe(true);
        signal?.throwIfAborted();
      },
    });
    expect((await loop.run('s', 'go', sink, { taskBudget: scope })).reason).toBe('error');
    expect((await store.load('s')).at(-1)).toMatchObject({
      type: 'turn/end',
      detail: 'Task deadline reached; unfinished work remains',
    });
    expect(llm.requests).toHaveLength(1);
  });
  it('continues a partial interrupted stream without repeating side effects', async () => {
    let calls = 0;
    const llm: LLMPort = {
      stream: async (req) => {
        calls++;
        if (calls === 1)
          return (async function* () {
            yield { kind: 'text-delta', text: 'Partial. ' } as const;
            throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
          })();
        expect(JSON.stringify(req.messages)).toContain('Partial.');
        return (async function* () {
          yield* textChunks('Continued.');
        })();
      },
    };
    const { loop, store } = harness(llm);
    expect((await loop.run('s', 'go', sink)).reason).toBe('completed');
    expect(
      (await store.load('s')).filter((event) => event.type === 'message/assistant').at(-1),
    ).toMatchObject({ content: [{ kind: 'text', text: 'Partial. Continued.' }] });
  });
  it('recovers provider overflow through a checkpoint before retrying', async () => {
    const store = new MemorySessionStore();
    await store.append('s', [
      user(),
      {
        ...meta(),
        type: 'message/assistant',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'old evidence'.repeat(100) }],
      },
    ]);
    const llm = new FakeLLM(
      () => {
        throw new Error('maximum context length exceeded');
      },
      () => textChunks('Checkpoint'),
      (req) => {
        expect(JSON.stringify(req.messages)).toContain('Checkpoint');
        return textChunks('Recovered');
      },
    );
    const context = new ContextManager({
      llm,
      model: 'fake/model',
      store,
      maxTokens: 100000,
      keepTokens: 100,
    });
    const { loop } = harness(llm, { store, context });
    expect((await loop.run('s', 'continue', sink)).reason).toBe('completed');
    expect(
      (await store.load('s')).some(
        (event) => event.type === 'task/recovery' && event.kind === 'overflow',
      ),
    ).toBe(true);
  });
  it('preserves the durable main-step count when a worker resumes a torn tail', async () => {
    const store = new MemorySessionStore();
    const prompt = user();
    await store.append('s', [prompt, { ...meta(), type: 'task/step', promptId: prompt.eventId }]);
    const llm = new FakeLLM((req) => {
      expect(req.tools).toEqual([]);
      return textChunks('Resume and conclude');
    });
    const execution = new EventTaskExecution(
      store,
      taskBudgetSchema.parse({ maxSteps: 2 }),
      {},
      () => Date.parse(at),
    );
    const { loop } = harness(llm, { store, execution });
    expect(await loop.run('s', 'go', sink, { promptSeq: 1 })).toEqual({
      reason: 'completed',
      steps: 2,
    });
  });
  it('honors provider timing for a failed compaction request', async () => {
    const store = new MemorySessionStore();
    await store.append('s', [
      user(),
      {
        ...meta(),
        type: 'message/assistant',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'old evidence'.repeat(100) }],
      },
    ]);
    let now = Date.parse(at);
    const waits: number[] = [];
    const llm = new FakeLLM(
      () => {
        throw new Error('maximum context length exceeded');
      },
      () => {
        throw Object.assign(new Error('summary limited'), {
          statusCode: 429,
          responseHeaders: { 'retry-after': '5' },
        });
      },
      () => textChunks('Checkpoint'),
      () => textChunks('Recovered'),
    );
    const context = new ContextManager({
      llm,
      model: 'fake/model',
      store,
      maxTokens: 100000,
      keepTokens: 100,
    });
    const { loop } = harness(llm, {
      store,
      context,
      now: () => now,
      wait: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    expect((await loop.run('s', 'continue', sink)).reason).toBe('completed');
    expect(waits).toEqual([5000]);
    expect(llm.requests).toHaveLength(4);
    expect(
      (await store.load('s')).filter((event) => event.type === 'compaction/summary'),
    ).toHaveLength(1);
  });
  it('accounts child requests in the parent budget, including failed attempts', async () => {
    const store = new MemorySessionStore();
    const llm = new FakeLLM(
      () => toolCallThenFinish('child', 'subagent', { task: 'inspect' }),
      () => textChunks('Parent report'),
    );
    const { loop, tools } = harness(llm, {
      store,
      execution: new EventTaskExecution(
        store,
        taskBudgetSchema.parse({ maxRequests: 5, reserveRequests: 1 }),
        {},
        () => Date.parse(at),
      ),
    });
    const childLLM = new FakeLLM(() => textChunks('Child report'));
    tools.register(createSubagentTool({ createLoop: () => harness(childLLM).loop }));
    expect((await loop.run('s', 'delegate', sink)).reason).toBe('completed');
    const events = await store.load('s');
    expect(events.filter((event) => event.type === 'task/request')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'model/usage')).toHaveLength(3);
    expect(
      events.filter((event) => event.type === 'model/usage').map((event) => event.usage.purpose),
    ).toEqual(['assistant', 'subagent', 'assistant']);
  });
});

describe('verification ordering and reserves', () => {
  it('reports the configured request budget when tools are refused during finalization', async () => {
    const store = new MemorySessionStore();
    const llm = new FakeLLM(
      () => toolCallThenFinish('first', 'write_file', { path: 'first', content: 'allowed' }),
      (request) => {
        expect(request.tools).toEqual([]);
        expect(request.system).toContain('Task request/token/cost budget reached');
        return toolCallThenFinish('extra', 'write_file', { path: 'extra', content: 'refused' });
      },
    );
    const execution = new EventTaskExecution(
      store,
      taskBudgetSchema.parse({ maxRequests: 2, reserveRequests: 0 }),
      {},
      () => Date.parse(at),
    );
    const { loop, sandbox } = harness(llm, { store, execution });
    expect(await loop.run('s', 'work', sink)).toEqual({ reason: 'error', steps: 2 });
    expect((await store.load('s')).at(-1)).toMatchObject({
      type: 'turn/end',
      detail: 'Task request/token/cost budget reached',
    });
    expect(sandbox.files.has('extra')).toBe(false);
    llm.assertExhausted();
  });
  it.each([undefined, 2] as const)(
    'rejects concurrent write/test evidence under version %s',
    (evidenceVersion) => {
      const prompt = user();
      const events: SessionEvent[] = [
        prompt,
        {
          ...meta(),
          type: 'task/plan',
          promptId: prompt.eventId,
          ...(evidenceVersion === 2 ? { evidenceVersion } : {}),
          checks: [
            {
              id: 'tests',
              requirement: 'Tests pass after changes',
              kind: 'command',
              command: 'pnpm test',
            },
          ],
        },
        {
          ...meta(),
          type: 'tool/call',
          callId: 'write',
          name: 'write_file',
          args: { path: 'a', content: 'x' },
        },
        {
          ...meta(),
          type: 'tool/call',
          callId: 'test',
          name: 'bash',
          args: { command: 'pnpm test' },
        },
        { ...meta(), type: 'tool/result', callId: 'write', value: {}, isError: false },
        { ...meta(), type: 'tool/result', callId: 'test', value: { exitCode: 0 }, isError: false },
        {
          ...meta(),
          type: 'task/check',
          promptId: prompt.eventId,
          id: 'tests',
          callId: 'test',
          resultSeq: 6,
        },
      ];
      expect(taskVerification(events, prompt.eventId).status).toBe('incomplete');
    },
  );
  it('keeps the last request for a parent final answer after verification', async () => {
    const { scope } = await budget({ maxRequests: 3, reserveRequests: 2 });
    await scope.admit(request, 'assistant', 'work');
    await scope.admit(request, 'assistant', 'verification');
    expect(await scope.shouldFinalize(request)).toBe(true);
    await expect(scope.admit(request, 'assistant', 'verification')).rejects.toThrow(
      'budget exhausted',
    );
    await expect(scope.admit(request, 'assistant', 'final')).resolves.toBeTruthy();
  });
  it('enforces verification-only tool execution near the step limit', async () => {
    const llm = new FakeLLM(
      () =>
        toolCallThenFinish('p', 'task', {
          operation: 'plan',
          checks: [{ id: 'inspect', requirement: 'Inspect file', kind: 'observation' }],
        }),
      () =>
        toolCallThenFinish('w', 'write_file', { path: 'a', content: 'unauthorized extra work' }),
      () => textChunks('I could not finish verification'),
    );
    const { loop, sandbox, store } = harness(llm, { maxSteps: 3, verification: true });
    expect((await loop.run('s', 'inspect', sink)).reason).toBe('error');
    expect(sandbox.files.size).toBe(0);
    expect(
      (await store.load('s')).find((event) => event.type === 'tool/result' && event.callId === 'w'),
    ).toMatchObject({ isError: true, value: { code: 'VERIFICATION_ONLY' } });
  });
  it('calibrates request/output space with provider usage from the current task', async () => {
    const store = new MemorySessionStore();
    const llm = new FakeLLM(
      () => [
        { kind: 'usage', inputTokens: 6000, outputTokens: 100 },
        ...toolCallThenFinish('w', 'write_file', { path: 'a', content: 'x' }),
      ],
      () => textChunks('Done'),
    );
    const { loop } = harness(llm, {
      store,
      maxContextTokens: 8192,
      maxOutputTokens: 8000,
      execution: new EventTaskExecution(store, taskBudgetSchema.parse({}), {}, () =>
        Date.parse(at),
      ),
    });
    expect((await loop.run('s', 'go', sink)).reason).toBe('completed');
    expect(llm.requests[1]!.estimatedInputTokens).toBeGreaterThanOrEqual(6000);
    expect(llm.requests[1]!.maxOutputTokens!).toBeLessThan(llm.requests[0]!.maxOutputTokens!);
  });
});

it.each(['skill', 'recall'])(
  'does not force verification retries for %s-only context gathering',
  async (name) => {
    const llm = new FakeLLM(
      () => toolCallThenFinish('context', name, {}),
      () => textChunks('Which project should I inspect?'),
    );
    const h = harness(llm, { verification: true });
    const { z } = await import('zod');
    h.tools.register({
      name,
      description: 'Load authorized context',
      effect: { kind: 'read', scope: 'control', evidence: 'none' },
      parameters: z.object({}),
      execute: async () => ({ value: {}, isError: false }),
    });
    const outcome = await h.loop.run(`context-${name}`, 'Inspect my project', sink);
    expect(outcome.reason).toBe('completed');
    expect(llm.requests).toHaveLength(2);
    expect(
      (await h.store.load(`context-${name}`)).some((event) => event.type === 'task/recovery'),
    ).toBe(false);
  },
);
