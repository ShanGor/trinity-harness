import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  Identity,
  PasswordHasher,
  QuotaAdminPort,
  Role,
  SessionMeta,
  SessionMetaStore,
  TenantQuota,
  UsagePort,
  UsageRecord,
  User,
  UserStore,
} from '@trinity-harness/contracts';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  HmacTokenService,
  MemorySessionStore,
} from '@trinity-harness/core';
import { FakeLLM, FakeSandbox, textChunks } from '@trinity-harness/core/testing';

import { buildServer } from '../src/index.js';

const WS_DIR = mkdtempSync(path.join(tmpdir(), 'trinity-m5-'));

/** In-memory doubles (apps may import implementations — AGENTS.md §3.3). */

class FakeHasher implements PasswordHasher {
  async hash(p: string): Promise<string> {
    return `h:${p}`;
  }
  async verify(p: string, e: string): Promise<boolean> {
    return e === `h:${p}`;
  }
}

class FakeUserStore implements UserStore {
  private readonly byId = new Map<string, User>();
  constructor(
    private readonly hasher: FakeHasher,
    private readonly password: string,
  ) {}
  async findByEmail(): Promise<User | null> {
    return null;
  }
  async findById(userId: string): Promise<User | null> {
    return this.byId.get(userId) ?? null;
  }
  async verifyCredentials(email: string, password: string): Promise<User | null> {
    if (password !== this.password) return null;
    return (
      [...this.byId.values()].find((u) => u.email === email) ?? {
        id: crypto.randomUUID(),
        tenantId: 't1',
        email,
        role: 'developer' as const,
        createdAt: new Date().toISOString(),
      }
    );
  }
  async createUser(input: {
    tenantId: string;
    email: string;
    passwordHash: string;
    role: Role;
  }): Promise<User> {
    const user: User = {
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      email: input.email,
      role: input.role,
      createdAt: new Date().toISOString(),
    };
    this.byId.set(user.id, user);
    return user;
  }
  async listByTenant(): Promise<User[]> {
    return [];
  }
}

class FakeMetaStore implements SessionMetaStore {
  private readonly metas = new Map<string, SessionMeta>();
  async create(meta: Omit<SessionMeta, 'createdAt'>): Promise<void> {
    this.metas.set(meta.id, { ...meta, createdAt: new Date().toISOString() });
  }
  async get(sessionId: string): Promise<SessionMeta | null> {
    return this.metas.get(sessionId) ?? null;
  }
  async listForIdentity(identity: Identity): Promise<SessionMeta[]> {
    return [...this.metas.values()].filter((m) => m.tenantId === identity.tenantId);
  }
  async setPolicy(): Promise<void> {}
  async setTitleIfEmpty(): Promise<void> {}
  async close(): Promise<void> {}
}

/** In-memory UsagePort + QuotaAdminPort with real window aggregation. */
class FakeUsage implements UsagePort, QuotaAdminPort {
  readonly records: UsageRecord[] = [];
  quota: TenantQuota = {};
  failQuota = false;

  async record(entry: UsageRecord): Promise<void> {
    this.records.push(entry);
  }
  async usageSince(tenantId: string, since: Date): Promise<number> {
    const sinceMs = since.getTime();
    return this.records
      .filter(
        (r) =>
          r.tenantId === tenantId && (r.at === undefined || new Date(r.at).getTime() >= sinceMs),
      )
      .reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
  }
  async quotaOf(): Promise<TenantQuota> {
    if (this.failQuota) throw new Error('quota store down');
    return this.quota;
  }
  async setQuota(_tenantId: string, quota: TenantQuota): Promise<void> {
    this.quota = quota;
  }
}

async function makeApp(usage: FakeUsage) {
  const store = new MemorySessionStore();
  const hasher = new FakeHasher();
  const users = new FakeUserStore(hasher, 'password123');
  const app = await buildServer(
    {
      store,
      workspaceRoot: WS_DIR,
      createLoop: () =>
        new CoreAgentLoop({
          llm: new FakeLLM(() => [
            { kind: 'usage', inputTokens: 100, outputTokens: 50 },
            ...textChunks('ok'),
          ]),
          model: 'fake/model',
          tools: new CoreToolRegistry(new FakeSandbox()),
          store,
          workspaceRoot: WS_DIR,
          usage,
        }),
      auth: {
        tokens: new HmacTokenService('test-secret-0123456789abcdef'),
        users,
        metas: new FakeMetaStore(),
        hasher,
      },
      usage,
      quotaAdmin: usage,
    },
    { logger: false },
  );
  return { app, store, users, usage };
}

