import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '@trinity-harness/contracts';

import { toModelMessages } from '../src/index.js';

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const text = (t: string) => ({ kind: 'text' as const, text: t });

function user(t: string): SessionEvent {
  return {
    type: 'message/user',
    eventId: id(),
    at: now(),
    surfaceOp: 'append',
    content: [text(t)],
  };
}
function assistant(t: string): SessionEvent {
  return {
    type: 'message/assistant',
    eventId: id(),
    at: now(),
    surfaceOp: 'append',
    content: [text(t)],
  };
}
function call(callId: string, name: string, args: unknown): SessionEvent {
  return { type: 'tool/call', eventId: id(), at: now(), callId, name, args };
}
function result(callId: string, value: unknown): SessionEvent {
  return { type: 'tool/result', eventId: id(), at: now(), callId, value, isError: false };
}

describe('toModelMessages', () => {
  it('folds a plain conversation', () => {
    const messages = toModelMessages([
      user('hi'),
      assistant('hello'),
      user('bye'),
      assistant('cya'),
    ]);
    expect(messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'bye' },
      { role: 'assistant', content: 'cya' },
    ]);
  });

  it('attaches tool calls to the preceding assistant message and pairs results', () => {
    const messages = toModelMessages([
      user('what files?'),
      assistant('let me look'),
      call('c1', 'glob', { pattern: 'src/*' }),
      result('c1', { matches: ['src/a.ts'] }),
      assistant('found src/a.ts'),
    ]);
    expect(messages).toEqual([
      { role: 'user', content: 'what files?' },
      {
        role: 'assistant',
        content: 'let me look',
        toolCalls: [{ id: 'c1', name: 'glob', args: { pattern: 'src/*' } }],
      },
      {
        role: 'tool',
        content: JSON.stringify({ matches: ['src/a.ts'] }),
        toolCallId: 'c1',
        toolName: 'glob',
      },
      { role: 'assistant', content: 'found src/a.ts' },
    ]);
  });

  it('creates an empty assistant message for a pure tool-call step', () => {
    const messages = toModelMessages([
      user('go'),
      call('c1', 'bash', { command: 'ls' }),
      result('c1', {}),
    ]);
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'ls' } }],
    });
  });

  it('replays assistant reasoning blocks verbatim (MiniMax-M3 requirement)', () => {
    const messages = toModelMessages([
      user('what is 2+2?'),
      {
        type: 'message/assistant',
        eventId: id(),
        at: now(),
        surfaceOp: 'append',
        content: [{ kind: 'reasoning', text: 'thinking…', signature: 'sig-9' }, text('4')],
      },
      user('and 3+3?'),
    ]);
    expect(messages).toEqual([
      { role: 'user', content: 'what is 2+2?' },
      {
        role: 'assistant',
        content: '4',
        reasoning: [{ text: 'thinking…', signature: 'sig-9' }],
      },
      { role: 'user', content: 'and 3+3?' },
    ]);
  });

  it('ignores non-model-facing events', () => {
    const events: SessionEvent[] = [
      { type: 'session/created', eventId: id(), at: now(), workspaceUri: '/ws' },
      { type: 'turn/start', eventId: id(), at: now() },
      { type: 'turn/end', eventId: id(), at: now(), reason: 'completed' },
      user('q'),
    ];
    expect(toModelMessages(events)).toEqual([{ role: 'user', content: 'q' }]);
  });
});
