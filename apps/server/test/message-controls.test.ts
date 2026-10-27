import { describe, expect, it } from 'vitest';
import { MemorySessionStore } from '@trinity-harness/core';
import type { SessionEvent, TurnTask } from '@trinity-harness/contracts';
import { buildServer } from '../src/server.js';

const at = '2026-10-26T10:00:00.000Z';
const id = (): string => crypto.randomUUID();

async function setup(): Promise<{
  app: Awaited<ReturnType<typeof buildServer>>;
  store: MemorySessionStore;
  sessionId: string;
  tasks: TurnTask[];
}> {
  const store = new MemorySessionStore();
  const tasks: TurnTask[] = [];
  const app = await buildServer({
    store,
    workspaceRoot: '/tmp',
    queue: {
      enqueue: async (task) => {
        tasks.push(task);
      },
    },
  });
  const sessionId = (await app.inject({ method: 'POST', url: '/api/sessions', payload: {} })).json<{
    sessionId: string;
  }>().sessionId;
  return { app, store, sessionId, tasks };
}

async function addPrompt(
  store: MemorySessionStore,
  sessionId: string,
  reason?: 'error' | 'aborted' | 'completed',
): Promise<string> {
  const promptId = id();
  const events: SessionEvent[] = [
    {
      type: 'message/user',
      eventId: promptId,
      at,
      surfaceOp: 'append',
      content: [
        { kind: 'text', text: 'Original request' },
        { kind: 'image', uri: 'blob://original', mimeType: 'image/png' },
      ],
    },
  ];
  if (reason)
    events.push(
      {
        type: 'message/assistant',
        eventId: id(),
        at,
        surfaceOp: 'append',
        phase: reason === 'completed' ? 'final' : 'progress',
        content: [{ kind: 'text', text: 'Answer' }],
      },
      { type: 'turn/end', eventId: id(), at, promptId, reason },
    );
  await store.append(sessionId, events);
  return promptId;
}

describe('message controls API', () => {
  it.each(['user', 'assistant'] as const)(
    'removes a %s message durably without changing execution events',
    async (role) => {
      const { app, store, sessionId } = await setup();
      try {
        const promptId = await addPrompt(store, sessionId, 'completed');
        const original = await store.load(sessionId);
        const remove = () =>
          app.inject({
            method: 'DELETE',
            url: `/api/sessions/${sessionId}/messages/${promptId}/${role}`,
          });
        expect((await remove()).statusCode).toBe(204);
        expect((await remove()).statusCode).toBe(204);
        expect((await store.load(sessionId)).slice(0, original.length)).toEqual(original);
        expect(
          (await store.load(sessionId)).filter((event) => event.type === 'message/removed'),
        ).toHaveLength(1);
        expect(await store.projectMessages(sessionId)).toEqual([]);
        const page = (
          await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/timeline` })
        ).json();
        expect(page.events.at(-1)).toEqual({ type: 'message/removed', sessionId, promptId, role });
      } finally {
        await app.close();
      }
    },
  );

  it.each(['error', 'aborted'] as const)(
    'retries the complete %s request with original attachments and deduplicates acceptance',
    async (reason) => {
      const { app, store, sessionId, tasks } = await setup();
      try {
        const promptId = await addPrompt(store, sessionId, reason);
        const operationId = id();
        const retry = () =>
          app.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/messages`,
            payload: {
              text: 'Ignored client text',
              revision: { promptId, operationId, kind: 'retry' },
            },
          });
        expect((await retry()).statusCode).toBe(202);
        expect((await retry()).statusCode).toBe(202);
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject({
          prompt: 'Original request',
          content: [
            { kind: 'text', text: 'Original request' },
            { kind: 'image', uri: 'blob://original' },
          ],
        });
        const events = await store.load(sessionId);
        expect(events[tasks[0]!.promptSeq - 1]).toMatchObject({
          type: 'message/user',
          eventId: operationId,
          revision: { promptId, kind: 'retry' },
        });
        expect(events.slice(-3).map((event) => event.type)).toEqual([
          'message/removed',
          'message/removed',
          'message/user',
        ]);
      } finally {
        await app.close();
      }
    },
  );

  it('amends only the last unsuccessful prompt and preserves its attachments', async () => {
    const { app, store, sessionId, tasks } = await setup();
    try {
      const old = await addPrompt(store, sessionId, 'error');
      const latest = await addPrompt(store, sessionId, 'aborted');
      const amend = (promptId: string) =>
        app.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/messages`,
          payload: {
            text: 'Amended request',
            revision: { promptId, operationId: id(), kind: 'amend' },
          },
        });
      expect((await amend(old)).statusCode).toBe(409);
      expect((await amend(latest)).statusCode).toBe(202);
      expect(tasks[0]).toMatchObject({
        prompt: 'Amended request',
        content: [
          { kind: 'text', text: 'Amended request' },
          { kind: 'image', uri: 'blob://original' },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it.each([undefined, 'completed'] as const)('rejects revisions of %s requests', async (reason) => {
    const { app, store, sessionId, tasks } = await setup();
    try {
      const promptId = await addPrompt(store, sessionId, reason);
      for (const kind of ['amend', 'retry']) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/messages`,
          payload: { text: 'Changed', revision: { promptId, operationId: id(), kind } },
        });
        expect(response.statusCode).toBe(409);
      }
      expect(tasks).toEqual([]);
      expect((await store.load(sessionId)).some((event) => event.type === 'message/removed')).toBe(
        false,
      );
    } finally {
      await app.close();
    }
  });

  it('rejects concurrent stale revisions without submitting a second execution', async () => {
    const { app, store, sessionId, tasks } = await setup();
    try {
      const promptId = await addPrompt(store, sessionId, 'error');
      const responses = await Promise.all(
        [id(), id()].map((operationId) =>
          app.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/messages`,
            payload: { text: 'Revised', revision: { promptId, operationId, kind: 'amend' } },
          }),
        ),
      );
      expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
      expect(tasks).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
