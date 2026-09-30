import { describe, expect, it } from 'vitest';

import type { EventSourceLike } from '../src/index.js';
import { AcpClient } from '../src/index.js';

class FakeEventSource implements EventSourceLike {
  onmessage: ((msg: { data: unknown; lastEventId?: string }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  emit(data: unknown, seq?: number): void {
    this.onmessage?.({ data: JSON.stringify(data), ...(seq ? { lastEventId: String(seq) } : {}) });
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

  it('drops repeated committed events by sequence and resets for deliberate history replay', () => {
    let fake!: FakeEventSource;
    const client = new AcpClient({
      eventSourceFactory: (url) => (fake = new FakeEventSource(url)),
    });
    const received: unknown[] = [];
    const event = {
      type: 'message/committed',
      sessionId: 'abc',
      message: { role: 'assistant', content: 'once' },
    };
    const handle = client.openEventStream('abc', { onEvent: (value) => received.push(value) });
    fake.emit(event, 4);
    fake.emit(event, 4);
    expect(received).toHaveLength(1);
    handle.close();

    const replay = client.openEventStream(
      'abc',
      { onEvent: (value) => received.push(value) },
      { afterSeq: 0 },
    );
    fake.emit(event, 4);
    expect(received).toHaveLength(2);
    replay.close();
  });

  it('uses authenticated export and delete endpoints', async () => {
    const { impl, calls } = fakeFetch({
      'GET http://x/api/sessions/abc/export': () =>
        new Response('{"messages":[]}', { status: 200 }),
      'DELETE http://x/api/sessions/abc': () => new Response(null, { status: 204 }),
    });
    const client = new AcpClient({ baseUrl: 'http://x', token: 'secret' });
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      expect(await (await client.exportSession('abc')).text()).toBe('{"messages":[]}');
      await client.deleteSession('abc');
      expect(calls).toEqual([
        'GET http://x/api/sessions/abc/export',
        'DELETE http://x/api/sessions/abc',
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
