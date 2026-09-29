import { describe, expect, it } from 'vitest';

import type { EventSourceLike } from '../src/index.js';
import { AcpClient } from '../src/index.js';

class FakeEventSource implements EventSourceLike {
  onmessage: ((msg: { data: unknown }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  close(): void {
    this.closed = true;
  }
}

function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: string[] = [];
  const impl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const key = `${init?.method ?? 'GET'} ${String(url)}`;
    calls.push(key);
    const handler = routes[key];
    if (!handler) {
      return new Response('not found', { status: 404 });
    }
    return handler(init);
  };
  return { impl: impl as typeof fetch, calls };
}

describe('AcpClient', () => {
  it('creates sessions, sends prompts and fetches history', async () => {
    const { impl } = fakeFetch({
      'POST http://x/api/sessions': () =>
        new Response(JSON.stringify({ sessionId: 'abc' }), { status: 201 }),
      'POST http://x/api/sessions/abc/messages': () =>
        new Response(JSON.stringify({ accepted: true }), { status: 202 }),
      'GET http://x/api/sessions/abc/messages': () =>
        new Response(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), {
          status: 200,
        }),
    });
    const client = new AcpClient({
      baseUrl: 'http://x',
      eventSourceFactory: (u) => new FakeEventSource(u),
    });
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const sessionId = await client.createSession('t');
      expect(sessionId).toBe('abc');
      await client.sendPrompt(sessionId, 'hello');
      const history = await client.getMessages(sessionId);
      expect(history).toEqual([{ role: 'user', content: 'hi' }]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('validates streamed events and closes cleanly', async () => {
    let fake!: FakeEventSource;
    const client = new AcpClient({
      baseUrl: 'http://x',
      eventSourceFactory: (url) => (fake = new FakeEventSource(url)),
    });
    const received: unknown[] = [];
    const errors: unknown[] = [];
    const handle = client.openEventStream('abc', {
      onEvent: (e) => received.push(e),
      onError: (e) => errors.push(e),
    });

    expect(fake.url).toBe('http://x/api/sessions/abc/events?afterSeq=0');

    fake.emit({
      type: 'message/committed',
      sessionId: 'abc',
      message: { role: 'assistant', content: 'ok' },
    });
    fake.emit({ type: 'not-a-real-event' });

    expect(received).toEqual([
      {
        type: 'message/committed',
        sessionId: 'abc',
        message: { role: 'assistant', content: 'ok' },
      },
    ]);
    expect(errors).toHaveLength(1); // malformed payload dropped + reported

    handle.close();
    expect(fake.closed).toBe(true);
  });
});
