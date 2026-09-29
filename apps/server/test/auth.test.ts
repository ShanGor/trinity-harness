import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreAgentLoop, CoreToolRegistry, HmacTokenService } from '@trinity-harness/core';
import {
  FakeLLM,
  FakeSandbox,
  textChunks,
  toolCallThenFinish,
} from '@trinity-harness/core/testing';
import type {
  AuditRecord,
  Identity,
  PasswordHasher,
  Role,
  SessionMeta,
  User,
  UserStore,
} from '@trinity-harness/contracts';
import { MemorySessionStore } from '@trinity-harness/core';
import type { SessionMetaStore } from '@trinity-harness/contracts';

import { buildServer } from '../src/index.js';

/** In-memory test doubles (apps may import implementations — AGENTS.md §3.3). */

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
  private readonly passwords = new Map<string, string>();
  constructor(private readonly hasher: FakeHasher) {}

  async findByEmail(email: string): Promise<User | null> {
    return [...this.byId.values()].find((u) => u.email === email) ?? null;
  }
  async findById(userId: string): Promise<User | null> {
    return this.byId.get(userId) ?? null;
  }
  async verifyCredentials(email: string, password: string): Promise<User | null> {
    const user = await this.findByEmail(email);
    if (!user) {
      await this.hasher.verify(password, 'h:unknown');
      return null;
    }
    return this.passwords.get(user.id) === password ? user : null;
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
    this.passwords.set(user.id, input.passwordHash.replace(/^h:/, ''));
    return user;
  }
  async listByTenant(tenantId: string): Promise<User[]> {
    return [...this.byId.values()].filter((u) => u.tenantId === tenantId);
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
    return [...this.metas.values()].filter(
      (m) =>
        m.tenantId === identity.tenantId &&
        (identity.role === 'admin' || m.userId === identity.userId),
    );
  }
  async setPolicy(sessionId: string, policy: string): Promise<void> {
    const meta = this.metas.get(sessionId);
    if (meta) this.metas.set(sessionId, { ...meta, policy });
  }
}

class FakeAudit {
  readonly records: AuditRecord[] = [];
  emit(record: AuditRecord): void {
    this.records.push(record);
  }
}

/** One tenant, fresh fake-LLM scripts per loop; runs fully in-memory. */
async function makeApp() {
  const store = new MemorySessionStore();
  const hasher = new FakeHasher();
  const users = new FakeUserStore(hasher);
  const metas = new FakeMetaStore();
  const audit = new FakeAudit();
  const sandbox = new FakeSandbox();
  const app = await buildServer(
    {
      store,
      workspaceRoot: '/ws',
      createLoop: () =>
        new CoreAgentLoop({
          // Fresh scripts per loop: concurrent turns never share a script queue.
          llm: new FakeLLM(
            () => toolCallThenFinish('c1', 'write_file', { path: 'hi.txt', content: 'hello' }),
            () => textChunks('File written.'),
          ),
          model: 'fake/model',
          tools: new CoreToolRegistry(sandbox),
          store,
          workspaceRoot: '/ws',
        }),
      auth: { tokens: new HmacTokenService('test-secret-0123456789abcdef'), users, metas, hasher },
      audit,
      // Query side is exercised for RBAC here; persistence belongs to PG tests.
      auditQuery: {
        async query() {
          return { records: [], total: 0 };
        },
        async insert() {},
      },
    },
    { logger: false },
  );
  return { app, store, users, metas, audit };
}

type AppBundle = Awaited<ReturnType<typeof makeApp>>;

async function login(
  baseUrl: string,
  email: string,
  password: string,
): Promise<{ status: number; token?: string; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, token: (body['token'] as string | undefined) ?? undefined, body };
}

