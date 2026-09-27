import { describe, expect, it } from 'vitest';

import type { EventSink, LoopEvent, SessionEvent } from '@trinity-harness/contracts';

import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
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
  it('completes a tool-free turn with a single model call', async () => {
    const llm = new FakeLLM(() => textChunks('Hello!', ' How can I help?'));
    const { store, loop } = makeLoop(llm);
    const sink = new CollectingSink();

    const outcome = await loop.run('s1', 'hi there', sink);

    expect(outcome).toEqual({ reason: 'completed', steps: 1 });
    expect(eventTypes(await store.load('s1'))).toEqual([
      'message/user',
      'message/assistant',
      'turn/end',
    ]);
    expect(sink.types()).toEqual(['text-delta', 'text-delta', 'message/assistant', 'turn/end']);

    const [request] = llm.requests;
    expect(request!.model).toBe('fake/model');
    expect(request!.system).toBe('you are a test agent');
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
      'tool/call',
      'tool/result',
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
      'tool/call',
      'tool/result',
      'text-delta',
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

  it('persists reasoning and replays it to the model on the next turn', async () => {
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
    // The next model request must echo the reasoning back (MiniMax-M3).
    expect(llm.requests[1]!.messages).toEqual([
      { role: 'user', content: 'what is 2+2?' },
      {
        role: 'assistant',
        content: 'answer: 4',
        reasoning: [{ text: 'Let me think. ', signature: 'sig-test' }],
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
      'message/assistant',
      'turn/end',
      'message/user',
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
