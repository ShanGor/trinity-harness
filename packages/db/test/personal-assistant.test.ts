import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { Identity, MemoryCommand } from '@trinity-harness/contracts';
import {
  createDb,
  PgMemoryStore,
  PgSessionMetaStore,
  PgSessionStore,
  PgConversationIndex,
} from '../src/index.js';

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
const other: Identity = { ...owner, userId: randomUUID() };
function command(): MemoryCommand {
  return {
    operationId: randomUUID(),
    memoryId: randomUUID(),
    expectedRevision: 0,
    operation: 'save',
    subject: 'Me',
    predicate: 'Language',
    value: 'English',
  };
}

afterAll(async () => {
  await pool.end();
});
describe.skipIf(!reachable)('durable personal assistant', () => {
  const memory = new PgMemoryStore(db, clock);
  const metas = new PgSessionMetaStore(db);
  const events = new PgSessionStore(db);
  const history = new PgConversationIndex(db);
  let sessionId: string;
  beforeAll(async () => {
    sessionId = randomUUID();
    await metas.create({
      id: sessionId,
      tenantId: owner.tenantId,
      userId: owner.userId,
      title: 'Main chat',
      kind: 'chat',
      sessionRole: 'main',
      workspaceUri: null,
      creationOperationId: randomUUID(),
    });
    await events.append(sessionId, [
      {
        eventId: randomUUID(),
        at: clock().toISOString(),
        type: 'session/created',
        kind: 'chat',
        sessionRole: 'main',
        workspaceUri: null,
      },
    ]);
  });
  it('serializes concurrent corrections, deduplicates retries and retains a forget fence', async () => {
    const save = command();
    expect((await memory.change(owner, save)).revision).toBe(1);
    expect((await memory.change(owner, save)).revision).toBe(1);
    const updates = await Promise.allSettled(
      ['Chinese', 'French'].map((value) =>
        memory.change(owner, { ...save, operationId: randomUUID(), expectedRevision: 1, value }),
      ),
    );
    expect(updates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const current = (await memory.snapshot(owner)).items.find(
      (item) => item.memoryId === save.memoryId,
    )!;
    expect(current.revision).toBe(2);
    await memory.change(owner, {
      ...save,
      operationId: randomUUID(),
      operation: 'forget',
      expectedRevision: 2,
    });
    await expect(
      memory.change(owner, { ...save, operationId: randomUUID(), expectedRevision: 3 }),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' });
    expect(await memory.snapshot(owner)).toMatchObject({
      revision: 3,
      hasSuppression: true,
      items: [{ status: 'forgotten', revision: 3 }],
    });
    expect((await memory.snapshot(other)).items).toEqual([]);
    await expect(
      pool.query('UPDATE memory_events SET payload = payload WHERE tenant_id=$1 AND user_id=$2', [
        owner.tenantId,
        owner.userId,
      ]),
    ).rejects.toThrow('append-only');
  });
  it('enforces unique Main chat and immutable kind/workspace at the database boundary', async () => {
    await expect(
      metas.create({
        id: randomUUID(),
        tenantId: owner.tenantId,
        userId: owner.userId,
        title: 'Duplicate',
        kind: 'chat',
        sessionRole: 'main',
        workspaceUri: null,
      }),
    ).rejects.toThrow();
    await expect(
      pool.query(
        "UPDATE sessions SET kind='work', session_role='task', workspace_uri='/workspace' WHERE id=$1",
        [sessionId],
      ),
    ).rejects.toThrow('immutable');
    expect((await metas.getMain(owner.tenantId, owner.userId))?.id).toBe(sessionId);
  });
  it('indexes source turns transactionally, pages history and preserves manual exclusions', async () => {
    for (const request of ['Redesign Trinity UI', 'Unrelated: Kyoto plans']) {
      const promptId = randomUUID();
      const at = clock().toISOString();
      await events.append(sessionId, [
        {
          eventId: promptId,
          at,
          type: 'message/user',
          surfaceOp: 'append',
          content: [{ kind: 'text', text: request }],
        },
        {
          eventId: randomUUID(),
          at,
          type: 'message/assistant',
          phase: 'final',
          surfaceOp: 'append',
          content: [{ kind: 'text', text: `Recorded outcome: ${request}` }],
        },
        { eventId: randomUUID(), at, type: 'turn/end', reason: 'completed', promptId },
      ]);
    }
    const first = await history.history(owner, { timezone: 'Asia/Hong_Kong', limit: 1 });
    expect(first.episodes).toHaveLength(1);
    expect(first.nextBefore).not.toBeNull();
    const episode = first.episodes[0]!;
    await history.revise(owner, episode.episodeId, { excluded: true });
    await history.revise(owner, episode.episodeId, { topic: 'Travel planning' });
    expect((await history.history(owner, { timezone: 'UTC', limit: 1 })).episodes[0]).toMatchObject(
      { topic: 'Travel planning', excluded: true },
    );
    const second = await history.history(owner, {
      timezone: 'UTC',
      limit: 1,
      before: first.nextBefore!,
    });
    expect(second.episodes[0]?.topic).toBe('Redesign Trinity UI');
    expect((await history.history(other, { timezone: 'UTC', limit: 20 })).episodes).toEqual([]);
    const page = await events.loadPage(sessionId, { limit: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.nextBefore).not.toBeNull();
  });
  it('atomically binds a legacy Chat once, preserves creation history and rejects rebinding', async () => {
    const original = (await events.load(sessionId))[0];
    await expect(
      pool.query('UPDATE sessions SET workspace_uri=$1 WHERE id=$2', ['/unrecorded', sessionId]),
    ).rejects.toThrow('immutable');
    const results = await Promise.all([
      metas.bindChatWorkspace(sessionId, '/sessions/test'),
      metas.bindChatWorkspace(sessionId, '/sessions/test'),
    ]);
    expect(results.map((result) => result.workspaceUri)).toEqual([
      '/sessions/test',
      '/sessions/test',
    ]);
    // Reconstruct adapters after the commit, as on worker replacement/replay.
    expect((await new PgSessionMetaStore(db).get(sessionId))?.workspaceUri).toBe('/sessions/test');
    const replay = await new PgSessionStore(db).load(sessionId);
    expect(replay[0]).toEqual(original);
    expect(replay.filter((event) => event.type === 'session/workspace_bound')).toHaveLength(1);
    await expect(metas.bindChatWorkspace(sessionId, '/different')).rejects.toThrow('immutable');
    await expect(
      pool.query('UPDATE sessions SET workspace_uri=$1 WHERE id=$2', ['/different', sessionId]),
    ).rejects.toThrow('immutable');
  });

  it('excludes removed message sources from indexed history and exact cross-session recall', async () => {
    const promptId = randomUUID();
    const at = clock().toISOString();
    await events.append(sessionId, [
      {
        type: 'message/user',
        eventId: promptId,
        at,
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'A removable indexed exchange' }],
      },
      {
        type: 'message/assistant',
        eventId: randomUUID(),
        at,
        surfaceOp: 'append',
        phase: 'final',
        content: [{ kind: 'text', text: 'An indexed answer' }],
      },
      { type: 'turn/end', eventId: randomUUID(), at, reason: 'completed', promptId },
    ]);
    expect(await history.evidence(owner, promptId)).not.toBeNull();
    await events.append(sessionId, [
      { type: 'message/removed', eventId: randomUUID(), at, promptId, role: 'assistant' },
    ]);
    expect(await history.evidence(owner, promptId)).toBeNull();
    const page = await history.history(owner, { timezone: 'UTC', limit: 50 });
    expect(page.episodes.some((episode) => episode.promptId === promptId)).toBe(false);
  });
  it('searches request, outcome and revised topic text with scoped lexical recall', async () => {
    const promptId = randomUUID();
    const at = clock().toISOString();
    await events.append(sessionId, [
      {
        eventId: promptId,
        at,
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'System one model是什么？' }],
      },
      {
        eventId: randomUUID(),
        at,
        type: 'message/assistant',
        phase: 'final',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'Compare latency and stability.' }],
      },
      { eventId: randomUUID(), at, type: 'turn/end', reason: 'completed', promptId },
    ]);
    const search = (query: string) => history.history(owner, { timezone: 'UTC', limit: 20, query });
    const byRequest = await search('model是什么');
    expect(byRequest.episodes).toHaveLength(1);
    const episode = byRequest.episodes[0]!;
    expect((await search('latency')).episodes).toEqual([episode]);
    expect((await search('missing System')).episodes).toEqual([episode]);
    await history.revise(owner, episode.episodeId, { topic: 'Inference tuning' });
    expect((await search('tuning')).episodes).toMatchObject([
      { episodeId: episode.episodeId, topic: 'Inference tuning' },
    ]);
    expect((await search('nomatches')).episodes).toEqual([]);
    for (const identity of [other, { ...owner, tenantId: randomUUID() }]) {
      expect(
        (await history.history(identity, { timezone: 'UTC', limit: 20, query: 'latency' }))
          .episodes,
      ).toEqual([]);
    }
  });
});

describe.skipIf(!reachable)('session execution lock', () => {
  it('holds a PostgreSQL lock across the callback and releases it afterwards', async () => {
    const { PgSessionRuns } = await import('../src/session-runs.js');
    const runs = new PgSessionRuns(pool);
    const id = randomUUID();
    const probe = await pool.connect();
    try {
      await runs.run(id, async () => {
        const result = await probe.query<{ locked: boolean }>(
          'select pg_try_advisory_lock(hashtextextended($1, 42)) as locked',
          [id],
        );
        if (result.rows[0]!.locked)
          await probe.query('select pg_advisory_unlock(hashtextextended($1, 42))', [id]);
        expect(result.rows[0]!.locked).toBe(false);
      });
      const released = await probe.query<{ locked: boolean }>(
        'select pg_try_advisory_lock(hashtextextended($1, 42)) as locked',
        [id],
      );
      expect(released.rows[0]!.locked).toBe(true);
      await probe.query('select pg_advisory_unlock(hashtextextended($1, 42))', [id]);
      const controller = new AbortController();
      controller.abort();
      await expect(
        runs.run(
          id,
          async () => {
            throw new Error('Must not execute');
          },
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      probe.release();
    }
  });
});
