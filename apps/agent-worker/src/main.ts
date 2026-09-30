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
  PgUsageStore,
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
  RedisTurnQueue,
  TURN_QUEUE_NAME,
} from '@trinity-harness/redis';
import { startTelemetry } from '@trinity-harness/otel';
import { metrics } from '@opentelemetry/api';

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
  // M5 OTel (docs/design.md §17): no-op unless OTEL_EXPORTER_OTLP_ENDPOINT /
  // OTEL_PROMETHEUS_PORT is set.
  const telemetry = startTelemetry({});
  if (telemetry) {
    console.log('[agent-worker] OTel SDK started');
  }
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
  // M5: token metering — the loop records usage and gates model calls on the
  // tenant quota before every request (docs/design.md §17).
  const usage = new PgUsageStore(db);
  // M5: sandbox env scrubbing — worker secrets never reach tool children.
  //
  // Per-session workspaces (docs/design.md §15): every session is sandboxed
  // to its own directory ($WORKSPACE_ROOT/<user_id> or <team_id>), so the
  // sandbox + tool registries are built PER ROOT and cached — the sandbox's
  // path-escape check is the isolation boundary between users/teams.
  const blobStore = new LocalBlobStore(path.join(env.WORKSPACE_ROOT, '.trinity', 'blobs'));
  // M4: LSP service + tools (lazy per-workspace language servers, §9). Rooted
  // at the deployment root so it can index every session subdirectory.
  const globalSandbox = new LocalSandbox(env.WORKSPACE_ROOT, {
    envMode: env.SANDBOX_ENV_MODE,
  });
  const lsp = env.LSP_ENABLED
    ? new LspService({
        sandbox: globalSandbox,
        readText: async (abs) =>
          (await globalSandbox.readFile(path.relative(env.WORKSPACE_ROOT, abs))).content,
        maxServers: env.LSP_MAX_SERVERS,
      })
    : null;

  const resolveBlob = async (uri: string): Promise<Uint8Array> => {
    const bytes = await blobStore.get(uri);
    if (bytes === null) throw new Error(`blob not found: ${uri}`);
    return bytes;
  };

  interface RootAssembly {
    sandbox: LocalSandbox;
    registry: CoreToolRegistry;
  }
  const assemblies = new Map<string, RootAssembly>();
  const assemblyFor = (root: string): RootAssembly => {
    let assembly = assemblies.get(root);
    if (assembly) return assembly;
    const sandbox = new LocalSandbox(root, { envMode: env.SANDBOX_ENV_MODE });
    const registry = new CoreToolRegistry(sandbox);
    for (const tool of [readFileTool, writeFileTool, editFileTool, globTool, bashTool]) {
      registry.register(tool);
    }
    registry.register(createReadBlobTool(blobStore));
    if (lsp) {
      for (const tool of createLspTools(lsp)) {
        registry.register(tool);
      }
    }
    // M4: subagent — child loop with a fresh in-memory context (§8). The child
    // registry reuses the base tools + read_blob, minus subagent (no recursion),
    // sandboxed to the SAME root as the parent turn.
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
            workspaceRoot: root,
            maxSteps: 16,
            resolveBlob,
          }),
      }),
    );
    assembly = { sandbox, registry };
    assemblies.set(root, assembly);
    return assembly;
  };

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

  // M4: LSP diagnostics context injection (design.md §9) — shared helper,
  // failures degrade to no augmentation (never break a turn).
  const augmentSystem = lsp ? makeDiagnosticsAugment(lsp, () => store) : undefined;

  const handleTurn = createTurnHandler({
    store,
    metas,
    defaultWorkspaceRoot: env.WORKSPACE_ROOT,
    createLoop: (_sessionId, workspaceRoot) =>
      new CoreAgentLoop({
        llm,
        model: env.MODEL,
        systemPrompt: env.SYSTEM_PROMPT,
        tools: assemblyFor(workspaceRoot).registry,
        store,
        workspaceRoot,
        // M3: fail-closed human approval channel + durable approval trail.
        approvals: new RedisApprovalRequester(redis),
        approvalStore: new PgApprovalStore(db),
        // M4: compaction + spill + multimodal + diagnostics injection.
        context,
        spill: { store: blobStore, thresholdBytes: env.SPILL_THRESHOLD_BYTES },
        resolveBlob,
        augmentSystem,
        // M5: usage recording + tenant quota gate (docs/design.md §17).
        usage,
      }),
    live: new RedisLiveEventPublisher(redis),
    audit: new BusAuditEmitter(bus),
  });

  const worker = createTurnWorker({ url: env.REDIS_URL }, (task, _job, signal) =>
    handleTurn(task, signal),
  );

  // M5: queue-depth metric (docs/design.md §17). The ObservableGauge callback
  // fires per metric collection — event-driven, no polling loop (AGENTS §4.2).
  const queueProbe = new RedisTurnQueue({ url: env.REDIS_URL });
  metrics
    .getMeter('trinity-harness/worker')
    .createObservableGauge('trinity.queue.jobs', {
      description: 'BullMQ turn-queue job counts by state',
    })
    .addCallback(async (observable) => {
      try {
        const counts = await queueProbe.counts();
        for (const [state, n] of Object.entries(counts)) {
          observable.observe(n, {
            'trinity.queue': TURN_QUEUE_NAME,
            'trinity.queue_state': state,
          });
        }
      } catch {
        // Metrics must never break the worker; a failed read yields no data.
      }
    });
  // M3 session/cancel: abort the turn when it is running on THIS replica.
  const cancels = new RedisTurnCancelSubscriber(redis);
  const cancelSub = cancels.subscribe((sessionId) => worker.cancel(sessionId));
  console.log('[agent-worker] consuming turns from BullMQ');

  const shutdown = async (): Promise<void> => {
    // M5 drain: BullMQ close() stops claiming NEW jobs and waits for the
    // in-flight turn to finish (docs/design.md §16 缩容前 drain).
    cancelSub.dispose();
    await worker.close();
    await queueProbe.close();
    if (lsp) await lsp.dispose();
    await telemetry?.shutdown();
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
