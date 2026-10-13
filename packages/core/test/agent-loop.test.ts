import { describe, expect, it } from 'vitest';

import type { EventSink, LoopEvent, SessionEvent } from '@trinity-harness/contracts';

import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  bashTool,
  readFileTool,
  writeFileTool,
} from '../src/index.js';
import {
  FakeLLM,
  reasoningChunks,
  textChunks,
  toolCallThenFinish,
} from '../src/testing/fake-llm.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';

function makeLoop(scripts: FakeLLM, sandbox = new FakeSandbox(), extra?: { maxSteps?: number }) {
  const store = new MemorySessionStore();
  const registry = new CoreToolRegistry(sandbox);
  registry.register(writeFileTool);
  const loop = new CoreAgentLoop({
    llm: scripts,
    model: 'fake/model',
    systemPrompt: 'you are a test agent',
    tools: registry,
    store,
    workspaceRoot: '/ws',
    ...(extra?.maxSteps !== undefined ? { maxSteps: extra.maxSteps } : {}),
  });
  return { store, loop, sandbox };
}

class CollectingSink implements EventSink {
  readonly events: LoopEvent[] = [];
  emit(event: LoopEvent): void {
    this.events.push(event);
  }
  types(): string[] {
    return this.events.map((e) => e.type);
  }
}

const eventTypes = (events: SessionEvent[]) => events.map((e) => e.type);

