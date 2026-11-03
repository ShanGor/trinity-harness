import assert from 'node:assert/strict';
import test from 'node:test';
import { probeRuntime, runtimeConfig } from './podman-runtime.mjs';

const env = {
  EXECUTION_DRIVER: 'firecracker',
  BROWSER_DRIVER: 'zendriver',
  BROWSER_RUNTIME_ENDPOINT: 'http://127.0.0.1:3010',
  BROWSER_RUNTIME_TOKEN: 'b'.repeat(32),
  NODE_RUNTIME_TOKEN: 'n'.repeat(32),
  FIRECRACKER_NODES: JSON.stringify([{ id: 'local', endpoint: 'http://127.0.0.1:3030/' }]),
};
test('uses configured browser port and node endpoint', () => {
  assert.deepEqual(runtimeConfig(env, 3100, 8080), {
    browserEndpoint: 'http://127.0.0.1:3010',
    browserPort: 3010,
    nodeEndpoint: 'http://127.0.0.1:3030',
  });
});
test('rejects remote endpoints, ambiguous topology and port collisions before effects', () => {
  for (const patch of [
    { EXECUTION_DRIVER: 'local' },
    { BROWSER_RUNTIME_ENDPOINT: 'http://example.com:3010' },
    { BROWSER_RUNTIME_ENDPOINT: 'http://127.0.0.1:3100' },
    { NODE_RUNTIME_TOKEN: '' },
    { BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9222' },
    { FIRECRACKER_NODES: '[]' },
    { FIRECRACKER_NODES: JSON.stringify([{ endpoint: 'http://remote:3030' }]) },
  ])
    assert.throws(() => runtimeConfig({ ...env, ...patch }, 3100, 8080));
});
test('probe sends only invalid body and requires authenticated validation response', async () => {
  let calls = 0;
  await probeRuntime('http://127.0.0.1:3010', 'token', '/execute', async (url, options) => {
    calls++;
    assert.equal(url.pathname, '/execute');
    assert.equal(options.headers.authorization, 'Bearer token');
    assert.equal(options.body, '{}');
    assert.equal(options.method, 'POST');
    return { status: 400 };
  });
  assert.equal(calls, 1);
  for (const status of [200, 401, 404, 500, 503]) {
    await assert.rejects(
      probeRuntime('http://127.0.0.1:3010', 'token', '/execute', async () => ({ status })),
    );
  }
});
