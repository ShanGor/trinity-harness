import { describe, expect, it } from 'vitest';

import type { LLMRequest, SessionEvent } from '@trinity-harness/contracts';

import {
  ContextManager,
  exchangeGroups,
  MemorySessionStore,
  toModelMessages,
} from '../src/index.js';
import { FakeLLM, textChunks } from '../src/testing/fake-llm.js';

const now = new Date().toISOString();
const id = () => crypto.randomUUID();
const text = (t: string) => ({ kind: 'text' as const, text: t });

function user(t: string): SessionEvent {
  return { type: 'message/user', eventId: id(), at: now, surfaceOp: 'append', content: [text(t)] };
}
function assistant(t: string): SessionEvent {
  return {
    type: 'message/assistant',
    eventId: id(),
    at: now,
    surfaceOp: 'append',
    content: [text(t)],
  };
}
function compaction(fromSeq: number, toSeq: number, summary = 's'): SessionEvent {
  return { type: 'compaction/summary', eventId: id(), at: now, fromSeq, toSeq, summary };
}

describe('exchangeGroups (compaction boundary snapping)', () => {
  it('groups a user message with everything up to the next user message', () => {
    const groups = exchangeGroups([
      user('a'),
      assistant('x'),
      { type: 'tool/call', eventId: id(), at: now, callId: 'c1', name: 'bash', args: {} },
      { type: 'tool/result', eventId: id(), at: now, callId: 'c1', value: {}, isError: false },
      user('b'),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ fromSeq: 1, toSeq: 4 });
    expect(groups[1]).toMatchObject({ fromSeq: 5, toSeq: 5 });
  });
});

describe('toModelMessages with compaction ranges', () => {
  it('skips compacted events and injects the summary as a user message', () => {
    const messages = toModelMessages([
      user('a'),
      assistant('x'),
      {
        type: 'tool/call',
        eventId: id(),
        at: now,
        callId: 'c1',
        name: 'bash',
        args: { command: 'ls' },
      },
      {
        type: 'tool/result',
        eventId: id(),
        at: now,
        callId: 'c1',
        value: { stdout: '' },
        isError: false,
      },
      compaction(1, 4, ' AX plus ls'),
      user('b'),
      assistant('y'),
    ]);
    expect(messages[0]).toEqual(
      expect.objectContaining({ role: 'user', content: expect.stringContaining('AX plus ls') }),
    );
    expect(messages[1]).toEqual(expect.objectContaining({ role: 'user', content: 'b' }));
    expect(messages[2]).toEqual(expect.objectContaining({ role: 'assistant', content: 'y' }));
    // No dangling tool calls or results from the compacted range.
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(0);
    expect(messages.flatMap((m) => m.toolCalls ?? [])).toHaveLength(0);
  });

  it('carries image/file blocks on user messages for the multimodal gateway', () => {
    const messages = toModelMessages([
      {
        type: 'message/user',
        eventId: id(),
        at: now,
        surfaceOp: 'append',
        content: [text('look'), { kind: 'image', uri: 'blob://k1', mimeType: 'image/png' }],
      },
    ]);
    expect(messages[0]!.blocks).toEqual([
      { kind: 'image', uri: 'blob://k1', mimeType: 'image/png' },
    ]);
    // Text part carries text blocks only — the image rides via `blocks`.
    expect(messages[0]!.content).toBe('look');
  });
});

