import { CoreAgentLoop, CoreToolRegistry, MemorySessionStore } from '@trinity-harness/core';
import {
  bashTool,
  editFileTool,
  globTool,
  AiSdkGateway,
  LocalSandbox,
  readFileTool,
  writeFileTool,
} from '@trinity-harness/core';

import { loadServerEnv } from './env.js';
import { buildServer } from './server.js';

/**
 * Composition root (AGENTS.md §3.2): the object graph is assembled HERE and
 * only here. Swapping fakes in tests happens via buildServer(deps) instead.
 */
async function main(): Promise<void> {
  const env = loadServerEnv();
  const sandbox = new LocalSandbox(env.WORKSPACE_ROOT);
  const store = new MemorySessionStore();
  const registry = new CoreToolRegistry(sandbox);
  for (const tool of [readFileTool, writeFileTool, editFileTool, globTool, bashTool]) {
    registry.register(tool);
  }

  const app = await buildServer({
    store,
    workspaceRoot: env.WORKSPACE_ROOT,
    createLoop: () =>
      new CoreAgentLoop({
        llm: new AiSdkGateway(undefined, {
          reasoningBudgetTokens: env.REASONING_BUDGET_TOKENS,
          reasoningEffort: env.REASONING_EFFORT,
        }),
        model: env.MODEL,
        systemPrompt: env.SYSTEM_PROMPT,
        tools: registry,
        store,
        workspaceRoot: env.WORKSPACE_ROOT,
      }),
  });

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`trinity-harness server listening on http://${env.HOST}:${env.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
