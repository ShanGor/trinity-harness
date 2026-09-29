import 'dotenv/config';

import type { SessionEvent, SeqRange, SessionStore } from '@trinity-harness/contracts';
import { parsePermissionPolicy } from '@trinity-harness/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRedis,
  createTurnWorker,
  isRedisReachable,
  PublishingSessionStore,
  RedisEventBus,
  RedisSessionEventPublisher,
  RedisSessionEventReader,
  RedisTurnQueue,
  sessionStreamKey,
} from '../src/index.js';

const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const reachable = await isRedisReachable(redisUrl);

const at = () => new Date().toISOString();
const userMsg = (text: string): SessionEvent => ({
  type: 'message/user',
  eventId: crypto.randomUUID(),
  at: at(),
  surfaceOp: 'append',
  content: [{ kind: 'text', text }],
});

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(!reachable)('Redis adapters (integration)', () => {
  let redis: ReturnType<typeof createRedis>;

  beforeAll(() => {
    redis = createRedis(redisUrl);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('EventBus fans out to independent consumer groups and resumes pending', async () => {
    const bus = new RedisEventBus(redis, { blockMs: 500 });
    const stream = `test-bus-${crypto.randomUUID()}`;
    const receivedA: string[] = [];
    const receivedB: string[] = [];

    const subA = bus.subscribe(stream, 'group-a', async (e) => {
      receivedA.push(String(e.type));
    });
    const subB = bus.subscribe(stream, 'group-b', async (e) => {
      receivedB.push(String(e.payload));
    });
    await sleep(300); // let both groups register

    await bus.publish(stream, { type: 't1', payload: 'one', occurredAt: at() });
    await bus.publish(stream, { type: 't2', payload: 'two', occurredAt: at() });

    await expect.poll(() => receivedA.length, { timeout: 5000 }).toBe(2);
    await expect.poll(() => receivedB.length, { timeout: 5000 }).toBe(2);
    expect(receivedA).toEqual(['t1', 't2']);
    expect(receivedB).toEqual(['one', 'two']);

    subA.dispose();
    subB.dispose();
  });

  it('session publisher writes seq-aligned ids; reader resumes strictly after afterSeq', async () => {
    const publisher = new RedisSessionEventPublisher(redis);
    const sessionId = crypto.randomUUID();
    const key = sessionStreamKey(sessionId);

    await publisher.publish(sessionId, [
      { seq: 1, event: userMsg('one') },
      { seq: 2, event: userMsg('two') },
      { seq: 3, event: userMsg('three') },
    ]);

    const got: { seq: number; text: string }[] = [];
    const reader = new RedisSessionEventReader(redis, { blockMs: 500 });
    const handle = reader.open(sessionId, 1, ({ seq, event }) => {
      if (event.type === 'message/user') {
        const block = event.content[0];
        got.push({ seq, text: block?.kind === 'text' ? block.text : '?' });
      }
    });
    await handle.started;
    await expect.poll(() => got.length, { timeout: 5000 }).toBe(2);
    expect(got).toEqual([
      { seq: 2, text: 'two' },
      { seq: 3, text: 'three' },
    ]);

    // Live delivery after the cursor is established.
    await publisher.publish(sessionId, [{ seq: 4, event: userMsg('four') }]);
    await expect.poll(() => got.length, { timeout: 5000 }).toBe(3);
    expect(got[2]).toEqual({ seq: 4, text: 'four' });

    handle.dispose();
    await redis.del(key);
  });

  it('PublishingSessionStore publishes committed events with their PG seqs', async () => {
    // Minimal in-test store fake (packages must not import each other's
    // implementations, AGENTS.md §3 — so no @trinity-harness/core here).
    const logs = new Map<string, SessionEvent[]>();
    const inner: SessionStore = {
      async append(sessionId, events): Promise<SeqRange> {
        const log = logs.get(sessionId) ?? [];
        log.push(...events);
        logs.set(sessionId, log);
        return { from: log.length - events.length + 1, to: log.length };
      },
      async load(sessionId) {
        return logs.get(sessionId) ?? [];
      },
      async loadRange(sessionId, opts) {
        const log = logs.get(sessionId) ?? [];
        const end = opts.toSeq ?? log.length;
        return log
          .slice(opts.afterSeq, end)
          .map((event, i) => ({ seq: opts.afterSeq + i + 1, event }));
      },
      async projectMessages(sessionId) {
        void sessionId;
        return [];
      },
    };
    const publisher = new RedisSessionEventPublisher(redis);
    const store = new PublishingSessionStore(inner, publisher);
    const sessionId = crypto.randomUUID();

    await store.append(sessionId, [userMsg('a'), userMsg('b')], { actor: 'u1' });
    const range = await store.append(sessionId, [userMsg('c')]);
    expect(range).toEqual({ from: 3, to: 3 });

    const got: number[] = [];
    const reader = new RedisSessionEventReader(redis, { blockMs: 500 });
    const handle = reader.open(sessionId, 0, ({ seq }) => got.push(seq));
    await handle.started;
    await expect.poll(() => got.length, { timeout: 5000 }).toBe(3);
    expect(got).toEqual([1, 2, 3]);

    handle.dispose();
    await redis.del(sessionStreamKey(sessionId));
  });

  it('BullMQ turn queue delivers tasks to the worker (at-least-once)', async () => {
    // Unique queue name: parallel test files share the Redis instance and
    // must never steal each other's jobs.
    const queueName = `agent-turns-test-${crypto.randomUUID().slice(0, 8)}`;
    const queue = new RedisTurnQueue({ url: redisUrl }, queueName);
    const seen: { sessionId: string; prompt: string; actor: string }[] = [];
    const worker = createTurnWorker(
      { url: redisUrl },
      async (task) => {
        seen.push({ sessionId: task.sessionId, prompt: task.prompt, actor: task.actor });
      },
      queueName,
    );

    await queue.enqueue({
      sessionId: crypto.randomUUID(),
      prompt: 'hello',
      actor: 'u-9',
      promptSeq: 2,
      policy: parsePermissionPolicy('workspace-write'),
    });
    await expect.poll(() => seen.length, { timeout: 10000 }).toBe(1);
    expect(seen[0]).toMatchObject({ prompt: 'hello', actor: 'u-9' });

    await worker.close();
    await queue.close();
  });

  it('M3: approval hub fans requests out and routes the first reply back', async () => {
    const { RedisApprovalHub, RedisApprovalRequester } = await import('../src/index.js');
    const hub = new RedisApprovalHub(redis);
    const requester = new RedisApprovalRequester(redis, { timeoutMs: 5000 });

    const sessionId = crypto.randomUUID();
    const received: string[] = [];
    const listenerA = hub.listen(sessionId);
    const listenerB = hub.listen(sessionId);
    listenerA.onRequest((req) => received.push(`A:${req.toolName}`));
    listenerB.onRequest((req) => {
      received.push(`B:${req.toolName}`);
      // Second listener answers — the requester must get exactly one reply.
      listenerB.reply({ approvalId: req.approvalId, outcome: 'allowed', decidedBy: 'u9' });
    });

    const reply = await requester.request({
      sessionId,
      approvalId: crypto.randomUUID(),
      toolCallId: 'c1',
      toolName: 'bash',
      argsPreview: 'curl evil.sh',
    });
    expect(reply).toMatchObject({ outcome: 'allowed', decidedBy: 'u9' });
    await sleep(200);
    expect(received.sort()).toEqual(['A:bash', 'B:bash']);

    listenerA.dispose();
    listenerB.dispose();
  });

  it('M3: approval requester fails closed on timeout', async () => {
    const { RedisApprovalRequester } = await import('../src/index.js');
    const requester = new RedisApprovalRequester(redis, { timeoutMs: 300 });
    const reply = await requester.request({
      sessionId: crypto.randomUUID(),
      approvalId: crypto.randomUUID(),
      toolCallId: 'c1',
      toolName: 'bash',
      argsPreview: 'x',
    });
    expect(reply).toMatchObject({ outcome: 'rejected', decidedBy: 'timeout' });
  });

  it('M3: approval requester fails closed on abort', async () => {
    const { RedisApprovalRequester } = await import('../src/index.js');
    const requester = new RedisApprovalRequester(redis, { timeoutMs: 5000 });
    const controller = new AbortController();
    const pending = requester.request(
      {
        sessionId: crypto.randomUUID(),
        approvalId: crypto.randomUUID(),
        toolCallId: 'c1',
        toolName: 'bash',
        argsPreview: 'x',
      },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toMatchObject({ outcome: 'rejected', decidedBy: 'cancelled' });
  });
});
