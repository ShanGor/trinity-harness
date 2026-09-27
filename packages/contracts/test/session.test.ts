import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '../src/index.js';
import { projectMessages, sessionEventSchema } from '../src/index.js';

const now = new Date().toISOString();

function ev(event: SessionEvent): SessionEvent {
  return event;
}

const text = (t: string) => ({ kind: 'text' as const, text: t });

describe('sessionEventSchema', () => {
  it('accepts a valid discriminated union member', () => {
    const parsed = sessionEventSchema.parse(
      ev({
        type: 'message/user',
        eventId: '3f6f8f9a-2f3f-4b8a-9f2e-7a7b6c5d4e3f',
        at: now,
        surfaceOp: 'append',
        content: [text('hello')],
      }),
    );
    expect(parsed.type).toBe('message/user');
  });

  it('rejects unknown event types at the boundary', () => {
    expect(() =>
      sessionEventSchema.parse({
        type: 'message/ghost',
        eventId: '3f6f8f9a-2f3f-4b8a-9f2e-7a7b6c5d4e3f',
        at: now,
      }),
    ).toThrow();
  });
});

describe('projectMessages', () => {
  const id = () => crypto.randomUUID();

  it('appends user and assistant messages in order', () => {
    const surface = projectMessages([
      { type: 'turn/start', eventId: id(), at: now },
      {
        type: 'message/user',
        eventId: id(),
        at: now,
        surfaceOp: 'append',
        content: [text('hi')],
      },
      {
        type: 'message/assistant',
        eventId: id(),
        at: now,
        surfaceOp: 'append',
        content: [text('hello!')],
      },
      { type: 'turn/end', eventId: id(), at: now, reason: 'completed' },
    ]);
    expect(surface).toEqual([
      { role: 'user', content: [text('hi')] },
      { role: 'assistant', content: [text('hello!')] },
    ]);
  });

  it('replace settles the most recent assistant message', () => {
    const surface = projectMessages([
      {
        type: 'message/assistant',
        eventId: id(),
        at: now,
        surfaceOp: 'append',
        content: [text('partial')],
      },
      {
        type: 'message/assistant',
        eventId: id(),
        at: now,
        surfaceOp: 'replace',
        content: [text('settled')],
      },
    ]);
    expect(surface).toEqual([{ role: 'assistant', content: [text('settled')] }]);
  });

  it('replace appends when the last message is not from the assistant', () => {
    const surface = projectMessages([
      {
        type: 'message/user',
        eventId: id(),
        at: now,
        surfaceOp: 'append',
        content: [text('q')],
      },
      {
        type: 'message/assistant',
        eventId: id(),
        at: now,
        surfaceOp: 'replace',
        content: [text('a')],
      },
    ]);
    expect(surface).toHaveLength(2);
  });
});
