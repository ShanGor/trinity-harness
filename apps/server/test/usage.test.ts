import { describe, expect, it, vi } from 'vitest';
import {
  modelUsageSchema,
  sessionEventSchema,
  type SessionEvent,
} from '@trinity-harness/contracts';
import { CoreAgentLoop, CoreToolRegistry, MemorySessionStore } from '@trinity-harness/core';
import { FakeLLM, FakeSandbox, textChunks } from '@trinity-harness/core/testing';
import { serverEventSchema } from '@trinity-harness/shared';
import { buildServer, logEventToServerEvent, toServerEvent } from '../src/server.js';

const sessionId = '00000000-0000-4000-8000-000000000001';
const promptId = '00000000-0000-4000-8000-000000000002';
const at = '2026-10-11T12:00:00Z';
const usage = modelUsageSchema.parse({
  requestId: '00000000-0000-4000-8000-000000000003',
  promptId,
  model: 'fake/a',
  purpose: 'assistant',
  tokens: {
    inputTokens: 100,
    uncachedInputTokens: 50,
    cacheReadTokens: 50,
    cacheWriteTokens: 0,
    outputTokens: 10,
  },
  pricing: { currency: 'USD', version: 'v1', input: '2', output: '10', cacheRead: '0.2' },
  cost: { currency: 'USD', amount: '0.00021000000000' },
});
const usageEvent: SessionEvent = { type: 'model/usage', eventId: usage.requestId, at, usage };

async function readFrames(
  response: Response,
  stop: (data: string) => boolean,
): Promise<{ id?: number; data: string }[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: { id?: number; data: string }[] = [];
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE ended before expected frame');
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = raw.match(/^data: (.*)$/m)?.[1];
        if (!data) continue;
        const id = raw.match(/^id: (\d+)$/m)?.[1];
        frames.push({ ...(id ? { id: Number(id) } : {}), data });
        if (stop(data)) return frames;
      }
    }
  } finally {
    await reader.cancel();
  }
}

describe('usage transport and replay', () => {
  it('validates the same usage DTO for live delivery and log replay', () => {
    expect(sessionEventSchema.parse(usageEvent)).toEqual(usageEvent);
    const wire = { type: 'model/usage', sessionId, usage };
    expect(serverEventSchema.parse(logEventToServerEvent(sessionId, usageEvent))).toEqual(wire);
    expect(toServerEvent(sessionId, { type: 'model/usage', usage })).toEqual(wire);
  });

  it('reopens/resumes inline usage with durable sequence IDs, exports it, and carries ACP metadata', async () => {
    const store = new MemorySessionStore();
    await store.append(sessionId, [
      { type: 'session/created', eventId: sessionId, at, workspaceUri: '/ws' },
      {
        type: 'message/user',
        eventId: promptId,
        at,
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'go' }],
      },
      usageEvent,
      {
        type: 'message/assistant',
        eventId: '00000000-0000-4000-8000-000000000004',
        at,
        phase: 'final',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'done' }],
      },
      {
        type: 'turn/end',
        eventId: '00000000-0000-4000-8000-000000000005',
        at,
        reason: 'completed',
      },
    ]);
    const app = await buildServer({ store, workspaceRoot: '/ws' });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const stream = await fetch(`${address}/api/sessions/${sessionId}/events`, {
        signal: AbortSignal.timeout(5000),
      });
      const frames = await readFrames(
        stream,
        (data) => serverEventSchema.parse(JSON.parse(data)).type === 'session/turn_status',
      );
      expect(
        frames.find(
          (frame) => serverEventSchema.parse(JSON.parse(frame.data)).type === 'model/usage',
        ),
      ).toEqual({ id: 3, data: JSON.stringify({ type: 'model/usage', sessionId, usage }) });
      const resumed = await fetch(`${address}/api/sessions/${sessionId}/events?afterSeq=2`, {
        signal: AbortSignal.timeout(5000),
      });
      expect((await readFrames(resumed, () => true))[0]?.id).toBe(3);
      const exported = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/export`,
      });
      expect(exported.json().usage).toEqual([usage]);
      const acp = await fetch(`${address}/acp/stream?sessionId=${sessionId}`, {
        signal: AbortSignal.timeout(5000),
      });
      const acpFrames = await readFrames(acp, (data) => data.includes('trinity.modelUsage'));
      expect(JSON.parse(acpFrames.at(-1)!.data)).toMatchObject({
        method: 'session/update',
        params: {
          update: { sessionUpdate: 'session_info_update', _meta: { 'trinity.modelUsage': usage } },
        },
      });
    } finally {
      await app.close();
    }
  });
});

it('streams inline deltas without querying persistence for every chunk', async () => {
  const store = new MemorySessionStore();
  const reads = vi.spyOn(store, 'loadRange');
  const llm = new FakeLLM(() => [
    ...textChunks(...Array.from({ length: 100 }, () => 'x')).slice(0, -1),
    { kind: 'usage', ...usage.tokens },
    { kind: 'finish', reason: 'stop' },
  ]);
  const app = await buildServer({
    store,
    workspaceRoot: '/ws',
    createLoop: () =>
      new CoreAgentLoop({
        store,
        llm,
        model: 'fake/a',
        tools: new CoreToolRegistry(new FakeSandbox()),
        workspaceRoot: '/ws',
      }),
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const stream = await fetch(`${address}/api/sessions/${sessionId}/events`, {
      signal: AbortSignal.timeout(5000),
    });
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: 'go' },
    });
    const frames = await readFrames(
      stream,
      (data) => serverEventSchema.parse(JSON.parse(data)).type === 'session/turn_status',
    );
    expect(
      frames.some(
        (frame) => serverEventSchema.parse(JSON.parse(frame.data)).type === 'model/usage',
      ),
    ).toBe(true);
    expect(reads.mock.calls.length).toBeLessThan(10);
  } finally {
    await app.close();
  }
});

it('delivers inline runner errors after replay without inheriting a committed sequence ID', async () => {
  const store = new MemorySessionStore();
  const app = await buildServer({
    store,
    workspaceRoot: '/ws',
    createLoop: () => ({
      run: async () => {
        throw new Error('runner unavailable');
      },
    }),
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const stream = await fetch(`${address}/api/sessions/${sessionId}/events`, {
      signal: AbortSignal.timeout(5000),
    });
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: 'go' },
    });
    const frames = await readFrames(
      stream,
      (data) => serverEventSchema.parse(JSON.parse(data)).type === 'error',
    );
    expect(frames.at(-1)?.id).toBeUndefined();
    expect(JSON.parse(frames.at(-1)!.data)).toMatchObject({
      type: 'error',
      message: 'runner unavailable',
    });
  } finally {
    await app.close();
  }
});
