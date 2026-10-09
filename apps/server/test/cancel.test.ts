import { describe, expect, it } from 'vitest';
import { CoreAgentLoop, CoreToolRegistry, MemorySessionStore } from '@trinity-harness/core';
import { FakeSandbox, FakeLLM, textChunks } from '@trinity-harness/core/testing';
import { buildServer } from '../src/server.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function session(app: Awaited<ReturnType<typeof buildServer>>): Promise<string> {
  return (await app.inject({ method: 'POST', url: '/api/sessions', payload: {} })).json()
    .sessionId as string;
}

describe('Stop cancellation', () => {
  it('aborts an inline turn and returns alreadyStopped after it terminates', async () => {
    const store = new MemorySessionStore();
    const started = deferred<AbortSignal>();
    const finished = deferred<void>();
    const app = await buildServer({
      store,
      workspaceRoot: '/tmp',
      createLoop: () => ({
        run: async (id, _prompt, sink, opts) => {
          const signal = opts!.signal!;
          started.resolve(signal);
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
          await store.append(id, [
            {
              type: 'turn/end',
              eventId: crypto.randomUUID(),
              at: '2026-01-01T00:00:00.000Z',
              reason: 'aborted',
            },
          ]);
          sink.emit({ type: 'turn/end', reason: 'aborted' });
          finished.resolve();
          return { reason: 'aborted', steps: 0 };
        },
      }),
    });
    try {
      const id = await session(app);
      await app.inject({
        method: 'POST',
        url: `/api/sessions/${id}/messages`,
        payload: { text: 'run' },
      });
      const signal = await started.promise;
      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${id}/cancel`,
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(signal.aborted).toBe(true);
      await finished.promise;
      expect((await store.load(id)).some((event) => event.type === 'turn/cancel_requested')).toBe(
        true,
      );
      expect(
        (
          await app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel`, payload: {} })
        ).json(),
      ).toMatchObject({ alreadyStopped: true });
    } finally {
      await app.close();
    }
  });

  it('persists cancellation before publishing it and prevents a queued turn from invoking the model', async () => {
    const store = new MemorySessionStore();
    const tasks: Parameters<
      NonNullable<Parameters<typeof buildServer>[0]['queue']>['enqueue']
    >[0][] = [];
    const app = await buildServer({
      store,
      workspaceRoot: '/tmp',
      queue: {
        enqueue: async (task) => {
          tasks.push(task);
        },
      },
      turns: {
        cancel: async (id) => {
          expect((await store.load(id)).at(-1)?.type).toBe('turn/cancel_requested');
        },
      },
    });
    try {
      const id = await session(app);
      await app.inject({
        method: 'POST',
        url: `/api/sessions/${id}/messages`,
        payload: { text: 'queued' },
      });
      expect(
        (await app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel`, payload: {} }))
          .statusCode,
      ).toBe(200);
      const llm = new FakeLLM(() => textChunks('later'));
      const loop = new CoreAgentLoop({
        llm,
        model: 'fake/model',
        tools: new CoreToolRegistry(new FakeSandbox()),
        store,
        workspaceRoot: '/tmp',
      });
      const task = tasks[0]!;
      expect(
        (
          await loop.run(
            id,
            task.prompt,
            { emit: () => undefined },
            { promptSeq: task.promptSeq, policy: task.policy },
          )
        ).reason,
      ).toBe('aborted');
      expect(llm.requests).toHaveLength(0);
      expect(
        (await loop.run(id, task.prompt, { emit: () => undefined }, { promptSeq: task.promptSeq }))
          .reason,
      ).toBe('aborted');
      expect((await loop.run(id, 'new prompt', { emit: () => undefined })).reason).toBe(
        'completed',
      );
      expect(llm.requests).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('reports cancellation delivery failures instead of acknowledging success', async () => {
    const store = new MemorySessionStore();
    const app = await buildServer({
      store,
      workspaceRoot: '/tmp',
      turns: {
        cancel: async () => {
          throw new Error('redis unavailable');
        },
      },
    });
    try {
      const id = await session(app);
      expect(
        (await app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel`, payload: {} }))
          .statusCode,
      ).toBe(500);
    } finally {
      await app.close();
    }
  });
});
