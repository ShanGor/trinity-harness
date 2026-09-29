import path from 'node:path';

import {
  AiSdkGateway,
  bashTool,
  ContextManager,
  CoreAgentLoop,
  CoreToolRegistry,
  createLspTools,
  createReadBlobTool,
  editFileTool,
  globTool,
  LocalBlobStore,
  LocalSandbox,
  LspService,
  makeDiagnosticsAugment,
  MemorySessionStore,
  readFileTool,
  ScryptPasswordHasher,
  HmacTokenService,
  writeFileTool,
} from '@trinity-harness/core';
import {
  countUsers,
  createDb,
  createPool,
  createTenant,
  PgApprovalStore,
  PgAuditStore,
  PgSessionMetaStore,
  PgSessionStore,
  PgUserStore,
} from '@trinity-harness/db';
import {
  BusAuditEmitter,
  createRedis,
  PublishingSessionStore,
  RedisApprovalHub,
  RedisEventBus,
  RedisLiveEventSubscriber,
  RedisSessionEventPublisher,
  RedisSessionEventReader,
  RedisTurnCancelPublisher,
  RedisTurnQueue,
} from '@trinity-harness/redis';
import { parsePermissionPolicy } from '@trinity-harness/contracts';
import type { SessionStore } from '@trinity-harness/contracts';

import { loadServerEnv } from './env.js';
import { buildServer } from './server.js';

/**
 * Composition root (AGENTS.md §3.2): the object graph is assembled HERE and
 * only here. M2 modes:
 * - DATABASE_URL + REDIS_URL: PG event log + auth/RBAC + BullMQ/agent-worker
 *   distribution + Redis Stream SSE relay (full M2 topology).
 * - DATABASE_URL only:      PG event log + auth/RBAC, Loop runs in-server.
 * - neither:                M1 in-memory inline mode (tests/local fallback).
 */