describe('CoreAgentLoop', () => {
  it('guides workspace reads to read_file instead of Bash', async () => {
    const llm = new FakeLLM(() => textChunks('Done.'));
    const store = new MemorySessionStore();
    const registry = new CoreToolRegistry(new FakeSandbox());
    registry.register(readFileTool);
    registry.register(bashTool);
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      systemPrompt: 'you are a test agent',
      tools: registry,
      store,
      workspaceRoot: '/ws',
    });

    await loop.run('s1', 'inspect src/app.ts', new CollectingSink());

    const request = llm.requests[0]!;
    expect(request.system).toContain('use read_file');
    expect(request.system).toContain('Sensitive-file reads are checked by the agent');
    expect(request.system).toContain('do not invoke a separate approval tool');
    expect(request.tools.map((tool) => tool.name)).toEqual(['read_file', 'bash']);
    expect(request.tools[0]!.description).toContain('Prefer this over Bash');
    expect(request.tools[1]!.description).toContain(
      'Use read_file to inspect workspace text files',
    );
  });

  it('completes a tool-free turn with a single model call', async () => {
    const llm = new FakeLLM(() => textChunks('Hello!', ' How can I help?'));
    const { store, loop } = makeLoop(llm);
    const sink = new CollectingSink();

    const outcome = await loop.run('s1', 'hi there', sink);

    expect(outcome).toEqual({ reason: 'completed', steps: 1 });
    expect(eventTypes(await store.load('s1'))).toEqual([
      'message/user',
      'model/usage',
      'message/assistant',
      'turn/end',
    ]);
    expect(sink.types()).toEqual([
      'text-delta',
      'text-delta',
      'model/usage',
      'message/assistant',
      'turn/end',
    ]);

    const [request] = llm.requests;
    expect(request!.model).toBe('fake/model');
    expect(request!.system).toContain('you are a test agent');
    expect(request!.system).toContain('reference documents actually read');
    expect(request!.messages).toEqual([{ role: 'user', content: 'hi there' }]);
    expect(request!.tools.map((t) => t.name)).toEqual(['write_file']);
  });

  it('runs a multi-step tool conversation and feeds results back to the model', async () => {
    const llm = new FakeLLM(
      () => toolCallThenFinish('c1', 'write_file', { path: 'out.txt', content: '42' }),
      () => textChunks('Done.'),
    );
    const { store, loop, sandbox } = makeLoop(llm);
    const sink = new CollectingSink();

    const outcome = await loop.run('s1', 'write 42 to out.txt', sink);

    expect(outcome).toEqual({ reason: 'completed', steps: 2 });
    expect(sandbox.files.get('out.txt')).toBe('42');

    // Event-sourcing: everything replayable from the log, in order (design.md §6.1).
    expect(eventTypes(await store.load('s1'))).toEqual([
      'message/user',
      'model/usage',
      'tool/call',
      'tool/result',
      'model/usage',
      'message/assistant',
      'turn/end',
    ]);

    // Second model call must see the user message + tool result.
    const second = llm.requests[1]!;
    expect(second.messages).toEqual([
      { role: 'user', content: 'write 42 to out.txt' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'out.txt', content: '42' } }],
      },
      {
        role: 'tool',
        content: JSON.stringify({ path: 'out.txt', bytes: 2 }),
        toolCallId: 'c1',
        toolName: 'write_file',
      },
    ]);

    // Real-time sink events mirror the log.
    expect(sink.types()).toEqual([
      'model/usage',
      'tool/call',
      'tool/result',
      'text-delta',
      'model/usage',
      'message/assistant',
      'turn/end',
    ]);
  });

  it('keeps the turn alive after an isError tool result', async () => {
    const llm = new FakeLLM(
      () => toolCallThenFinish('c1', 'write_file', { path: 123 }), // invalid args → isError
      () => textChunks('That failed, sorry.'),
    );
    const { store, loop } = makeLoop(llm);
    const outcome = await loop.run('s1', 'go', new CollectingSink());

    expect(outcome).toEqual({ reason: 'completed', steps: 2 });
    const log = await store.load('s1');
    const toolResult = log.find((e) => e.type === 'tool/result');
    expect(toolResult).toMatchObject({ isError: true });
  });

  it('ends with error when the model keeps calling tools past the step limit', async () => {
    const llm = new FakeLLM(
      ...Array.from(
        { length: 3 },
        () => () => toolCallThenFinish('c', 'write_file', { path: 'x', content: 'y' }),
      ),
    );
    const { store, loop } = makeLoop(llm, new FakeSandbox(), { maxSteps: 2 });
    const outcome = await loop.run('s1', 'go', new CollectingSink());

    expect(outcome).toEqual({ reason: 'error', steps: 2 });
    const log = await store.load('s1');
    expect(log.at(-1)).toMatchObject({
      type: 'turn/end',
      reason: 'error',
      detail: 'step limit (2) reached',
    });
  });

  it('honours AbortSignal mid-turn', async () => {
    const ac = new AbortController();
    const llm = new FakeLLM(() => textChunks('partial'));
    const { store, loop } = makeLoop(llm);
    ac.abort();
    const outcome = await loop.run('s1', 'go', new CollectingSink(), { signal: ac.signal });
    expect(outcome.reason).toBe('aborted');
    expect((await store.load('s1')).at(-1)).toMatchObject({ type: 'turn/end', reason: 'aborted' });
  });

  it('persists reasoning for audit but excludes it from a completed turn context', async () => {
    const llm = new FakeLLM(
      () => [...reasoningChunks('Let me think. '), ...textChunks('answer: 4')],
      () => textChunks('6'),
    );
    const { store, loop } = makeLoop(llm);

    const first = await loop.run('s1', 'what is 2+2?', new CollectingSink());
    expect(first).toEqual({ reason: 'completed', steps: 1 });

    // Reasoning is part of the assistant event (replayable from the log).
    const assistantEvent = (await store.load('s1')).find((e) => e.type === 'message/assistant');
    expect(assistantEvent).toEqual(
      expect.objectContaining({
        content: [
          { kind: 'reasoning', text: 'Let me think. ', signature: 'sig-test' },
          { kind: 'text', text: 'answer: 4' },
        ],
      }),
    );

    const second = await loop.run('s1', 'and 3+3?', new CollectingSink());

    expect(second).toEqual({ reason: 'completed', steps: 1 });
    // A completed turn contributes its final answer, without internal reasoning.
    expect(llm.requests[1]!.messages).toEqual([
      { role: 'user', content: 'what is 2+2?' },
      {
        role: 'assistant',
        content: 'answer: 4',
      },
      { role: 'user', content: 'and 3+3?' },
    ]);
  });

  it('streams reasoning deltas to the sink in real time', async () => {
    const llm = new FakeLLM(() => [...reasoningChunks('hmm '), ...textChunks('ok')]);
    const { loop } = makeLoop(llm);
    const sink = new CollectingSink();

    await loop.run('s1', 'go', sink);

    expect(sink.types()).toEqual([
      'reasoning-delta',
      'text-delta',
      'model/usage',
      'message/assistant',
      'turn/end',
    ]);
  });

  it('accumulates multiple turns in one session log', async () => {
    const llm = new FakeLLM(
      () => textChunks('first'),
      () => textChunks('second'),
    );
    const { store, loop } = makeLoop(llm);

    await loop.run('s1', 'one', new CollectingSink());
    await loop.run('s1', 'two', new CollectingSink());

    const log = await store.load('s1');
    expect(eventTypes(log)).toEqual([
      'message/user',
      'model/usage',
      'message/assistant',
      'turn/end',
      'message/user',
      'model/usage',
      'message/assistant',
      'turn/end',
    ]);
    expect(llm.requests[1]!.messages).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'two' },
    ]);
  });
});

it('classifies provider failures triggered by cancellation as aborted', async () => {
  const controller = new AbortController();
  const store = new MemorySessionStore();
  const loop = new CoreAgentLoop({
    llm: {
      stream: async () => {
        controller.abort();
        throw new Error('No output generated');
      },
    },
    model: 'fake/model',
    tools: new CoreToolRegistry(new FakeSandbox()),
    store,
    workspaceRoot: '/ws',
  });
  expect(
    (await loop.run('cancel-provider', 'go', new CollectingSink(), { signal: controller.signal }))
      .reason,
  ).toBe('aborted');
});

