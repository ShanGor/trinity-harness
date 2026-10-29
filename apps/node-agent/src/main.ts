import 'dotenv/config';
import { LocalSandbox, ScryptPasswordHasher } from '@trinity-harness/core';
import {
  createDb,
  createPool,
  PgEnvironmentStore,
  PgSessionMetaStore,
  PgUserStore,
} from '@trinity-harness/db';
import { FirecrackerGuestRelay } from './guest-relay.js';
import { parseNodeAgentEnv } from './env.js';
import { SystemdNodeRuntime } from './runtime.js';
import { reconcileNodeEnvironments } from './reconcile.js';
import { buildNodeAgent } from './server.js';

async function main(): Promise<void> {
  const env = parseNodeAgentEnv(process.env);
  const pool = createPool(env.DATABASE_URL, {
    connectionTimeoutMillis: 5000,
    query_timeout: 10_000,
  });
  const sandbox = new LocalSandbox(env.NODE_STATE_DIR, { envMode: 'minimal' });
  const environmentStore = new PgEnvironmentStore(createDb(pool), pool);
  const runtime = new SystemdNodeRuntime(sandbox);
  // Boot reconciliation converges stale durable state after a host reboot
  // before serving lifecycle commands (docs/design.md §21.4).
  try {
    const { reconciled } = await reconcileNodeEnvironments(environmentStore, runtime, env.NODE_ID);
    if (reconciled > 0) {
      console.log(`[node-agent] reconciled ${reconciled} environment(s) with host reality`);
    }
  } catch (error) {
    // Reconciliation is best-effort at startup: a failed scan must not prevent
    // the node agent from serving lifecycle commands, and the next status probe
    // reconciles again. Serving with stale state is safe because every wake and
    // guest route still verifies state through this node.
    console.error('[node-agent] environment reconciliation failed:', error);
  }
  const app = buildNodeAgent(
    runtime,
    environmentStore,
    env.NODE_ID,
    env.NODE_RUNTIME_TOKEN,
    env.NODE_GUEST_ROUTING === 'true'
      ? {
          relay: new FirecrackerGuestRelay(),
          metas: new PgSessionMetaStore(createDb(pool)),
          users: new PgUserStore(createDb(pool), new ScryptPasswordHasher()),
          workspaceRoot: env.WORKSPACE_ROOT,
        }
      : undefined,
  );
  try {
    await app.listen({ host: '127.0.0.1', port: env.NODE_PORT });
  } catch (error) {
    await pool.end();
    throw error;
  }
  let closing: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    closing ??= (async () => {
      try {
        await app.close();
      } finally {
        await pool.end();
      }
    })();
    await closing;
  };
  process.once('SIGTERM', () => {
    void shutdown();
  });
  process.once('SIGINT', () => {
    void shutdown();
  });
}
void main().catch(() => {
  console.error('Node agent startup failed');
  process.exitCode = 1;
});
