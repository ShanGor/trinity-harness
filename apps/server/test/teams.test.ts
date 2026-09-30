import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  Identity,
  SessionMeta,
  Team,
  TeamRole,
  TeamStore,
  User,
} from '@trinity-harness/contracts';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  HmacTokenService,
  MemorySessionStore,
} from '@trinity-harness/core';
import { FakeLLM, FakeSandbox, textChunks } from '@trinity-harness/core/testing';

import { buildServer } from '../src/index.js';
import { personalFolderSegments, workspaceDirFor } from '../src/workspace.js';

/** In-memory {@link TeamStore} double (apps may import implementations — §3.3). */
class FakeTeamStore implements TeamStore {
  readonly teams = new Map<string, Team>();
  readonly members = new Map<string, { userId: string; role: TeamRole }[]>();
  private userEmail: (userId: string) => string | undefined;

  constructor(userEmail: (userId: string) => string | undefined) {
    this.userEmail = userEmail;
  }

  async create(input: { tenantId: string; name: string; ownerId: string }): Promise<Team> {
    const team: Team = {
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      name: input.name,
      createdAt: new Date().toISOString(),
    };
    this.teams.set(team.id, team);
    this.members.set(team.id, [{ userId: input.ownerId, role: 'owner' }]);
    return team;
  }
  async get(teamId: string): Promise<Team | null> {
    return this.teams.get(teamId) ?? null;
  }
  async listForUser(userId: string): Promise<Team[]> {
    return [...this.teams.values()].filter((t) =>
      (this.members.get(t.id) ?? []).some((m) => m.userId === userId),
    );
  }
  async addMember(teamId: string, userId: string, role: TeamRole): Promise<void> {
    this.members.set(teamId, [...(this.members.get(teamId) ?? []), { userId, role }]);
  }
  async isMember(teamId: string, userId: string): Promise<boolean> {
    return (this.members.get(teamId) ?? []).some((m) => m.userId === userId);
  }
  async listMembers(teamId: string) {
    return (this.members.get(teamId) ?? []).map((m) => ({
      userId: m.userId,
      email: this.userEmail(m.userId) ?? m.userId,
      role: m.role,
      createdAt: new Date().toISOString(),
    }));
  }
  async isOwner(teamId: string, userId: string): Promise<boolean> {
    return (this.members.get(teamId) ?? []).some((m) => m.userId === userId && m.role === 'owner');
  }
}

class FakeMetaStore {
  readonly metas = new Map<string, SessionMeta>();
  async create(meta: Omit<SessionMeta, 'createdAt'>): Promise<void> {
    this.metas.set(meta.id, { ...meta, createdAt: new Date().toISOString() });
  }
  async get(sessionId: string): Promise<SessionMeta | null> {
    return this.metas.get(sessionId) ?? null;
  }
  async listForIdentity(identity: Identity): Promise<SessionMeta[]> {
    // Mirrors the PG store: own sessions + team sessions of my teams.
    const myTeams = new Set(
      [...this.teamStore.members.entries()]
        .filter((entry) => entry[1].some((m) => m.userId === identity.userId))
        .map(([teamId]) => teamId),
    );
    return [...this.metas.values()].filter(
      (m) =>
        !m.closedAt &&
        m.tenantId === identity.tenantId &&
        (identity.role === 'admin' ||
          m.userId === identity.userId ||
          (m.scope === 'team' && m.scopeId !== undefined && myTeams.has(m.scopeId))),
    );
  }
  async setPolicy(): Promise<void> {}
  async setTitleIfEmpty(sessionId: string, title: string): Promise<void> {
    const meta = this.metas.get(sessionId);
    if (meta && !meta.title) this.metas.set(sessionId, { ...meta, title });
  }
  async close(sessionId: string): Promise<void> {
    const meta = this.metas.get(sessionId);
    if (meta) this.metas.set(sessionId, { ...meta, closedAt: new Date().toISOString() });
  }
  constructor(private readonly teamStore: FakeTeamStore) {}
}

/** Same users/metas/teams plumbing as the real server, fully in-memory. */
async function makeApp() {
  const store = new MemorySessionStore();
  const hasher = {
    hash: async (p: string) => `h:${p}`,
    verify: async (p: string, e: string) => e === `h:${p}`,
  };
  const usersById = new Map<string, User>();
  const users = {
    async findByEmail(email: string) {
      return [...usersById.values()].find((u) => u.email === email) ?? null;
    },
    async findById(id: string) {
      return usersById.get(id) ?? null;
    },
    async verifyCredentials(email: string, password: string) {
      // Test double: every test account uses password 'x'.
      const user = await this.findByEmail(email);
      return user && password === 'x' ? user : null;
    },
    async createUser(input: { tenantId: string; email: string; role: User['role'] }) {
      const user: User = {
        id: crypto.randomUUID(),
        tenantId: input.tenantId,
        email: input.email,
        role: input.role,
        createdAt: new Date().toISOString(),
      };
      usersById.set(user.id, user);
      return user;
    },
    async listByTenant() {
      return [...usersById.values()];
    },
  };
  const teams = new FakeTeamStore((id) => usersById.get(id)?.email);
  const metas = new FakeMetaStore(teams);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'trinity-teams-'));
  const app = await buildServer(
    {
      store,
      workspaceRoot,
      createLoop: (_sessionId, workspaceRoot) =>
        new CoreAgentLoop({
          llm: new FakeLLM(() => textChunks('ok')),
          model: 'fake/model',
          tools: new CoreToolRegistry(new FakeSandbox()),
          store,
          workspaceRoot,
        }),
      auth: { tokens: new HmacTokenService('test-secret-0123456789abcdef'), users, metas, hasher },
      teams,
    },
    { logger: false },
  );
  return { app, users, usersById, teams, metas, workspaceRoot };
}

