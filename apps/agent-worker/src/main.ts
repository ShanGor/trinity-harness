import path from 'node:path';

import {
  AiSdkGateway,
  bashTool,
  ContextManager,
  CoreAgentLoop,
  CoreToolRegistry,
  createLspTools,
  createReadBlobTool,
  createSubagentTool,
  editFileTool,
  globTool,
  LocalBlobStore,
  LocalSandbox,
  LspService,
  makeDiagnosticsAugment,
  MemorySessionStore,
  readFileTool,
  writeFileTool,
} from '@trinity-harness/core';
import {
  createDb,
  createPool,
  PgApprovalStore,
  PgSessionMetaStore,
  PgSessionStore,
} from '@trinity-harness/db';
import {
  BusAuditEmitter,
  createRedis,
  createTurnWorker,
  PublishingSessionStore,
  RedisApprovalRequester,
  RedisEventBus,
  RedisLiveEventPublisher,
  RedisSessionEventPublisher,
  RedisTurnCancelSubscriber,
} from '@trinity-harness/redis';

import { loadWorkerEnv } from './env.js';
import { createTurnHandler } from './worker.js';

/**
 * Composition root for the agent worker (AGENTS.md §3.2): PG event log +
 * Redis stream publishing + BullMQ turn consumption. Stateless besides the
 * connections it owns; the event log is the source of truth (design.md §16).
 * M4 adds the Context Manager (compaction), tool-result spill, LSP tools and
 * the subagent tool (docs/design.md §7/§8/§9).
 */
async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const pool = createPool(env.DATABASE_URL);
  const db = createDb(pool);

  const redis = createRedis(env.REDIS_URL);
  const bus = new RedisEventBus(redis);
  const store = new PublishingSessionStore(
    new PgSessionStore(db),
    new RedisSessionEventPublisher(redis),
  );
  const metas = new PgSessionMetaStore(db);
  const sandbox = new LocalSandbox(env.WORKSPACE_ROOT);
  const registry = new CoreToolRegistry(sandbox);
  for (const tool of [readFileTool, writeFileTool, editFileTool, globTool, bashTool]) {
    registry.register(tool);
  }

  // M4: blob store backs spill + multimodal attachments. Local adapter shares
  // the workspace disk (single-node topology; S3 adapter is drop-in, §10).
  const blobStore = new LocalBlobStore(path.join(env.WORKSPACE_ROOT, '.trinity', 'blobs'));
  registry.register(createReadBlobTool(blobStore));

  const llm = new AiSdkGateway(undefined, {
    reasoningBudgetTokens: env.REASONING_BUDGET_TOKENS,
    reasoningEffort: env.REASONING_EFFORT,
  });

  // M4: context manager — compact between steps when over budget (§7).
  const context = new ContextManager({
    llm,
    model: env.COMPACTION_MODEL ?? env.MODEL,
    store,
    maxTokens: env.CONTEXT_MAX_TOKENS,
    keepTokens: env.CONTEXT_KEEP_TOKENS,
  });

  // M4: LSP service + tools (lazy per-workspace language servers, §9).
  const lsp = env.LSP_ENABLED
    ? new LspService({
        sandbox,
        readText: async (abs) =>
          (await sandbox.readFile(path.relative(env.WORKSPACE_ROOT, abs))).content,
        maxServers: env.LSP_MAX_SERVERS,
      })
    : null;
  if (lsp) {
    for (const tool of createLspTools(lsp)) {
      registry.register(tool);
    }
  }

  // M4: subagent — child loop with a fresh in-memory context (§8). The child
  // registry reuses the base tools + read_blob, minus subagent (no recursion).
  const childRegistry = new CoreToolRegistry(sandbox);
  for (const tool of [readFileTool, writeFileTool, editFileTool, globTool, bashTool]) {
    childRegistry.register(tool);
  }
  childRegistry.register(createReadBlobTool(blobStore));
  if (lsp) {
    for (const tool of createLspTools(lsp)) {
      childRegistry.register(tool);
    }
  }
  registry.register(
    createSubagentTool({
      createLoop: () =>
        new CoreAgentLoop({
          llm,
          model: env.MODEL,
          systemPrompt: env.SYSTEM_PROMPT,
          tools: childRegistry,
          store: new MemorySessionStore(),
          workspaceRoot: env.WORKSPACE_ROOT,
          maxSteps: 16,
          resolveBlob: async (uri) => {
            const bytes = await blobStore.get(uri);
            if (bytes === null) throw new Error(`blob not found: ${uri}`);
            return bytes;
          },
        }),
    }),
  );

  const resolveBlob = async (uri: string): Promise<Uint8Array> => {
    const bytes = await blobStore.get(uri);
    if (bytes === null) throw new Error(`blob not found: ${uri}`);
    return bytes;
  };

  // M4: LSP diagnostics context injection (design.md §9) — shared helper,
  // failures degrade to no augmentation (never break a turn).
  const augmentSystem = lsp ? makeDiagnosticsAugment(lsp, () => store) : undefined;

  const handleTurn = createTurnHandler({
    store,
    metas,
    createLoop: () =>
      new CoreAgentLoop({
        llm,
        model: env.MODEL,
        systemPrompt: env.SYSTEM_PROMPT,
        tools: registry,
        store,
        workspaceRoot: env.WORKSPACE_ROOT,
        // M3: fail-closed human approval channel + durable approval trail.
        approvals: new RedisApprovalRequester(redis),
        approvalStore: new PgApprovalStore(db),
        // M4: compaction + spill + multimodal + diagnostics injection.
        context,
        spill: { store: blobStore, thresholdBytes: env.SPILL_THRESHOLD_BYTES },
        resolveBlob,
        augmentSystem,
      }),
    live: new RedisLiveEventPublisher(redis),
    audit: new BusAuditEmitter(bus),
  });

  const worker = createTurnWorker({ url: env.REDIS_URL }, (task, _job, signal) =>
    handleTurn(task, signal),
  );
  // M3 session/cancel: abort the turn when it is running on THIS replica.
  const cancels = new RedisTurnCancelSubscriber(redis);
  const cancelSub = cancels.subscribe((sessionId) => worker.cancel(sessionId));
  console.log('[agent-worker] consuming turns from BullMQ');

  const shutdown = async (): Promise<void> => {
    cancelSub.dispose();
    await worker.close();
    if (lsp) await lsp.dispose();
    redis.disconnect();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
