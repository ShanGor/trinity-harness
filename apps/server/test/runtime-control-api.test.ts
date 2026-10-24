import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type {
  Identity,
  SessionMeta,
  SessionMetaStore,
  UserStore,
} from '@trinity-harness/contracts';
import { MemorySessionStore } from '@trinity-harness/core';
import { buildServer } from '../src/index.js';

it('keeps live private pixels owner-only and rechecks access before delivery', async () => {
  const owner: Identity = { userId: randomUUID(), tenantId: randomUUID(), role: 'developer' };
  let identity = owner;
  const meta: SessionMeta = {
    id: randomUUID(),
    userId: owner.userId,
    tenantId: owner.tenantId,
    title: 'Private',
    workspaceUri: '/workspace',
    scope: 'personal',
    createdAt: '2026-10-24T00:00:00Z',
  };
  const preview = vi.fn(async () => ({ state: 'privacy_blocked' as const }));
  const metas: SessionMetaStore = {
    get: async () => meta,
    create: vi.fn(async () => undefined),
    listForIdentity: async () => [meta],
    setTitleIfEmpty: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    setPolicy: vi.fn(async () => undefined),
  };
  const app = await buildServer({
    store: new MemorySessionStore(),
    workspaceRoot: '/workspace',
    browserPreview: { preview },
    auth: {
      metas,
      users: {} as UserStore,
      tokens: { verify: async () => identity, issue: async () => 'token' },
      hasher: { hash: async () => '', verify: async () => false },
    },
  });
  const url = `/api/sessions/${meta.id}/browser-preview`;
  try {
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const first = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer token' },
    });
    expect(first.json()).toEqual({ state: 'privacy_blocked' });
    expect(first.headers['cache-control']).toBe('private, no-store');
    identity = { ...owner, userId: randomUUID(), role: 'admin' };
    expect(
      (await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer token' } }))
        .statusCode,
    ).toBe(404);
    expect(preview).toHaveBeenCalledOnce();
    identity = owner;
    preview.mockImplementation(async () => {
      meta.closedAt = '2026-10-24T00:01:00Z';
      return { state: 'privacy_blocked' };
    });
    expect(
      (await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer token' } }))
        .statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});
it('reports disabled scheduling/environment capabilities without inventing runnable plans', async () => {
  const app = await buildServer({ store: new MemorySessionStore(), workspaceRoot: '/workspace' });
  try {
    expect((await app.inject({ method: 'GET', url: '/api/schedules' })).json()).toEqual({
      available: false,
      schedules: [],
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/schedules', payload: {} })).statusCode,
    ).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/api/me/environment' })).json()).toEqual({
      available: false,
      environment: null,
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/me/environment/wake', payload: {} }))
        .statusCode,
    ).toBe(503);
  } finally {
    await app.close();
  }
});
