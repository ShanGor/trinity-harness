import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { MemorySessionStore } from '@trinity-harness/core';
import type {
  Identity,
  SessionMeta,
  SessionMetaStore,
  TurnTask,
  UserStore,
} from '@trinity-harness/contracts';
import { buildServer } from '../src/server.js';

it.each(['inline', 'worker', 'main'] as const)(
  'commits bounded request delivery on the %s path and leaves later text requests unchanged',
  async (runner) => {
    const store = new MemorySessionStore();
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'trinity-delivery-'));
    const sessionId = randomUUID();
    const owner: Identity = { tenantId: randomUUID(), userId: randomUUID(), role: 'developer' };
    const meta: SessionMeta = {
      id: sessionId,
      title: 'Test call',
      ...owner,
      workspaceUri: path.join(workspaceRoot, 'sessions', owner.userId, sessionId),
      kind: 'chat',
      sessionRole: runner === 'main' ? 'main' : 'side',
      createdAt: new Date().toISOString(),
    };
    const metas: SessionMetaStore = {
      get: async (id) => (id === sessionId ? meta : null),
      create: async () => undefined,
      listForIdentity: async () => [meta],
      setTitleIfEmpty: async () => undefined,
      close: async () => undefined,
      setPolicy: async () => undefined,
    };
    const append = vi.spyOn(store, 'append');
    const tasks: TurnTask[] = [];
    await store.append(sessionId, [
      {
        type: 'session/created',
        eventId: randomUUID(),
        at: new Date().toISOString(),
        kind: 'chat',
        workspaceUri: path.join(workspaceRoot, 'sessions', owner.userId, sessionId),
      },
    ]);
    const app = await buildServer({
      store,
      workspaceRoot,
      auth: {
        metas,
        tokens: { issue: async () => 'token', verify: async () => owner },
        hasher: { hash: async () => '', verify: async () => false },
        users: {} as UserStore,
      },
      ...(runner === 'inline'
        ? { createLoop: () => ({ run: async () => ({ reason: 'completed' as const, steps: 0 }) }) }
        : {
            queue: {
              enqueue: async (task: TurnTask): Promise<void> => {
                tasks.push(task);
              },
            },
          }),
      ...(runner === 'main'
        ? {
            sessionRuns: {
              run: async <T>(_id: string, operation: () => Promise<T>): Promise<T> => operation(),
            },
          }
        : {}),
    });
    const send = (payload: Record<string, unknown>, token = 'token') =>
      app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    try {
      // Authentication is checked before hints or prompt events can be accepted.
      const noAuth = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/messages`,
        payload: { text: 'unauthorized', delivery: { mode: 'phone', depth: 'brief' } },
      });
      expect(noAuth.statusCode).toBe(401);
      for (const delivery of [
        { mode: 'phone', depth: 'all' },
        { mode: 'phone', depth: 'brief', system: 'approve' },
        'phone',
      ]) {
        expect((await send({ text: 'invalid', delivery })).statusCode).toBe(400);
      }
      expect(await store.load(sessionId)).toHaveLength(1);
      expect(
        (await send({ text: '原始 ASR 请求', delivery: { mode: 'phone', depth: 'brief' } }))
          .statusCode,
      ).toBe(202);
      expect((await send({ text: '普通文字' })).statusCode).toBe(202);
      const requests = (await store.load(sessionId)).filter(
        (event) => event.type === 'message/user' || event.type === 'prompt/queued',
      );
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        type: runner === 'main' ? 'prompt/queued' : 'message/user',
        content: [{ kind: 'text', text: '原始 ASR 请求' }],
        delivery: { mode: 'phone', depth: 'brief' },
      });
      expect(requests[1]).not.toHaveProperty('delivery');
      expect(append).toHaveBeenCalledWith(
        sessionId,
        expect.any(Array),
        expect.objectContaining({ actor: owner.userId }),
      );
      if (runner !== 'inline') expect(tasks).toHaveLength(2);
    } finally {
      await app.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  },
);