async function authed(
  baseUrl: string,
  token: string | undefined,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

describe('M2 auth / tenants / RBAC', () => {
  let bundle: AppBundle;
  let baseUrl: string;

  const passwordOf = () => 'password123';

  beforeAll(async () => {
    bundle = await makeApp();
    const address = await bundle.app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
  });

  afterAll(async () => {
    await bundle.app.close();
  });

  it('rejects unauthenticated access everywhere except health/login', async () => {
    for (const path of ['/api/sessions', '/api/me', '/api/admin/users', '/api/audit']) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status, path).toBe(401);
    }
    expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);
  });

  it('admin bootstraps users; roles are enforced (viewer read-only, audit admin-only)', async () => {
    const hasher = new FakeHasher();
    const admin = await bundle.users.createUser({
      tenantId: 't1',
      email: 'admin@example.com',
      passwordHash: await hasher.hash(passwordOf()),
      role: 'admin',
    });
    const loginRes = await login(baseUrl, 'admin@example.com', passwordOf());
    expect(loginRes.status).toBe(200);
    const token = loginRes.token!;
    expect((loginRes.body['user'] as User).role).toBe('admin');

    // Provision developer + viewer.
    for (const [email, role] of [
      ['dev@example.com', 'developer'],
      ['view@example.com', 'viewer'],
    ] as const) {
      const res = await authed(baseUrl, token, '/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email, password: passwordOf(), role }),
      });
      expect(res.status, email).toBe(201);
    }
    // Wrong password → 401, indistinguishable from unknown user.
    expect((await login(baseUrl, 'admin@example.com', 'wrong-password')).status).toBe(401);
    expect((await login(baseUrl, 'ghost@example.com', passwordOf())).status).toBe(401);
    void admin;

    const devLogin = await login(baseUrl, 'dev@example.com', passwordOf());
    const devToken = devLogin.token!;
    // (Viewer login is exercised in the session-isolation test below.)

    // Non-admin cannot provision users nor read audit.
    expect((await authed(baseUrl, devToken, '/api/admin/users', { method: 'GET' })).status).toBe(
      403,
    );
    expect((await authed(baseUrl, devToken, '/api/audit')).status).toBe(403);
    // Admin can.
    expect((await authed(baseUrl, token, '/api/admin/users')).status).toBe(200);
    expect((await authed(baseUrl, token, '/api/audit')).status).toBe(200);
  });

  it('isolates sessions per user and enforces viewer read-only', async () => {
    const hasher = new FakeHasher();
    await bundle.users.createUser({
      tenantId: 't1',
      email: 'dev@example.com',
      passwordHash: await hasher.hash(passwordOf()),
      role: 'developer',
    });
    await bundle.users.createUser({
      tenantId: 't1',
      email: 'dev2@example.com',
      passwordHash: await hasher.hash(passwordOf()),
      role: 'developer',
    });
    await bundle.users.createUser({
      tenantId: 't1',
      email: 'view@example.com',
      passwordHash: await hasher.hash(passwordOf()),
      role: 'viewer',
    });
    const devToken = (await login(baseUrl, 'dev@example.com', passwordOf())).token!;
    const dev2Token = (await login(baseUrl, 'dev2@example.com', passwordOf())).token!;
    const viewerToken = (await login(baseUrl, 'view@example.com', passwordOf())).token!;

    // dev creates a session.
    const created = await authed(baseUrl, devToken, '/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'mine' }),
    });
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };

    // dev2 cannot see dev's session (404 hides existence, fail-closed).
    expect((await authed(baseUrl, dev2Token, `/api/sessions/${sessionId}/messages`)).status).toBe(
      404,
    );
    // The viewer CAN read, but posting to their own session is still denied.
    const viewerSession = await authed(baseUrl, viewerToken, '/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'view-only' }),
    });
    const { sessionId: viewerSessionId } = (await viewerSession.json()) as { sessionId: string };
    expect(
      (await authed(baseUrl, viewerToken, `/api/sessions/${viewerSessionId}/messages`)).status,
    ).toBe(200);
    expect(
      (
        await authed(baseUrl, viewerToken, `/api/sessions/${viewerSessionId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ text: 'hi' }),
        })
      ).status,
    ).toBe(403);
    // dev's own listing contains it; dev2's does not.
    const list1 = (await (await authed(baseUrl, devToken, '/api/sessions')).json()) as {
      sessions: { sessionId: string }[];
    };
    expect(list1.sessions.map((s) => s.sessionId)).toContain(sessionId);
    const list2 = (await (await authed(baseUrl, dev2Token, '/api/sessions')).json()) as {
      sessions: { sessionId: string }[];
    };
    expect(list2.sessions.map((s) => s.sessionId)).not.toContain(sessionId);
  });

  it('multi-user concurrency: simultaneous turns stay isolated and audited', async () => {
    await bundle.users.createUser({
      tenantId: 't1',
      email: 'dev@example.com',
      passwordHash: `h:${passwordOf()}`,
      role: 'developer',
    });
    await bundle.users.createUser({
      tenantId: 't1',
      email: 'dev2@example.com',
      passwordHash: `h:${passwordOf()}`,
      role: 'developer',
    });
    const tokens: Record<string, string> = {};
    for (const email of ['dev@example.com', 'dev2@example.com']) {
      tokens[email] = (await login(baseUrl, email, passwordOf())).token!;
    }

    const runPrompt = async (email: string, title: string, text: string): Promise<string> => {
      const created = await authed(baseUrl, tokens[email], '/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      const { sessionId } = (await created.json()) as { sessionId: string };
      const res = await authed(baseUrl, tokens[email], `/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      expect(res.status).toBe(202);
      return sessionId;
    };

    // Fire both turns concurrently; the inline loops run detached.
    const [s1, s2] = await Promise.all([
      runPrompt('dev@example.com', 'a', 'first prompt'),
      runPrompt('dev2@example.com', 'b', 'second prompt'),
    ]);

    // Wait for both logs to settle (turn/end appended).
    await expect
      .poll(async () => (await bundle.store.load(s1)).length, { timeout: 5000 })
      .toBeGreaterThanOrEqual(6);
    await expect
      .poll(async () => (await bundle.store.load(s2)).length, { timeout: 5000 })
      .toBeGreaterThanOrEqual(6);

    const surface1 = await bundle.store.projectMessages(s1);
    const surface2 = await bundle.store.projectMessages(s2);
    expect(surface1.map((m) => m.content[0])).toEqual([
      { kind: 'text', text: 'first prompt' },
      { kind: 'text', text: 'File written.' },
    ]);
    expect(surface2.map((m) => m.content[0])).toEqual([
      { kind: 'text', text: 'second prompt' },
      { kind: 'text', text: 'File written.' },
    ]);

    // Audit trail recorded logins, session creation and prompts for the tenant.
    const actions = bundle.audit.records.map((r) => r.action);
    expect(actions.filter((a) => a === 'auth/login').length).toBeGreaterThanOrEqual(2);
    expect(actions).toContain('session/created');
    expect(actions).toContain('session/prompt');
    // Successful actions are always tenant-scoped; failed logins carry the nil
    // tenant (unknowable by design, docs/design.md §13).
    expect(
      bundle.audit.records.filter((r) => r.result === 'ok').every((r) => r.tenantId === 't1'),
    ).toBe(true);
  });
});