type AppBundle = Awaited<ReturnType<typeof makeApp>>;

async function login(baseUrl: string, email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'x' }),
  });
  return ((await res.json()) as { token: string }).token;
}

async function authed(baseUrl: string, token: string, path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
}

describe('workspaceDirFor (pure)', () => {
  it('resolves personal and team dirs under the root', () => {
    expect(workspaceDirFor('/ws', 'personal', 'u1')).toBe(path.resolve('/ws/u1'));
    expect(workspaceDirFor('/ws', 'team', 't1')).toBe(path.resolve('/ws/t1'));
  });
  it('rejects traversal (fail-closed)', () => {
    expect(() => workspaceDirFor('/ws', 'personal', '../evil')).toThrow();
    expect(() => workspaceDirFor('/ws', 'team', '..')).toThrow();
  });
});

describe('personalFolderSegments (pure)', () => {
  it('accepts the root and nested relative folders', () => {
    expect(personalFolderSegments('')).toEqual([]);
    expect(personalFolderSegments('projects/api')).toEqual(['projects', 'api']);
  });
  it.each(['/tmp', '../bob', 'a/../bob', 'a//b', 'a\\b', 'a/./b'])('rejects %s', (folder) => {
    expect(() => personalFolderSegments(folder)).toThrow();
  });
});

