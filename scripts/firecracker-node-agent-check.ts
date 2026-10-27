import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { once } from 'node:events';

const repo = fileURLToPath(new URL('../', import.meta.url));
loadEnvFile(path.join(repo, '.env'));
const databaseUrl = process.env['DATABASE_URL'];
assert(databaseUrl, 'DATABASE_URL is missing from .env');
const portServer = createServer();
await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve));
const address = portServer.address();
assert(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>((resolve, reject) =>
  portServer.close((error) => (error ? reject(error) : resolve())),
);
const token = randomBytes(32).toString('base64url');
const child = spawn(
  process.execPath,
  [
    path.join(repo, 'apps/node-agent/node_modules/tsx/dist/cli.mjs'),
    path.join(repo, 'apps/node-agent/src/main.ts'),
  ],
  {
    cwd: repo,
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: process.env['HOME'] ?? '/tmp',
      LANG: process.env['LANG'] ?? 'C.UTF-8',
      DATABASE_URL: databaseUrl,
      NODE_ID: 'local-acceptance',
      NODE_STATE_DIR: '/srv/trinity-node',
      NODE_DEPLOYMENT_MODE: 'development',
      NODE_STORAGE_ENCRYPTION: 'none',
      NODE_RUNTIME_TOKEN: token,
      NODE_GUEST_ROUTING: 'true',
      WORKSPACE_ROOT: '/workspace',
      NODE_PORT: String(port),
      DOTENV_CONFIG_PATH: '/dev/null',
    },
    stdio: 'ignore',
  },
);
let stopped = false;
const stop = async (): Promise<void> => {
  if (stopped) return;
  stopped = true;
  child.kill('SIGTERM');
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      once(child, 'exit'),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        timer.unref();
      }),
    ]);
  }
  if (child.exitCode === null) child.kill('SIGKILL');
};
try {
  const root = `http://127.0.0.1:${port}`;
  let listening = false;
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(`${root}/instances`, { method: 'POST', body: '{}' });
      listening = response.status === 401;
      if (listening) break;
    } catch {
      // Only retry connection refusal while the process starts.
    }
    if (child.exitCode !== null) throw new Error('Node Agent exited during startup');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(listening, 'Node Agent did not bind its loopback port');
  const identity = {
    id: randomUUID(),
    tenantId: randomUUID(),
    userId: randomUUID(),
    nodeId: 'local-acceptance',
    generation: randomUUID(),
    state: 'running',
    vcpus: 2,
    memoryMiB: 2048,
  } as const;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const instance = await fetch(`${root}/instances`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operation: 'status', environment: identity }),
  });
  assert.equal(instance.status, 409, 'unknown PG assignment must fail closed');
  const guest = await fetch(`${root}/guest`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      environment: identity,
      request: {
        requestId: randomUUID(),
        environmentId: identity.id,
        generation: identity.generation,
        sessionId: randomUUID(),
        workspace: 'acceptance',
        operation: { kind: 'skillsList' },
      },
    }),
  });
  assert.equal(guest.status, 409, 'unassigned guest RPC must fail closed before vsock');
  const browser = await fetch(`${root}/guest-browser`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      environment: identity,
      request: {
        requestId: randomUUID(),
        environmentId: identity.id,
        generation: identity.generation,
        sessionId: randomUUID(),
        workspace: 'acceptance',
        operation: { kind: 'desktopFrame' },
      },
    }),
  });
  assert.equal(browser.status, 409, 'unassigned desktop RPC must fail closed before vsock');
  console.log('Node Agent started with live PostgreSQL and guest routing enabled.');
  console.log(
    'Authentication passed; unknown lifecycle, guest and desktop assignments were denied by PostgreSQL.',
  );
} finally {
  await stop();
}
