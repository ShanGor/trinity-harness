import { describe, expect, it } from 'vitest';
import { sessionEventSchema } from '@trinity-harness/contracts';
import { serverEventSchema } from '@trinity-harness/shared';

import { logEventToServerEvent, toServerEvent } from '../src/server.js';

const at = '2026-10-08T06:12:00.000Z';

describe('message timestamps on the browser wire', () => {
  it('preserves final grounding and progress phase in live and replayed messages', () => {
    const citationList = [
      {
        kind: 'web_source' as const,
        label: 'Document',
        url: 'https://example.com/doc',
        callId: 'read',
        evidenceSeq: 3,
      },
    ];
    const event = sessionEventSchema.parse({
      type: 'message/assistant',
      eventId: crypto.randomUUID(),
      at,
      surfaceOp: 'append',
      phase: 'final',
      citationList,
      content: [{ kind: 'text', text: 'Answer' }],
    });
    expect(serverEventSchema.parse(logEventToServerEvent('s', event))).toMatchObject({
      message: { phase: 'final', citationList },
    });
    expect(
      serverEventSchema.parse(
        toServerEvent('s', {
          type: 'message/assistant',
          content: 'Answer',
          phase: 'final',
          citationList,
        }),
      ),
    ).toMatchObject({ message: { phase: 'final', citationList } });
    expect(
      serverEventSchema.parse(
        toServerEvent('s', { type: 'message/assistant', content: 'Working', phase: 'progress' }),
      ),
    ).toMatchObject({ message: { phase: 'progress' } });
  });
  it.each(['message/user', 'message/assistant'] as const)(
    'preserves the saved timestamp when replaying %s',
    (type) => {
      const event = sessionEventSchema.parse({
        type,
        eventId: '00000000-0000-4000-8000-000000000001',
        at,
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'Saved message' }],
      });
      const wire = serverEventSchema.parse(logEventToServerEvent('session', event));
      expect(wire).toMatchObject({
        type: 'message/committed',
        message: { at, content: 'Saved message' },
      });
    },
  );

  it('validates timestamps and accepts legacy messages without them', () => {
    const event = {
      type: 'message/committed',
      sessionId: 'session',
      message: { role: 'assistant', content: 'Hello' },
    };
    expect(serverEventSchema.safeParse(event).success).toBe(true);
    expect(
      serverEventSchema.safeParse({ ...event, message: { ...event.message, at: 'invalid' } })
        .success,
    ).toBe(false);
  });
});
