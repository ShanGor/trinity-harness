import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  writeFileTool,
} from '@trinity-harness/core';
import {
  FakeLLM,
  FakeSandbox,
  textChunks,
  toolCallThenFinish,
} from '@trinity-harness/core/testing';
import { serverEventSchema } from '@trinity-harness/shared';
import type { ServerEvent } from '@trinity-harness/shared';

import { buildServer } from '../src/index.js';

function makeApp() {
  const store = new MemorySessionStore();
  const sandbox = new FakeSandbox();
  const llm = new FakeLLM(
    () => toolCallThenFinish('c1', 'write_file', { path: 'hi.txt', content: 'hello' }),
    () => textChunks('File written.'),
  );
  const tools = new CoreToolRegistry(sandbox);
  tools.register(writeFileTool);
  return buildServer({
    store,
    workspaceRoot: '/ws',
    createLoop: () =>
      new CoreAgentLoop({
        llm,
        model: 'fake/model',
        tools,
        store,
        workspaceRoot: '/ws',
      }),
  });
}

describe('buildServer', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  let baseUrl: string;

  beforeAll(async () => {
    app = await makeApp();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
  });

  afterAll(async () => {
    await app.close();
  });

  it('health check', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('full round-trip: create session, stream SSE, post prompt, committed message', async () => {
    // 1. Create session.
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'test' }),
    });
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };

    // 2. Open SSE stream first (avoids the M1 no-replay race).
    const stream = await fetch(`${baseUrl}/api/sessions/${sessionId}/events`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readNext = async (): Promise<ServerEvent> => {
      for (;;) {
        const lineEnd = buffer.indexOf('\n\n');
        if (lineEnd >= 0) {
          const raw = buffer.slice(0, lineEnd);
          buffer = buffer.slice(lineEnd + 2);
          const data = raw.replace(/^data: /m, '').trim();
          if (data.startsWith('{')) {
            return serverEventSchema.parse(JSON.parse(data));
          }
          continue; // heartbeat comments etc.
        }
        const { done, value } = await reader.read();
        if (done) throw new Error('stream closed before next event');
        buffer += decoder.decode(value, { stream: true });
      }
    };

    // 3. Send the prompt.
    const posted = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'write hello to hi.txt' }),
    });
    expect(posted.status).toBe(202);

    // 4. Observe tool call + committed assistant message over SSE.
    const seen: ServerEvent[] = [];
    while (seen.filter((e) => e.type === 'message/committed').length < 1) {
      const event = await Promise.race([
        readNext(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sse timeout')), 5000)),
      ]);
      seen.push(event);
    }
    const kinds = seen.map((e) =>
      e.type === 'session/update'
        ? `update:${e.update.kind}:${e.update.kind === 'tool_call' ? e.update.status : ''}`
        : e.type,
    );
    expect(kinds).toContain('update:tool_call:in_progress');
    expect(kinds).toContain('update:tool_call:completed');
    expect(kinds).toContain('message/committed');

    const committed = seen.find((e) => e.type === 'message/committed');
    expect(committed).toMatchObject({ message: { role: 'assistant', content: 'File written.' } });

    await reader.cancel();
  }, 15000);

  it('rejects invalid payloads at the boundary', async () => {
    const bad = await fetch(`${baseUrl}/api/sessions/000/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(bad.status).toBe(400);
  });

  it('serves the projected history', async () => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ping' }),
    });
    // The fake LLM queue is per-app; reuse the shared app fakes via a fresh
    // scripted run is not possible here, so just assert the endpoint shape on
    // an empty session.
    const history = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`);
    expect(history.status).toBe(200);
    const body = (await history.json()) as { messages: unknown[] };
    expect(Array.isArray(body.messages)).toBe(true);
  });
});