it('honors a durable Stop received during a model request before executing its tools', async () => {
  const store = new MemorySessionStore();
  const sandbox = new FakeSandbox();
  const tools = new CoreToolRegistry(sandbox);
  tools.register(writeFileTool);
  const loop = new CoreAgentLoop({
    llm: {
      stream: async () =>
        (async function* () {
          await store.append('durable-stop', [
            {
              type: 'turn/cancel_requested',
              throughPromptSeq: 1,
              eventId: crypto.randomUUID(),
              at: '2026-01-01T00:00:00.000Z',
            },
          ]);
          yield* toolCallThenFinish('write', 'write_file', {
            path: 'out.txt',
            content: 'side effect',
          });
        })(),
    },
    model: 'fake/model',
    tools,
    store,
    workspaceRoot: '/ws',
  });
  expect((await loop.run('durable-stop', 'write file', new CollectingSink())).reason).toBe(
    'aborted',
  );
  expect(sandbox.files.size).toBe(0);
});

it('reserves the last step for a final answer instead of more tools', async () => {
  const llm = new FakeLLM(
    () => toolCallThenFinish('c', 'write_file', { path: 'x', content: 'evidence' }),
    (req) => {
      expect(req.tools).toEqual([]);
      expect(req.system).toContain('final answer now');
      return textChunks('Here is the result; remaining work is incomplete.');
    },
  );
  const { loop, store } = makeLoop(llm, new FakeSandbox(), { maxSteps: 2 });
  expect(await loop.run('s', 'research', new CollectingSink())).toEqual({
    reason: 'completed',
    steps: 2,
  });
  expect((await store.load('s')).filter((event) => event.type === 'tool/call')).toHaveLength(1);
});

it('replays conversation command grants and never overrides a denied tool', async () => {
  const store = new MemorySessionStore();
  const registry = new CoreToolRegistry(new FakeSandbox());
  // An unregistered command returns an error, but still must bypass approval.
  await store.append('s', [
    {
      eventId: crypto.randomUUID(),
      at: new Date().toISOString(),
      type: 'approval/command_granted',
      approvalId: crypto.randomUUID(),
      prefix: ['custom-cli'],
      decidedBy: 'user',
    },
  ]);
  const policy = {
    onAsk: 'ask' as const,
    tools: { bash: 'ask' as const },
    allowWorkspaceInternalBash: false,
  };
  const run = async (denied: boolean): Promise<void> => {
    const loop = new CoreAgentLoop({
      store,
      tools: registry,
      workspaceRoot: '/ws',
      model: 'fake',
      llm: new FakeLLM(
        () => toolCallThenFinish(denied ? 'd' : 'c', 'bash', { command: 'custom-cli inspect' }),
        () => textChunks('done'),
      ),
    });
    await loop.run('s', 'go', new CollectingSink(), {
      policy: denied ? { ...policy, tools: { bash: 'denied' } } : policy,
    });
  };
  await run(false);
  await run(true);
  const events = await store.load('s');
  expect(events.filter((event) => event.type === 'approval/requested')).toHaveLength(0);
  expect(
    events.find((event) => event.type === 'tool/result' && event.callId === 'd'),
  ).toMatchObject({ isError: true, value: { message: expect.stringContaining('denied') } });
});

it('defaults to 64 model steps and reserves the last for an answer', async () => {
  const llm = new FakeLLM(
    ...Array.from(
      { length: 63 },
      (_, i) => () => toolCallThenFinish(`c${i}`, 'write_file', { path: 'x', content: String(i) }),
    ),
    (request) => {
      expect(request.tools).toEqual([]);
      expect(request.system).toContain('final answer now');
      return textChunks('Completed with these limits.');
    },
  );
  const { loop, store } = makeLoop(llm);
  expect(await loop.run('s', 'go', new CollectingSink())).toEqual({
    reason: 'completed',
    steps: 64,
  });
  expect((await store.load('s')).filter((event) => event.type === 'tool/call')).toHaveLength(63);
  expect((await store.load('s')).filter((event) => event.type === 'turn/guidance')).toHaveLength(1);
});

it('persists repeated-read guidance, clears it after new evidence, and keeps executing', async () => {
  const { bashTool } = await import('../src/tools/builtin.js');
  const store = new MemorySessionStore();
  const sandbox = new FakeSandbox();
  sandbox.execHandler = (command) => ({
    stdout: command.includes('new') ? 'new evidence' : 'same article',
    stderr: '',
    exitCode: 0,
  });
  const registry = new CoreToolRegistry(sandbox);
  registry.register(bashTool);
  const llm = new FakeLLM(
    ...Array.from(
      { length: 4 },
      (_, i) => () => toolCallThenFinish(`read${i}`, 'bash', { command: 'agent-browser snapshot' }),
    ),
    (request) => {
      expect(JSON.stringify(request.messages)).toContain('last three browser reads');
      return toolCallThenFinish('new', 'bash', { command: 'agent-browser read --filter new' });
    },
    (request) => {
      expect(JSON.stringify(request.messages)).not.toContain('last three browser reads');
      expect(JSON.stringify(request.messages)).toContain('previous progress warning has cleared');
      return textChunks('The evidence supports a qualified answer.');
    },
  );
  const loop = new CoreAgentLoop({
    llm,
    store,
    tools: registry,
    model: 'fake',
    workspaceRoot: '/ws',
  });
  expect(await loop.run('s', 'research', new CollectingSink())).toEqual({
    reason: 'completed',
    steps: 6,
  });
  expect((await store.load('s')).filter((event) => event.type === 'turn/guidance')).toHaveLength(2);
});
