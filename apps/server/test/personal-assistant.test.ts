import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createDb, PgMemoryStore, PgSessionMetaStore, PgSessionStore } from '@trinity-harness/db';
import { LocalBlobStore, PersonalContext } from '@trinity-harness/core';
import type { Identity, UserStore } from '@trinity-harness/contracts';
import { buildServer } from '../src/server.js';
const url = process.env['DATABASE_URL'];
const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
let reachable = false;
if (url) {
  try {
    await pool.query('select 1');
    reachable = true;
  } catch {
    reachable = false;
  }
}
const db = createDb(pool);
const clock = () => new Date('2026-10-20T09:00:00.000Z');
const owner: Identity = { tenantId: randomUUID(), userId: randomUUID(), role: 'developer' };
afterAll(async () => {
  await pool.end();
});

describe.skipIf(!reachable)('explicit conversation memory commands', () => {
  it('saves atomic preferences, corrects one, and forgets another across sessions', async () => {
    const memory = new PgMemoryStore(db, clock);
    const profile = { ...owner, userId: randomUUID() };
    const main = {
      id: randomUUID(),
      title: 'Main',
      ...profile,
      workspaceUri: null,
      kind: 'chat' as const,
      sessionRole: 'main' as const,
      createdAt: clock().toISOString(),
    };
    const context = new PersonalContext(memory, {
      history: async () => ({ episodes: [], nextBefore: null }),
      revise: async () => undefined,
    });
    const promptId = randomUUID();
    const saved = await context.select(
      main,
      promptId,
      'Remember: reply in English and keep answers concise.',
    );
    expect(saved.memories.map((item) => item.value).sort()).toEqual(['English', 'concise']);
    await context.select(main, promptId, 'Remember: reply in English and keep answers concise.');
    expect((await memory.snapshot(profile)).revision).toBe(2);
    const changed = await context.select(
      { ...main, id: randomUUID(), sessionRole: 'side' },
      randomUUID(),
      'Remember: reply in Chinese from now on.',
    );
    expect(changed.memories.map((item) => item.value).sort()).toEqual(['Chinese', 'concise']);
    const forgotten = await context.select(
      main,
      randomUUID(),
      'Forget my answer-length preference.',
    );
    expect(forgotten.memories.map((item) => item.value)).toEqual(['Chinese']);
    expect(forgotten.commandResult).toContain('forgotten');
  });
});

describe.skipIf(!reachable)('personal assistant creation API', () => {
  it('reconciles concurrent creation, preserves the selected kind, and requires a Work workspace', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'trinity-personal-'));
    const metas = new PgSessionMetaStore(db);
    const store = new PgSessionStore(db);
    const app = await buildServer({
      workspaceRoot,
      store,
      blobs: new LocalBlobStore(path.join(workspaceRoot, '.blobs')),
      auth: {
        metas,
        tokens: { verify: async () => owner, issue: async () => 'token' },
        hasher: { hash: async () => '', verify: async () => false },
        users: {} as UserStore,
      },
    });
    const headers = { authorization: 'Bearer token' };
    try {
      const operation = randomUUID();
      const create = () =>
        app.inject({
          method: 'POST',
          url: '/api/sessions',
          headers,
          payload: { kind: 'chat', sessionRole: 'main', creationOperationId: operation },
        });
      const replies = await Promise.all([create(), create()]);
      expect(replies.map((reply) => reply.statusCode)).toEqual([201, 201]);
      const id = replies[0]!.json<{ sessionId: string }>().sessionId;
      expect(replies[1]!.json<{ sessionId: string }>().sessionId).toBe(id);
      expect(
        (await store.load(id)).filter((event) => event.type === 'session/created'),
      ).toHaveLength(1);
      expect(await metas.get(id)).toMatchObject({
        kind: 'chat',
        sessionRole: 'main',
        workspaceUri: path.join(workspaceRoot, 'sessions', owner.userId, id),
      });
      const directory = (await metas.get(id))!.workspaceUri!;
      expect((await stat(directory)).isDirectory()).toBe(true);
      expect(id[14]).toBe('7');
      expect((await store.load(id))[0]).toMatchObject({ workspaceUri: directory });
      const upload = await app.inject({
        method: 'POST',
        url: `/api/sessions/${id}/attachments?mime=application/pdf&filename=notes.pdf`,
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        payload: Buffer.from('research notes'),
      });
      expect(upload.statusCode).toBe(201);
      const attachment = upload.json<{ workspacePath: string; uri: string }>();
      expect(await readFile(path.join(directory, attachment.workspacePath), 'utf8')).toBe(
        'research notes',
      );
      expect((await store.load(id)).at(-1)).toMatchObject({
        type: 'session/attachment',
        uri: attachment.uri,
        workspacePath: attachment.workspacePath,
      });
      const side = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers,
        payload: { kind: 'chat' },
      });
      expect(side.statusCode).toBe(201);
      expect(
        (await metas.get(side.json<{ sessionId: string }>().sessionId))!.workspaceUri,
      ).not.toBe(directory);
      const work = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers,
        payload: { kind: 'work', creationOperationId: randomUUID() },
      });
      expect(work.statusCode).toBe(400);
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers,
        payload: { kind: 'chat', workspace: { scope: 'personal' } },
      });
      expect(wrong.statusCode).toBe(400);
      const retry = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers,
        payload: { kind: 'work', workspace: { scope: 'personal' }, creationOperationId: operation },
      });
      expect(retry.statusCode).toBe(201);
      expect(retry.json<{ sessionId: string }>().sessionId).toBe(id);
      expect((await metas.get(id))?.kind).toBe('chat');
    } finally {
      await app.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