describe('ContextManager', () => {
  function managerFor(store: MemorySessionStore, llm: FakeLLM, maxTokens = 100, keepTokens = 40) {
    return new ContextManager({
      llm,
      model: 'fake/model',
      store,
      maxTokens,
      keepTokens,
      // Deterministic: 1 token per char.
      estimate: (messages, system) =>
        (system?.length ?? 0) + messages.reduce((n, m) => n + m.content.length, 0),
    });
  }

  it('is a no-op when under budget', async () => {
    const store = new MemorySessionStore();
    await store.append('s1', [user('short'), assistant('ok')]);
    const llm = new FakeLLM(); // no scripts: summarizer must never be called
    const result = await managerFor(store, llm).compact('s1');
    expect(result.compacted).toBe(false);
  });

  it('compacts whole exchanges, keeps the latest user message, appends the summary event', async () => {
    const store = new MemorySessionStore();
    // 3 exchanges of ~40 chars each; budget 100, keep 40 ⇒ first exchange folds.
    await store.append('s1', [
      user('a'.repeat(40)),
      assistant('x'.repeat(40)),
      user('b'.repeat(40)),
      assistant('y'.repeat(40)),
      user('keep me — the current prompt'),
      assistant('working…'),
    ]);
    const llm = new FakeLLM(() => textChunks('SUMMARY OF AX'));
    const result = await managerFor(store, llm).compact('s1');

    expect(result.compacted).toBe(true);
    expect(result.fromSeq).toBe(1);
    expect(result.toSeq).toBe(2); // whole first exchange only

    const log = await store.load('s1');
    expect(log.at(-1)!.type).toBe('compaction/summary');
    expect(log).toHaveLength(7); // append-only

    // The model-visible fold starts IN PLACE with the summary, then the
    // retained exchanges — chronology preserved despite the append-only log.
    const messages = toModelMessages(log);
    expect(messages[0]!.content).toContain('SUMMARY OF AX');
    expect(JSON.stringify(messages)).not.toContain('a'.repeat(20));
    expect(messages.at(-1)).toEqual(expect.objectContaining({ role: 'assistant' }));
  });

  it('never compacts the only/latest exchange (in-flight prompt stays)', async () => {
    const store = new MemorySessionStore();
    await store.append('s1', [
      user('only prompt'.padEnd(500, '!')),
      assistant('long '.padEnd(500, 'y')),
    ]);
    const llm = new FakeLLM(); // summarizer must never be called
    const result = await managerFor(store, llm).compact('s1');
    expect(result.compacted).toBe(false);
  });

  it('applies a second compaction after the first without overlapping ranges', async () => {
    const store = new MemorySessionStore();
    await store.append('s1', [
      user('1'.repeat(50)),
      assistant('2'.repeat(50)),
      user('3'.repeat(50)),
      assistant('4'.repeat(50)),
      user('keep'),
    ]);
    const llm = new FakeLLM(
      () => textChunks('sum'),
      () => textChunks('sum2'),
    );
    const manager = managerFor(store, llm, 120, 30);
    const first = await manager.compact('s1');
    expect(first.compacted).toBe(true);
    const second = await manager.compact('s1');
    expect(second.compacted).toBe(true);
    expect(second.fromSeq).toBeGreaterThan(first.toSeq!);
    const ranges = toModelMessages(await store.load('s1'));
    expect(ranges.filter((m) => m.content.includes('sum'))).toHaveLength(2);
  });

  it('sends the dropped range to the summarizer', async () => {
    const store = new MemorySessionStore();
    const droppedUser = 'd'.repeat(200);
    const droppedAssistant = 'e'.repeat(200);
    await store.append('s1', [user(droppedUser), assistant(droppedAssistant), user('kept')]);
    let seen: LLMRequest | null = null;
    const llm = new FakeLLM((req) => {
      seen = req;
      return textChunks('compact!');
    });
    const manager = new ContextManager({
      llm,
      model: 'fake/model',
      store,
      maxTokens: 400,
      keepTokens: 50,
      estimate: (messages) => messages.reduce((n, m) => n + m.content.length, 0),
    });
    const result = await manager.compact('s1');
    expect(result.compacted).toBe(true);
    expect(seen!.messages[0]!.content).toContain(droppedUser);
    expect(seen!.messages[0]!.content).toContain(droppedAssistant);
    expect(seen!.system).toContain('compact');
  });
});
