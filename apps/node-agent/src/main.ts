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
import { buildNodeAgent } from './server.js';

async function main(): Promise<void> {
  const env = parseNodeAgentEnv(process.env);
  const pool = createPool(env.DATABASE_URL, {
    connectionTimeoutMillis: 5000,
    query_timeout: 10_000,
  });
  const sandbox = new LocalSandbox(env.NODE_STATE_DIR, { envMode: 'minimal' });
  const app = buildNodeAgent(
    new SystemdNodeRuntime(sandbox),
    new PgEnvironmentStore(createDb(pool), pool),
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