describe('teams & per-session workspaces', () => {
  let bundle: AppBundle;
  let baseUrl: string;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    bundle = await makeApp();
    const address = await bundle.app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
    alice = (
      await bundle.users.createUser({ tenantId: 't1', email: 'alice@x.com', role: 'developer' })
    ).id;
    bob = (await bundle.users.createUser({ tenantId: 't1', email: 'bob@x.com', role: 'developer' }))
      .id;
  });

  afterAll(async () => {
    await bundle.app.close();
    await rm(bundle.workspaceRoot, { recursive: true, force: true });
  });

  it('creates a team (creator = owner), lists it, adds members by email', async () => {
    const aliceToken = await login(baseUrl, 'alice@x.com');
    const created = await authed(baseUrl, aliceToken, '/api/teams', {
      method: 'POST',
      body: JSON.stringify({ name: 'platform' }),
    });
    expect(created.status).toBe(201);
    const { team } = (await created.json()) as { team: Team };
    expect(team.tenantId).toBe('t1');

    const listed = await authed(baseUrl, aliceToken, '/api/teams');
    const { teams } = (await listed.json()) as {
      teams: { teamId: string; name: string; members: { email: string; role: string }[] }[];
    };
    expect(teams).toHaveLength(1);
    expect(teams[0]?.members).toHaveLength(1);
    expect(teams[0]?.members[0]).toMatchObject({ email: 'alice@x.com', role: 'owner' });

    const added = await authed(baseUrl, aliceToken, `/api/teams/${team.id}/members`, {
      method: 'POST',
      body: JSON.stringify({ email: 'bob@x.com' }),
    });
    expect(added.status).toBe(201);
    expect(await bundle.teams.isMember(team.id, bob)).toBe(true);
  });

  it('personal sessions default to $WORKSPACE_ROOT/<user_id>', async () => {
    const aliceToken = await login(baseUrl, 'alice@x.com');
    const res = await authed(baseUrl, aliceToken, '/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'mine' }),
    });
    expect(res.status).toBe(201);
    const { sessionId } = (await res.json()) as { sessionId: string };
    const meta = await bundle.metas.get(sessionId);
    expect(meta?.scope).toBe('personal');
    expect(meta?.workspaceUri).toBe(path.join(bundle.workspaceRoot, alice));
  });

  it('lets a user browse and select their root or an existing nested folder', async () => {
    const aliceToken = await login(baseUrl, 'alice@x.com');
    await mkdir(path.join(bundle.workspaceRoot, alice, 'projects', 'api'), { recursive: true });
    const rootSession = await authed(baseUrl, aliceToken, '/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ workspace: { scope: 'personal', path: '' } }),
    });
    expect(rootSession.status).toBe(201);
    const { sessionId: rootSessionId } = (await rootSession.json()) as { sessionId: string };
    expect((await bundle.metas.get(rootSessionId))?.workspaceUri).toBe(
      path.join(bundle.workspaceRoot, alice),
    );
    const root = await authed(baseUrl, aliceToken, '/api/workspaces/personal');
    expect(root.status).toBe(200);
    expect((await root.json()) as { folders: string[] }).toEqual({ folders: ['projects'] });
    const nested = await authed(baseUrl, aliceToken, '/api/workspaces/personal?path=projects');
    expect((await nested.json()) as { folders: string[] }).toEqual({ folders: ['api'] });
    const created = await authed(baseUrl, aliceToken, '/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ workspace: { scope: 'personal', path: 'projects/api' } }),
    });
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };
    expect((await bundle.metas.get(sessionId))?.workspaceUri).toBe(
      path.join(bundle.workspaceRoot, alice, 'projects', 'api'),
    );
  });

  it('rejects missing, escaped, and symlinked personal folders', async () => {
    const aliceToken = await login(baseUrl, 'alice@x.com');
    const bobToken = await login(baseUrl, 'bob@x.com');
    await mkdir(path.join(bundle.workspaceRoot, bob), { recursive: true });
    await symlink(
      path.join(bundle.workspaceRoot, bob),
      path.join(bundle.workspaceRoot, alice, 'other-user'),
    );
    for (const folder of ['missing', '../' + bob, 'other-user']) {
      const res = await authed(baseUrl, aliceToken, '/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ workspace: { scope: 'personal', path: folder } }),
      });
      expect(res.status).toBe(400);
    }
    const hidden = await authed(baseUrl, aliceToken, '/api/workspaces/personal?path=other-user');
    expect(hidden.status).toBe(400);
    const bobList = await authed(baseUrl, bobToken, '/api/workspaces/personal');
    expect((await bobList.json()) as { folders: string[] }).toEqual({ folders: [] });
  });

  it('team sessions: member gets the team dir; non-member is denied (fail-closed)', async () => {
    const team = await bundle.teams.create({ tenantId: 't1', name: 'secret', ownerId: alice });
    const carol = await bundle.users.createUser({
      tenantId: 't1',
      email: 'carol@x.com',
      role: 'developer',
    });
    void carol;

    const aliceToken = await login(baseUrl, 'alice@x.com');
    const ok = await authed(baseUrl, aliceToken, '/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ workspace: { scope: 'team', teamId: team.id } }),
    });
    expect(ok.status).toBe(201);
    const { sessionId } = (await ok.json()) as { sessionId: string };
    const meta = await bundle.metas.get(sessionId);
    expect(meta?.scope).toBe('team');
    expect(meta?.scopeId).toBe(team.id);
    expect(meta?.workspaceUri).toBe(path.join(bundle.workspaceRoot, team.id));

    // Non-member (and cross-tenant / unknown teams) ⇒ denied, no oracle.
    const carolToken = await login(baseUrl, 'carol@x.com');
    const denied = await authed(baseUrl, carolToken, '/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ workspace: { scope: 'team', teamId: team.id } }),
    });
    expect(denied.status).toBe(403);
    const ghost = await authed(baseUrl, carolToken, '/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ workspace: { scope: 'team', teamId: crypto.randomUUID() } }),
    });
    expect(ghost.status).toBe(403);
  });

  it('member administration: only the owner (or admin) may add members', async () => {
    const team = await bundle.teams.create({ tenantId: 't1', name: 'guard', ownerId: alice });
    await bundle.teams.addMember(team.id, bob, 'member');
    const bobToken = await login(baseUrl, 'bob@x.com');
    const res = await authed(baseUrl, bobToken, `/api/teams/${team.id}/members`, {
      method: 'POST',
      body: JSON.stringify({ email: 'alice@x.com' }),
    });
    expect(res.status).toBe(403);
    // Unknown tenant user ⇒ 404, no oracle.
    const aliceToken = await login(baseUrl, 'alice@x.com');
    const missing = await authed(baseUrl, aliceToken, `/api/teams/${team.id}/members`, {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody@x.com' }),
    });
    expect(missing.status).toBe(404);
  });

  it('session list shows own sessions plus team sessions of my teams', async () => {
    const team = await bundle.teams.create({ tenantId: 't1', name: 'shared', ownerId: alice });
    await bundle.teams.addMember(team.id, bob, 'member');
    const aliceToken = await login(baseUrl, 'alice@x.com');
    const created = await authed(baseUrl, aliceToken, '/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'team-session',
        workspace: { scope: 'team', teamId: team.id },
      }),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };

    const bobToken = await login(baseUrl, 'bob@x.com');
    const bobList = (await (await authed(baseUrl, bobToken, '/api/sessions')).json()) as {
      sessions: { title: string; scope: string; scopeId?: string }[];
    };
    expect(bobList.sessions.some((s) => s.title === 'team-session' && s.scope === 'team')).toBe(
      true,
    );
    expect((await authed(baseUrl, bobToken, `/api/sessions/${sessionId}/export`)).status).toBe(200);
    expect(
      (
        await authed(baseUrl, bobToken, `/api/sessions/${sessionId}`, {
          method: 'DELETE',
          body: '{}',
        })
      ).status,
    ).toBe(403);
  });
});