async function main(): Promise<void> {
  const env = loadServerEnv();
  const sandbox = new LocalSandbox(env.WORKSPACE_ROOT);
  const registry = new CoreToolRegistry(sandbox);
  for (const tool of [readFileTool, writeFileTool, editFileTool, globTool, bashTool]) {
    registry.register(tool);
  }

  // M4: blob store backs attachments (upload endpoint) and spilled results.
  // Shares the workspace disk with the agent-worker (single-node topology).
  const blobStore = new LocalBlobStore(path.join(env.WORKSPACE_ROOT, '.trinity', 'blobs'));
  registry.register(createReadBlobTool(blobStore));

  const databaseUrl = process.env['DATABASE_URL'];
  let store: SessionStore = new MemorySessionStore();

  // M4 wiring for the inline-mode Loop (distributed turns run on the
  // agent-worker, which carries the same assembly — see apps/agent-worker).
  let lsp: LspService | null = null;
  let context: ContextManager | null = null;
  const llm = new AiSdkGateway(undefined, {
    reasoningBudgetTokens: env.REASONING_BUDGET_TOKENS,
    reasoningEffort: env.REASONING_EFFORT,
  });
  const resolveBlob = async (uri: string): Promise<Uint8Array> => {
    const bytes = await blobStore.get(uri);
    if (bytes === null) throw new Error(`blob not found: ${uri}`);
    return bytes;
  };
  const m4LoopExtras = (): ConstructorParameters<typeof CoreAgentLoop>[0] => ({
    llm,
    model: env.MODEL,
    systemPrompt: env.SYSTEM_PROMPT,
    tools: registry,
    store,
    workspaceRoot: env.WORKSPACE_ROOT,
    spill: { store: blobStore, thresholdBytes: env.SPILL_THRESHOLD_BYTES },
    resolveBlob,
  });
  if (env.LSP_ENABLED) {
    lsp = new LspService({
      sandbox,
      readText: async (abs) =>
        (await sandbox.readFile(path.relative(env.WORKSPACE_ROOT, abs))).content,
      maxServers: env.LSP_MAX_SERVERS,
    });
    for (const tool of createLspTools(lsp)) {
      registry.register(tool);
    }
  }

  let createLoop: (() => CoreAgentLoop) | undefined = () => {
    context ??= new ContextManager({
      llm,
      model: env.COMPACTION_MODEL ?? env.MODEL,
      store,
      maxTokens: env.CONTEXT_MAX_TOKENS,
      keepTokens: env.CONTEXT_KEEP_TOKENS,
    });
    return new CoreAgentLoop({
      ...m4LoopExtras(),
      context,
      // Inline mode keeps turns in-process; diagnostics injection mirrors the
      // worker assembly (docs/design.md §9).
      augmentSystem: lsp ? makeDiagnosticsAugment(lsp, () => store) : undefined,
    });
  };

  let queue: RedisTurnQueue | undefined;
  let eventReader: RedisSessionEventReader | undefined;
  let liveEvents: RedisLiveEventSubscriber | undefined;
  let auth: Parameters<typeof buildServer>[0]['auth'];
  let audit: BusAuditEmitter | undefined;
  let auditQuery: PgAuditStore | undefined;
  let approvals: RedisApprovalHub | undefined;
  let approvalStore: PgApprovalStore | undefined;
  let turnCancel: RedisTurnCancelPublisher | undefined;
  let defaultPolicy: ReturnType<typeof parsePermissionPolicy> | undefined;

  if (databaseUrl) {
    const pool = createPool(databaseUrl);
    const db = createDb(pool);
    store = new PgSessionStore(db);

    if (env.REDIS_URL) {
      const redis = createRedis(env.REDIS_URL);
      const bus = new RedisEventBus(redis);
      store = new PublishingSessionStore(store, new RedisSessionEventPublisher(redis));
      queue = new RedisTurnQueue({ url: env.REDIS_URL });
      eventReader = new RedisSessionEventReader(redis);
      liveEvents = new RedisLiveEventSubscriber(redis);
      audit = new BusAuditEmitter(bus);
      auditQuery = new PgAuditStore(db);
      // M3: approvals + cross-process session/cancel (docs/design.md §12.2, §6.3).
      approvals = new RedisApprovalHub(redis);
      approvalStore = new PgApprovalStore(db);
      turnCancel = new RedisTurnCancelPublisher(redis);
      // Turns run on the agent-worker; this process only enqueues.
      createLoop = undefined;
    }
    if (env.DEFAULT_PERMISSION_POLICY) {
      defaultPolicy = parsePermissionPolicy(env.DEFAULT_PERMISSION_POLICY);
    }

    // Auth/RBAC (M2): fail-closed — no TOKEN_SECRET, no auth materialization.
    if (!env.TOKEN_SECRET) {
      throw new Error('TOKEN_SECRET is required when DATABASE_URL is set (auth is mandatory, M2)');
    }
    const hasher = new ScryptPasswordHasher();
    const users = new PgUserStore(db, hasher);
    const metas = new PgSessionMetaStore(db);

    // First-boot bootstrap: provision the default tenant + admin exactly once.
    if ((await countUsers(db)) === 0) {
      if (!env.ADMIN_PASSWORD) {
        throw new Error(
          'ADMIN_PASSWORD is required for first-boot admin provisioning (users table is empty)',
        );
      }
      const tenant = await createTenant(db, 'default');
      try {
        await users.createUser({
          tenantId: tenant.id,
          email: env.ADMIN_EMAIL,
          passwordHash: await hasher.hash(env.ADMIN_PASSWORD),
          role: 'admin',
        });
        console.log(`[server] bootstrapped tenant ${tenant.id} with admin ${env.ADMIN_EMAIL}`);
      } catch {
        // Concurrent first boots: unique email constraint — already provisioned.
      }
    }

    auth = { tokens: new HmacTokenService(env.TOKEN_SECRET), users, metas, hasher };
  } else if (env.REDIS_URL) {
    throw new Error('REDIS_URL requires DATABASE_URL (distributed mode needs the PG event log)');
  }

  const app = await buildServer(
    {
      store,
      workspaceRoot: env.WORKSPACE_ROOT,
      createLoop,
      queue,
      eventReader,
      liveEvents,
      auth,
      audit,
      auditQuery,
      approvals,
      approvalStore,
      turns: turnCancel ? { cancel: (sid) => turnCancel!.cancel(sid) } : undefined,
      defaultPolicy,
      blobs: blobStore,
    },
    { logger: true },
  );

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(
    `trinity-harness server listening on http://${env.HOST}:${env.PORT} ` +
      `(mode: ${queue ? 'distributed' : databaseUrl ? 'pg-inline' : 'memory-inline'})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
