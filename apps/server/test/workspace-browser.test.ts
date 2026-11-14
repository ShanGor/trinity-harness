import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type {
  Identity,
  SessionMeta,
  SessionMetaStore,
  UserStore,
} from '@trinity-harness/contracts';
import { LocalSandbox, MemorySessionStore } from '@trinity-harness/core';
import { buildServer } from '../src/index.js';

it('browses the authorized session root, bounds previews, and rejects escapes and private context', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'trinity-workspace-view-'));
  const owner: Identity = { userId: randomUUID(), tenantId: randomUUID(), role: 'developer' };
  let identity = owner;
  const meta: SessionMeta = {
    id: randomUUID(),
    userId: owner.userId,
    tenantId: owner.tenantId,
    title: 'Workspace',
    workspaceUri: root,
    scope: 'personal',
    createdAt: new Date().toISOString(),
  };
  const metas: SessionMetaStore = {
    get: async (id) => (id === meta.id ? meta : null),
    create: vi.fn(),
    listForIdentity: async () => [meta],
    setTitleIfEmpty: vi.fn(),
    close: vi.fn(),
    setPolicy: vi.fn(),
  };
  const sandbox = new LocalSandbox(root);
  const factory = vi.fn(() => sandbox);
  const app = await buildServer({
    store: new MemorySessionStore(),
    workspaceRoot: '/wrong-root',
    workspaceSandbox: factory,
    auth: {
      metas,
      users: {} as UserStore,
      tokens: { verify: async () => identity, issue: async () => 'token' },
      hasher: { hash: async () => '', verify: async () => false },
    },
  });
  const read = async (kind: 'directory' | 'file', entry = '') =>
    app.inject({
      method: 'GET',
      url: `/api/sessions/${meta.id}/workspace/${kind}?${new URLSearchParams({ path: entry })}`,
      headers: { authorization: 'Bearer token' },
    });
  try {
    await mkdir(path.join(root, 'notes'));
    await mkdir(path.join(root, 'model-context'));
    await writeFile(path.join(root, 'notes', 'hello.txt'), 'hello');
    await writeFile(path.join(root, '.hidden'), 'hidden');
    await writeFile(path.join(root, 'large.txt'), 'a'.repeat(70_000));
    await symlink(tmpdir(), path.join(root, 'outside'));
    const listing = await read('directory');
    expect(listing.statusCode).toBe(200);
    expect(listing.headers['cache-control']).toBe('private, no-store');
    expect(listing.json().entries).toEqual([
      { name: 'notes', kind: 'directory' },
      { name: '.hidden', kind: 'file' },
      { name: 'large.txt', kind: 'file' },
      { name: 'outside', kind: 'other' },
    ]);
    expect(factory).toHaveBeenCalledWith(meta.id, root);
    expect((await read('file', 'notes/hello.txt')).json().content).toBe('hello');
    const large = (await read('file', 'large.txt')).json();
    expect(large.truncated).toBe(true);
    expect(Buffer.byteLength(large.content)).toBeLessThanOrEqual(65536);
    for (const invalid of [
      '../secret',
      '/etc/passwd',
      'notes/../../secret',
      'notes\\secret',
      'model-context/request.json',
    ]) {
      expect((await read('file', invalid)).statusCode).toBe(400);
    }
    expect((await read('directory', 'outside')).statusCode).toBe(503);
    expect((await read('file', 'outside/missing')).statusCode).toBe(503);
    const doc = async (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/api/sessions/${meta.id}/workspace/document`,
        headers: { authorization: 'Bearer token' },
        payload,
      });
    const document = await doc({ operation: 'read', path: 'notes/hello.txt' });
    expect(document.statusCode).toBe(200);
    const version = document.json().version;
    expect(
      (
        await doc({
          operation: 'save',
          path: 'notes/hello.txt',
          expectedVersion: version,
          content: 'updated',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await doc({
          operation: 'save',
          path: 'notes/hello.txt',
          expectedVersion: version,
          content: 'stale',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await doc({ operation: 'history', path: 'notes/hello.txt' })).json().revisions,
    ).toHaveLength(2);
    expect((await doc({ operation: 'read', path: 'model-context/request.json' })).statusCode).toBe(
      400,
    );
    identity = { ...owner, userId: randomUUID() };
    expect(
      (
        await doc({
          operation: 'save',
          path: 'notes/hello.txt',
          expectedVersion: version,
          content: 'unauthorized',
        })
      ).statusCode,
    ).toBe(404);
    expect(await readFile(path.join(root, 'notes/hello.txt'), 'utf8')).toBe('updated');
    identity = owner;
    identity = { ...owner, userId: randomUUID() };
    expect((await read('directory')).statusCode).toBe(404);
    identity = { ...owner, tenantId: randomUUID() };
    expect((await read('file', '.hidden')).statusCode).toBe(404);
    identity = owner;
    const list = vi.spyOn(sandbox, 'listDirectory').mockImplementation(async () => {
      meta.closedAt = new Date().toISOString();
      return { entries: [], truncated: false };
    });
    expect((await read('directory')).statusCode).toBe(404);
    expect(list).toHaveBeenCalledOnce();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('fails closed without a configured workspace adapter', async () => {
  const app = await buildServer({ store: new MemorySessionStore(), workspaceRoot: '/workspace' });
  try {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/sessions/${randomUUID()}/workspace/directory`,
        })
      ).statusCode,
    ).toBe(501);
  } finally {
    await app.close();
  }
});

it('gives unselected Chat and Work distinct UUIDv7 folders and honours explicit choices', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'trinity-workspace-choice-'));
  const owner: Identity = { userId: randomUUID(), tenantId: randomUUID(), role: 'developer' };
  const records = new Map<string, SessionMeta>();
  const metas: SessionMetaStore = {
    get: async (id) => records.get(id) ?? null,
    create: async (meta) => {
      records.set(meta.id, { ...meta, createdAt: new Date().toISOString() });
    },
    listForIdentity: async () => [...records.values()],
    setTitleIfEmpty: vi.fn(),
    close: vi.fn(),
    setPolicy: vi.fn(),
  };
  const app = await buildServer({
    store: new MemorySessionStore(),
    workspaceRoot: root,
    workspaceSandbox: (_id, workspace) => new LocalSandbox(workspace),
    auth: {
      metas,
      users: {} as UserStore,
      tokens: { verify: async () => owner, issue: async () => 'token' },
      hasher: { hash: async () => '', verify: async () => false },
    },
  });
  const headers = { authorization: 'Bearer token' };
  try {
    const ids: string[] = [];
    for (const kind of ['chat', 'work', 'work']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers,
        payload: { kind },
      });
      expect(response.statusCode).toBe(201);
      const id = response.json<{ sessionId: string }>().sessionId;
      ids.push(id);
      expect(id[14]).toBe('7');
      expect(records.get(id)?.workspaceUri).toBe(path.join(root, 'sessions', owner.userId, id));
      const listing = await app.inject({
        method: 'GET',
        url: `/api/sessions/${id}/workspace/directory`,
        headers,
      });
      expect(listing.statusCode).toBe(200);
      expect(listing.json()).toEqual({ entries: [], truncated: false });
    }
    expect(new Set(ids).size).toBe(3);
    await mkdir(path.join(root, owner.userId, 'project'), { recursive: true });
    for (const selected of ['', 'project']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers,
        payload: { kind: 'work', workspace: { scope: 'personal', path: selected } },
      });
      expect(response.statusCode).toBe(201);
      expect(records.get(response.json<{ sessionId: string }>().sessionId)?.workspaceUri).toBe(
        path.join(root, owner.userId, selected),
      );
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
