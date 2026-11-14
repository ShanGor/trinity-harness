import { loadWorkerEnv } from '../apps/agent-worker/src/env.js';
import {
  createPool,
  createDb,
  PgEnvironmentStore,
  PgSessionMetaStore,
  PgUserStore,
} from '../packages/db/src/index.js';
import {
  FirecrackerGuestRouter,
  RemoteSandbox,
  ScryptPasswordHasher,
} from '../packages/core/src/index.js';
import { checkWorkspaceCopy } from './check-workspace-copy.js';

const sessionId = process.argv[2];
if (!sessionId) throw Error('Provide an owned personal session ID for guest acceptance');
const env = loadWorkerEnv();
if (env.EXECUTION_DRIVER !== 'firecracker' || !env.NODE_RUNTIME_TOKEN)
  throw Error('Configured Firecracker routing is required');
const pool = createPool(env.DATABASE_URL),
  locks = createPool(env.DATABASE_URL);
try {
  const db = createDb(pool);
  const environments = new PgEnvironmentStore(db, locks);
  const unavailable = async (): Promise<never> => {
    throw Error(
      'Acceptance never wakes or suspends a VM; use an already running owned environment',
    );
  };
  const router = new FirecrackerGuestRouter(
    { get: (identity) => environments.get(identity), wake: unavailable, suspend: unavailable },
    environments,
    new PgSessionMetaStore(db),
    new PgUserStore(db, new ScryptPasswordHasher()),
    env.FIRECRACKER_NODES,
    env.NODE_RUNTIME_TOKEN,
    env.WORKSPACE_ROOT,
  );
  await checkWorkspaceCopy(new RemoteSandbox(router, sessionId), AbortSignal.timeout(60000));
  console.log(
    'Configured guest-route copy acceptance passed: Unicode, exclusive creation, existing/raced destinations, symlink rejection and cancellation.',
  );
} finally {
  await pool.end();
  await locks.end();
}
