import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type {
  EnvironmentMaintenancePort,
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
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/sessions/${randomUUID()}/browser-interaction`,
          payload: { operation: 'state', viewId: randomUUID() },
        })
      ).statusCode,
    ).toBe(501);
  } finally {
    await app.close();
  }
});

it('drains and resumes a Firecracker node with the dedicated operator token', async () => {
  const token = 'm'.repeat(32);
  const maintenance: EnvironmentMaintenancePort = {
    drainNode: vi.fn(async (nodeId) => ({
      nodeId,
      state: 'draining' as const,
      stopped: 3,
      remaining: 0,
      failed: 0,
    })),
    resumeNode: vi.fn(async () => undefined),
  };
  const verify = vi.fn(async () => null);
  const app = await buildServer({
    store: new MemorySessionStore(),
    workspaceRoot: '/workspace',
    environmentMaintenance: maintenance,
    firecrackerMaintenanceToken: token,
    auth: {
      tokens: { verify, issue: async () => 'unused' },
      users: {} as UserStore,
      metas: {} as SessionMetaStore,
      hasher: { hash: async () => '', verify: async () => false },
    },
  });
  try {
    const drainUrl = '/api/ops/firecracker-nodes/host-1/drain';
    expect((await app.inject({ method: 'POST', url: drainUrl, payload: {} })).statusCode).toBe(401);
    const drained = await app.inject({
      method: 'POST',
      url: drainUrl,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(drained.statusCode).toBe(200);
    expect(drained.json()).toMatchObject({ nodeId: 'host-1', remaining: 0 });
    expect(maintenance.drainNode).toHaveBeenCalledWith('host-1', expect.any(AbortSignal));
    const resumed = await app.inject({
      method: 'POST',
      url: '/api/ops/firecracker-nodes/host-1/resume',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toEqual({ nodeId: 'host-1', state: 'ready' });
    expect(maintenance.resumeNode).toHaveBeenCalledWith('host-1');
    expect(verify).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('keeps interactive browser commands owner-only, validates their scope and rechecks revocation', async () => {
  const owner: Identity = { userId: randomUUID(), tenantId: randomUUID(), role: 'developer' };
  let identity = owner;
  const meta: SessionMeta = {
    id: randomUUID(),
    userId: owner.userId,
    tenantId: owner.tenantId,
    title: 'Owned',
    workspaceUri: '/workspace',
    scope: 'personal',
    createdAt: '2026-10-26T00:00:00Z',
  };
  const state = {
    available: false,
    mode: 'paused' as const,
    generation: null,
    epoch: 0,
    controllerId: null,
    expiresAt: null,
    nextSequence: 1,
  };
  const interact = vi.fn(async () => ({ state }));
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
    browserInteraction: { interact },
    auth: {
      metas,
      users: {} as UserStore,
      tokens: { verify: async () => identity, issue: async () => 'token' },
      hasher: { hash: async () => '', verify: async () => false },
    },
  });
  const url = `/api/sessions/${meta.id}/browser-interaction`,
    headers = { authorization: 'Bearer token' },
    payload = { viewId: randomUUID(), operation: 'take' };
  try {
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...payload, sessionId: randomUUID() },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...payload, script: 'arbitrary()' },
        })
      ).statusCode,
    ).toBe(400);
    const response = await app.inject({ method: 'POST', url, headers, payload });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(interact.mock.calls[0]).toEqual([
      { ...payload, sessionId: meta.id },
      expect.any(AbortSignal),
    ]);
    identity = { ...owner, role: 'admin', userId: randomUUID() };
    expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(404);
    expect(interact).toHaveBeenCalledTimes(1);
    identity = owner;
    interact.mockImplementationOnce(async () => {
      meta.closedAt = '2026-10-26T00:01:00Z';
      return { state };
    });
    expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(404);
  } finally {
    await app.close();
  }
});