describe('M5: usage & quota API + loop gate', () => {
  let usage: FakeUsage;
  let app: Awaited<ReturnType<typeof makeApp>>['app'];
  let store: MemorySessionStore;
  let baseUrl: string;
  let token: string;

  const login = async (email: string): Promise<string> => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123' }),
    });
    return ((await res.json()) as { token: string }).token;
  };

  beforeAll(async () => {
    usage = new FakeUsage();
    const bundle = await makeApp(usage);
    app = bundle.app;
    store = bundle.store;
    await bundle.users.createUser({
      tenantId: 't1',
      email: 'admin@example.com',
      passwordHash: 'h:password123',
      role: 'admin',
    });
    await bundle.users.createUser({
      tenantId: 't1',
      email: 'dev@example.com',
      passwordHash: 'h:password123',
      role: 'developer',
    });
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    token = await login('admin@example.com');
  });

  afterAll(async () => {
    rmSync(WS_DIR, { recursive: true, force: true });
    await app.close();
  });

  const authed = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });

  it('GET /api/usage reports per-window usage; a turn records tokens', async () => {
    const before = await (await authed('/api/usage')).json();
    expect(before).toMatchObject({
      windows: {
        hour: { used: 0, limit: null },
        day: { used: 0, limit: null },
        month: { used: 0, limit: null },
      },
      quota: {},
    });

    // Run a turn: the inline loop records its usage (100 in / 50 out).
    const created = await (
      await authed('/api/sessions', { method: 'POST', body: JSON.stringify({}) })
    ).json();
    const sessionId = (created as { sessionId: string }).sessionId;
    const prompt = await authed(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(prompt.status).toBe(202);
    // Inline turn runs detached; wait for the committed turn/end.
    await vi.waitFor(async () => {
      const log = await store.load(sessionId);
      expect(log.at(-1)?.type).toBe('turn/end');
    });
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({ tenantId: 't1', inputTokens: 100, outputTokens: 50 });

    const after = await (await authed('/api/usage')).json();
    expect((after as { windows: { day: { used: number } } }).windows.day.used).toBe(150);
  });

  it('PUT /api/admin/quota sets the tenant quota; the gate then denies turns', async () => {
    // Limit equals what test 1 already consumed (150) — used >= limit denies.
    const put = await authed('/api/admin/quota', {
      method: 'PUT',
      body: JSON.stringify({ dailyTokens: 150 }),
    });
    expect(put.status).toBe(200);

    // 150 already used (previous test) — the next request is denied outright.
    const created = await (
      await authed('/api/sessions', { method: 'POST', body: JSON.stringify({}) })
    ).json();
    const sessionId = (created as { sessionId: string }).sessionId;
    await authed(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: 'again' }),
    });
    await vi.waitFor(async () => {
      const log = await store.load(sessionId);
      const last = log.at(-1);
      expect(
        last?.type === 'turn/end' &&
          last.reason === 'error' &&
          /quota exceeded/.test(last.detail ?? ''),
      ).toBe(true);
    });
    // Denied BEFORE the model call: no new usage recorded for this turn.
    expect(usage.records).toHaveLength(1);
  });

  it('quota administration is admin-only; malformed quotas are rejected', async () => {
    const devToken = await login('dev@example.com');
    const denied = await fetch(`${baseUrl}/api/admin/quota`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${devToken}` },
      body: JSON.stringify({ dailyTokens: 5 }),
    });
    expect(denied.status).toBe(403);
    // The failed attempt must not have changed the quota.
    expect(usage.quota).toEqual({ dailyTokens: 150 });

    const bad = await authed('/api/admin/quota', {
      method: 'PUT',
      body: JSON.stringify({ dailyTokens: -5 }),
    });
    expect(bad.status).toBe(400);
  });
});
