import { describe, expect, it, vi } from 'vitest';

import type { EventSourceLike } from '../src/index.js';
import { AcpClient } from '../src/index.js';

class FakeEventSource implements EventSourceLike {
  onmessage: ((msg: { data: unknown; lastEventId?: string }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  readyState?: number;
  closed = false;
  private lastEventId = '';
  constructor(readonly url: string) {}
  emit(data: unknown, seq?: number): void {
    if (seq !== undefined) this.lastEventId = String(seq);
    this.onmessage?.({ data: JSON.stringify(data), lastEventId: this.lastEventId });
  }
  /** Simulate a terminal HTTP failure: native EventSource stops retrying. */
  failTerminally(): void {
    this.readyState = 2;
    this.onerror?.(new Error('terminal HTTP error'));
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
  it('uses authenticated identity-owned VM routes and validates their public response', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ available: true, environment: null }),
    );
    vi.stubGlobal('fetch', fetcher);
    try {
      const client = new AcpClient({ token: 'private-token' });
      const controller = new AbortController();
      expect(await client.getEnvironment(controller.signal)).toEqual({
        available: true,
        environment: null,
      });
      await client.changeEnvironment('wake', controller.signal);
      await client.changeEnvironment('suspend', controller.signal);
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
        '/api/me/environment',
        '/api/me/environment/wake',
        '/api/me/environment/suspend',
      ]);
      expect(fetcher.mock.calls[1]![1]).toMatchObject({
        method: 'POST',
        body: '{}',
        headers: { authorization: 'Bearer private-token' },
        signal: controller.signal,
      });
      fetcher.mockImplementationOnce(async () =>
        Response.json({ available: true, environment: { state: 'ready' } }),
      );
      await expect(client.getEnvironment()).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('fetches user-only preview pixels with auth, cancellation and schema validation', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.cache).toBe('no-store');
      expect(init?.headers).toEqual({ authorization: 'Bearer private-token' });
      return Response.json({ state: 'busy' });
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      const abort = new AbortController();
      const client = new AcpClient({ baseUrl: 'https://trinity.test', token: 'private-token' });
      expect(await client.getBrowserPreview('session', abort.signal)).toEqual({ state: 'busy' });
      expect(fetcher.mock.calls[0]![0]).toBe(
        'https://trinity.test/api/sessions/session/browser-preview',
      );
      abort.abort();
      expect(fetcher.mock.calls[0]![1]!.signal?.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('posts fenced browser input without session routing in the body and validates replies', async () => {
    const sessionId = crypto.randomUUID(),
      viewId = crypto.randomUUID();
    const response = {
      state: {
        available: false,
        mode: 'paused',
        generation: null,
        epoch: 0,
        controllerId: null,
        expiresAt: null,
        nextSequence: 1,
      },
    };
    const fetcher = vi.fn(async () => Response.json(response));
    vi.stubGlobal('fetch', fetcher);
    try {
      const client = new AcpClient({ baseUrl: 'https://trinity.test', token: 'private-token' });
      const abort = new AbortController();
      expect(
        await client.interactBrowser({ sessionId, viewId, operation: 'state' }, abort.signal),
      ).toEqual(response);
      const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
      expect(url).toBe(`https://trinity.test/api/sessions/${sessionId}/browser-interaction`);
      expect(JSON.parse(String(init.body))).toEqual({ viewId, operation: 'state' });
      expect(init.headers).toEqual({
        authorization: 'Bearer private-token',
        'content-type': 'application/json',
      });
      expect(init.cache).toBe('no-store');
      abort.abort();
      expect(init.signal?.aborted).toBe(true);
      fetcher.mockImplementationOnce(async () => Response.json({ state: 'untyped' }));
      await expect(
        client.interactBrowser({ sessionId, viewId, operation: 'state' }),
      ).rejects.toThrow();
      fetcher.mockImplementationOnce(async () => new Response('', { status: 503 }));
      await expect(
        client.interactBrowser({ sessionId, viewId, operation: 'state' }),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('creates Main chat over LAN HTTP without crypto.randomUUID', async () => {
    const requests: unknown[] = [];
    const { impl } = fakeFetch({
      'POST /api/sessions': (init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({ sessionId: 'main-session' });
      },
    });
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    vi.stubGlobal('fetch', impl);
    vi.spyOn(Date, 'now').mockReturnValue(1792627200000);
    try {
      const client = new AcpClient();
      await expect(client.ensureMainChat()).resolves.toBe('main-session');
      await expect(client.ensureMainChat()).resolves.toBe('main-session');
      expect(requests).toEqual([
        expect.objectContaining({
          kind: 'chat',
          sessionRole: 'main',
          policy: 'workspace-write',
          creationOperationId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          ),
        }),
        expect.objectContaining({ creationOperationId: expect.any(String) }),
      ]);
      expect(requests[0]).not.toEqual(requests[1]);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it('delivers live deltas with inherited ids without advancing the replay cursor', () => {
    let fake!: FakeEventSource;
    const client = new AcpClient({
      eventSourceFactory: (url) => (fake = new FakeEventSource(url)),
    });
    const received: unknown[] = [];
    const sequences: number[] = [];
    const handle = client.openEventStream('abc', {
      onEvent: (event) => received.push(event),
      onSeq: (seq) => sequences.push(seq),
    });
    const user = {
      type: 'message/committed',
      sessionId: 'abc',
      message: { role: 'user', content: 'Hello' },
    };
    const text = {
      type: 'session/update',
      sessionId: 'abc',
      update: { kind: 'agent_message_chunk', text: 'Hi' },
    };
    const thought = {
      type: 'session/update',
      sessionId: 'abc',
      update: { kind: 'agent_thought_chunk', text: 'Thinking' },
    };
    fake.emit(user, 3);
    fake.emit(text);
    fake.emit(text);
    fake.emit(thought);
    fake.emit(user, 3);
    expect(received).toEqual([user, text, text, thought]);
    expect(sequences).toEqual([3]);
    expect(client.getSeq('abc')).toBe(3);

    const committed = {
      type: 'message/committed',
      sessionId: 'abc',
      message: { role: 'assistant', content: 'HiHi' },
    };
    fake.emit(committed, 5);
    fake.emit(committed, 5);
    fake.emit(text);
    expect(received).toEqual([user, text, text, thought, committed, text]);
    expect(sequences).toEqual([3, 5]);
    handle.close();
    client.openEventStream('abc', { onEvent: () => undefined }).close();
    expect(fake.url).toContain('afterSeq=5');
  });

  it('re-establishes the stream from the last committed seq after a terminal HTTP failure', async () => {
    vi.useFakeTimers();
    try {
      const sources: FakeEventSource[] = [];
      const client = new AcpClient({
        baseUrl: 'http://x',
        eventSourceFactory: (url) => {
          const source = new FakeEventSource(url);
          sources.push(source);
          return source;
        },
      });
      const received: unknown[] = [];
      const handle = client.openEventStream('abc', {
        onEvent: (event) => received.push(event),
        onError: () => undefined,
      });
      const first = {
        type: 'message/committed',
        sessionId: 'abc',
        message: { role: 'assistant', content: 'one' },
      };
      const second = {
        type: 'message/committed',
        sessionId: 'abc',
        message: { role: 'assistant', content: 'two' },
      };
      sources[0]!.emit(first, 7);
      // Server restarted behind a proxy: the reconnect attempt got an HTTP
      // error page, so the native EventSource is CLOSED and never retries.
      sources[0]!.failTerminally();
      expect(sources).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sources).toHaveLength(2);
      expect(sources[1]!.url).toBe('http://x/api/sessions/abc/events?afterSeq=7');
      // The gap is replayed by the server and rendered without a refresh.
      sources[1]!.emit(first, 7); // replay overlap: dropped by seq
      sources[1]!.emit(second, 8);
      expect(received).toEqual([first, second]);
      // A failure right after healthy delivery restarts the backoff; a
      // connection that never delivers backs off exponentially instead of
      // hot-looping.
      sources[1]!.failTerminally();
      await vi.advanceTimersByTimeAsync(1000);
      expect(sources).toHaveLength(3);
      expect(sources[2]!.url).toBe('http://x/api/sessions/abc/events?afterSeq=8');
      sources[2]!.failTerminally();
      await vi.advanceTimersByTimeAsync(1000);
      expect(sources).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sources).toHaveLength(4);
      sources[3]!.failTerminally();
      handle.close();
      sources[3]!.failTerminally();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sources).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves transient reconnection to EventSource and ignores callbacks after close', async () => {
    vi.useFakeTimers();
    try {
      const source = new FakeEventSource('');
      const factory = vi.fn(() => source);
      const onEvent = vi.fn();
      const onError = vi.fn();
      const client = new AcpClient({ eventSourceFactory: factory });
      const handle = client.openEventStream('abc', { onEvent, onError });
      source.readyState = 0;
      source.onerror?.(new Error('network interruption'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
      handle.close();
      source.failTerminally();
      source.emit({ type: 'session/turn_status', sessionId: 'abc', status: 'completed' }, 9);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onEvent).not.toHaveBeenCalled();
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects each subscriber from its own delivered cursor', async () => {
    vi.useFakeTimers();
    try {
      const sources: FakeEventSource[] = [];
      const client = new AcpClient({
        eventSourceFactory: (url) => {
          const source = new FakeEventSource(url);
          sources.push(source);
          return source;
        },
      });
      const received = vi.fn();
      const first = client.openEventStream('abc', { onEvent: received });
      const second = client.openEventStream('abc', { onEvent: () => undefined });
      const event = { type: 'session/turn_status', sessionId: 'abc', status: 'completed' };
      sources[0]!.emit(event, 7);
      sources[0]!.failTerminally();
      sources[1]!.emit(event, 10);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sources[2]!.url).toContain('afterSeq=7');
      sources[0]!.emit(event, 10); // queued callback from the abandoned source
      expect(received).toHaveBeenCalledTimes(1);
      sources[2]!.emit(event, 8);
      expect(received).toHaveBeenCalledTimes(2);
      first.close();
      second.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a selected personal folder and browses its children', async () => {
    const { impl } = fakeFetch({
      'POST http://x/api/sessions': (init) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          workspace: { scope: 'personal', path: 'projects/api' },
        });
        return new Response(JSON.stringify({ sessionId: 'abc' }), { status: 201 });
      },
      'GET http://x/api/workspaces/personal?path=projects%2Fapi': () =>
        new Response(JSON.stringify({ folders: ['src'] })),
    });
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const client = new AcpClient({ baseUrl: 'http://x' });
      expect(
        await client.createSession(undefined, undefined, {
          scope: 'personal',
          path: 'projects/api',
        }),
      ).toBe('abc');
      expect(await client.listPersonalFolders('projects/api')).toEqual(['src']);
    } finally {
      globalThis.fetch = original;
    }
  });

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

  it('returns validated cancellation status and surfaces delivery failures', async () => {
    const { impl } = fakeFetch({
      'POST http://x/api/sessions/stopped/cancel': () =>
        new Response('{"ok":true,"alreadyStopped":true}'),
      'POST http://x/api/sessions/fail/cancel': () => new Response('failed', { status: 500 }),
    });
    const client = new AcpClient({ baseUrl: 'http://x', token: 'secret' });
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      expect(await client.cancelTurn('stopped')).toEqual({ ok: true, alreadyStopped: true });
      await expect(client.cancelTurn('fail')).rejects.toThrow('cancelTurn failed: 500');
    } finally {
      globalThis.fetch = original;
    }
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

it('fetches screenshots through the authenticated session evidence route', async () => {
  const original = globalThis.fetch;
  const { impl, calls } = fakeFetch({
    'GET http://x/api/sessions/session/browser-images/observation': (init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png' },
      });
    },
  });
  globalThis.fetch = impl;
  try {
    const client = new AcpClient({ baseUrl: 'http://x', token: 'secret' });
    expect((await client.fetchBlob('blob://browser/session/observation.png')).type).toBe(
      'image/png',
    );
    expect(calls).toEqual(['GET http://x/api/sessions/session/browser-images/observation']);
  } finally {
    globalThis.fetch = original;
  }
});

it('delivers the same committed event independently to a pane and an activity subscription', () => {
  const sources: FakeEventSource[] = [];
  const client = new AcpClient({
    eventSourceFactory: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
  });
  const pane: unknown[] = [];
  const activity: unknown[] = [];
  const first = client.openEventStream(
    'same',
    { onEvent: (event) => pane.push(event) },
    { afterSeq: 0 },
  );
  const second = client.openEventStream(
    'same',
    { onEvent: (event) => activity.push(event) },
    { afterSeq: 0 },
  );
  const event = {
    type: 'message/committed',
    sessionId: 'same',
    message: { role: 'assistant', content: 'Result' },
  };
  sources[0]!.emit(event, 4);
  sources[1]!.emit(event, 4);
  sources[0]!.emit(event, 4);
  sources[1]!.emit(event, 4);
  expect(pane).toEqual([event]);
  expect(activity).toEqual([event]);
  first.close();
  second.close();
});
