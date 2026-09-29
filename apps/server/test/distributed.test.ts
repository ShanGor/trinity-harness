import 'dotenv/config';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EventSink } from '@trinity-harness/contracts';
import { CoreAgentLoop, CoreToolRegistry, writeFileTool } from '@trinity-harness/core';
import {
  FakeLLM,
  FakeSandbox,
  textChunks,
  toolCallThenFinish,
} from '@trinity-harness/core/testing';
import type { ServerEvent } from '@trinity-harness/shared';
import { createDb, createPool, PgSessionStore } from '@trinity-harness/db';
import { loadEnv } from '@trinity-harness/shared';
import {
  BusAuditEmitter,
  createRedis,
  createTurnWorker,
  isRedisReachable,
  PublishingSessionStore,
  RedisEventBus,
  RedisLiveEventPublisher,
  RedisLiveEventSubscriber,
  RedisSessionEventPublisher,
  RedisSessionEventReader,
  RedisTurnQueue,
  sessionStreamKey,
} from '@trinity-harness/redis';

import { buildServer } from '../src/index.js';

/**
 * M2 distributed end-to-end (integration): Fastify server (enqueue-only) +
 * BullMQ turn worker (fake LLM) + PG event log + Redis Stream/PubSub relay.
 * Skipped unless both PostgreSQL and Redis are reachable.
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

describe.skipIf(!hasInfra)('M2 distributed topology (integration)', () => {
  let pool: pg.Pool;
  let redis: ReturnType<typeof createRedis>;
  let pgStore: PgSessionStore;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let baseUrl: string;
  let worker: { close(): Promise<void> };
  let queue: RedisTurnQueue;
  const sessionIds: string[] = [];
  const auditProbe: { actions: string[]; dispose(): void } = { actions: [], dispose: () => {} };
  // M5: the enqueued TurnTask must carry tenant attribution for usage/quota.
  const tenantProbe: string[] = [];

  beforeAll(async () => {
    const env = loadEnv(process.env, { requireDatabaseUrl: true });
    pool = createPool(env.DATABASE_URL);
    const db = createDb(pool);
    redis = createRedis(redisUrl);

    pgStore = new PgSessionStore(db);
    const store = new PublishingSessionStore(pgStore, new RedisSessionEventPublisher(redis));
    queue = new RedisTurnQueue({ url: redisUrl });
    const live = new RedisLiveEventPublisher(redis);
    const audit = new BusAuditEmitter(new RedisEventBus(redis, { blockMs: 500 }));

    app = await buildServer({
      store,
      workspaceRoot: '/ws',
      queue,
      eventReader: new RedisSessionEventReader(redis, { blockMs: 500 }),
      liveEvents: new RedisLiveEventSubscriber(redis),
    });

    // In-process worker consuming the same queue the server enqueues to.
    const sandbox = new FakeSandbox();
    worker = createTurnWorker({ url: redisUrl }, async (task) => {
      tenantProbe.push(task.tenantId);
      const tools = new CoreToolRegistry(sandbox);
      tools.register(writeFileTool);
      const llm = new FakeLLM(
        () => toolCallThenFinish('c1', 'write_file', { path: 'hi.txt', content: 'hello' }),
        () => textChunks('File written.'),
      );
      const sink: EventSink = {
        emit: (loopEvent) => {
          live.publish(task.sessionId, loopEvent);
          if (loopEvent.type === 'tool/call') {
            audit.emit({
              id: crypto.randomUUID(),
              at: new Date().toISOString(),
              tenantId: '00000000-0000-0000-0000-000000000000',
              userId: task.actor,
              sessionId: task.sessionId,
              action: 'tool/call',
              target: loopEvent.call.name,
              result: 'ok',
            });
          }
        },
      };
      await new CoreAgentLoop({
        llm,
        model: 'fake/model',
        tools,
        store,
        workspaceRoot: '/ws',
      }).run(task.sessionId, task.prompt, sink, { actor: task.actor });
    });

    // Independent consumer group on the audit stream (same mechanism the
    // audit-consumer Deployment uses).
    const probe = new RedisEventBus(redis, { blockMs: 500 });
    const actions: string[] = [];
    const handle = probe.subscribe(
      'audit',
      `probe-${crypto.randomUUID().slice(0, 8)}`,
      async (e) => {
        if (e.type === 'audit/record') {
          actions.push(String((e.payload as { action?: string }).action));
        }
      },
    );
    auditProbe.actions = actions;
    auditProbe.dispose = () => handle.dispose();

    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  }, 30000);

  afterAll(async () => {
    auditProbe.dispose();
    await app.close();
    await worker.close();
    await queue.close();
    for (const id of sessionIds) {
      await redis.del(sessionStreamKey(id));
    }
    redis.disconnect();
    await pool.end();
  }, 30000);

  it('POST enqueues → worker runs → SSE relays seq-id events + live deltas → resume replays', async () => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'dist' }),
    });
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };
    sessionIds.push(sessionId);

    const stream = await fetch(`${baseUrl}/api/sessions/${sessionId}/events`);
    expect(stream.status).toBe(200);
    const sse = new SseReader(stream.body!.getReader());

    const post = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'write a file' }),
    });
    expect(post.status).toBe(202);

    // Collect until the committed ASSISTANT message arrives (the user message
    // also lands as message/committed via the stream).
    const seen: { id?: number; event: ServerEvent }[] = [];
    const kinds = new Set<string>();
    for (;;) {
      const item = await sse.next();
      seen.push(item);
      const e = item.event;
      if (e.type === 'session/update') {
        kinds.add(
          `update:${e.update.kind}:${e.update.kind === 'tool_call' ? e.update.status : ''}`,
        );
      } else if (e.type === 'message/committed') {
        kinds.add(`committed:${e.message.role}`);
        if (e.message.role === 'assistant') break;
      }
    }

    // Tool lifecycle came through the durable stream; deltas via Pub/Sub.
    expect(kinds.has('update:tool_call:in_progress')).toBe(true);
    expect(kinds.has('update:tool_call:completed')).toBe(true);
    expect(kinds.has('committed:user')).toBe(true);
    expect(kinds.has('committed:assistant')).toBe(true);
    sse.cancel();

    // Every log-derived event carries a strictly increasing seq id.
    const seqs = seen.filter((s) => s.id !== undefined).map((s) => s.id!);
    expect(seqs.length).toBeGreaterThan(0);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }

    // Tool invocation reached the audit stream.
    await expect
      .poll(() => auditProbe.actions.filter((a) => a === 'tool/call').length, { timeout: 5000 })
      .toBeGreaterThanOrEqual(1);

    // M5: tenant attribution traveled with the task (no-auth server ⇒ NIL).
    expect(tenantProbe.length).toBeGreaterThanOrEqual(1);
    expect(tenantProbe[0]).toBe('00000000-0000-0000-0000-000000000000');

    // Resume: reconnect with Last-Event-ID right after the first log event;
    // PG gap-fill + stream replay must deliver the tail again, in order.
    const resumeAfter = seqs[0]!;
    const resumed = await fetch(`${baseUrl}/api/sessions/${sessionId}/events`, {
      headers: { 'last-event-id': String(resumeAfter) },
    });
    const sse2 = new SseReader(resumed.body!.getReader());
    const replay: ServerEvent[] = [];
    let maxId = -1;
    for (let i = 0; i < 32; i++) {
      const item = await sse2.next();
      if (item.id !== undefined) {
        expect(item.id).toBeGreaterThan(resumeAfter);
        maxId = Math.max(maxId, item.id);
      }
      replay.push(item.event);
      if (item.event.type === 'message/committed' && item.event.message.role === 'assistant') {
        break;
      }
    }
    sse2.cancel();
    expect(maxId).toBeGreaterThan(resumeAfter);
    const committed = replay.find(
      (e) => e.type === 'message/committed' && e.message.role === 'assistant',
    );
    expect(committed).toMatchObject({ message: { content: 'File written.' } });

    // The durable truth in PG: full turn, with the actor recorded on events.
    const rows = await pgStore.loadRange(sessionId, { afterSeq: 0 });
    const types = rows.map((r) => r.event.type);
    expect(types).toContain('message/user');
    expect(types.filter((t) => t === 'tool/result')).toHaveLength(1);
    expect(types[types.length - 1]).toBe('turn/end');
    const userMsg = rows.find((r) => r.event.type === 'message/user')!.event;
    expect(userMsg.type === 'message/user' && userMsg.content[0]).toMatchObject({
      kind: 'text',
      text: 'write a file',
    });
  });
});
