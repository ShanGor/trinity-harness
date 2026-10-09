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
        content: '',
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

  it('omits prior reasoning from conversation context when the next prompt starts)', () => {
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

it('repairs a cancelled or crashed bash call without repeating its side effects', () => {
  const events = [
    user('run'),
    call('pending', 'bash', { command: 'external action' }),
    user('continue'),
  ];
  const messages = toModelMessages(events);
  const result = messages.find((message) => message.toolCallId === 'pending');
  expect(result?.content).toContain('TOOL_INTERRUPTED');
  expect(result?.content).toContain('outcome is unknown');
  expect(messages.at(-1)?.content).toBe('continue');
  expect(toModelMessages(events)).toEqual(messages);
});

it('keeps input and final output from completed turns and full active tool context', () => {
  const end: SessionEvent = { type: 'turn/end', eventId: id(), at: now(), reason: 'completed' };
  const events = [
    user('question'),
    assistant('progress'),
    call('c', 'bash', { command: 'look' }),
    result('c', { large: 'tool output' }),
    assistant('answer'),
    end,
    user('followup'),
    call('active', 'bash', { command: 'continue' }),
    result('active', 'current evidence'),
  ];
  expect(toModelMessages(events)).toEqual([
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'followup' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'active', name: 'bash', args: { command: 'continue' } }],
    },
    { role: 'tool', content: '"current evidence"', toolCallId: 'active', toolName: 'bash' },
  ]);
  expect(events).toHaveLength(9);
});

it('reports a failed turn without treating progress as its final answer', () => {
  const events: SessionEvent[] = [
    user('research'),
    assistant('looking'),
    call('c', 'bash', {}),
    result('c', 'evidence'),
    { type: 'turn/end', eventId: id(), at: now(), reason: 'error', detail: 'step limit reached' },
  ];
  const messages = toModelMessages(events);
  expect(messages).toHaveLength(2);
  expect(messages[1]?.content).toContain('without a final answer');
  expect(messages[1]?.content).toContain('step limit reached');
});
