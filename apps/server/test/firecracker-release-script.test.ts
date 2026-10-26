import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

const servers: Array<ReturnType<typeof createServer>> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(
  drainStatus: number,
  releaseStatus = 200,
): Promise<{
  baseUrl: string;
  calls: string[];
  bin: string;
  marker: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trinity-node-release-'));
  tempDirs.push(directory);
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const calls: string[] = [];
  const token = 'm'.repeat(32);
  const server = createServer((request, response) => {
    calls.push(request.url ?? '');
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end('{}');
      return;
    }
    const drain = request.url?.endsWith('/drain');
    response.writeHead(drain ? drainStatus : releaseStatus, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        drain && drainStatus === 404
          ? {
              message: 'Route POST:/api/ops/firecracker-nodes/host-1/drain not found',
              error: 'Not Found',
              statusCode: 404,
            }
          : drain
            ? {
                nodeId: 'host-1',
                state: 'draining',
                stopped: drainStatus === 200 ? 1 : 0,
                remaining: drainStatus === 200 ? 0 : 1,
                failed: 0,
              }
            : { nodeId: 'host-1', state: 'ready' },
      ),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    bin,
    marker: path.join(directory, 'released'),
  };
}

function runRelease(
  value: Awaited<ReturnType<typeof fixture>>,
  commandExit = 0,
  nodeId: string | null = 'host-1',
): Promise<{ code: number | null; output: string }> {
  const script = path.resolve('scripts/release-firecracker-node.sh');
  return new Promise((resolve, reject) => {
    const child = spawn(
      'bash',
      [script, 'host-1', '--', 'bash', '-c', 'exit "$RELEASE_COMMAND_EXIT"'],
      {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          PATH: `${value.bin}:${process.env['PATH'] ?? ''}`,
          HOME: path.dirname(value.marker),
          NODE_ID: nodeId ?? undefined,
          FIRECRACKER_MAINTENANCE_URL: value.baseUrl,
          FIRECRACKER_MAINTENANCE_TOKEN: 'm'.repeat(32),
          RELEASE_COMMAND_EXIT: String(commandExit),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

it('runs the release command between confirmed drain and resume', async () => {
  const value = await fixture(200);
  const result = await runRelease(value);
  expect(result.code).toBe(0);
  expect(value.calls).toEqual([
    '/api/ops/firecracker-nodes/host-1/drain',
    '/api/ops/firecracker-nodes/host-1/resume',
  ]);
  expect(result.output).toContain('All environments on host-1 are stopped');
});

it('uses the positional node ID when NODE_ID is not set', async () => {
  const value = await fixture(200);
  const result = await runRelease(value, 0, null);
  expect(result.code).toBe(0);
  expect(value.calls).toEqual([
    '/api/ops/firecracker-nodes/host-1/drain',
    '/api/ops/firecracker-nodes/host-1/resume',
  ]);
});

it('does not run or resume a node whose drain is incomplete', async () => {
  const value = await fixture(409);
  const result = await runRelease(value);
  expect(result.code).not.toBe(0);
  expect(value.calls).toEqual(['/api/ops/firecracker-nodes/host-1/drain']);
  expect(result.output).toContain('node remains in maintenance');
});

it('explains that a rejected token did not authorize a drain', async () => {
  const value = await fixture(401);
  const result = await runRelease(value);
  expect(result.code).not.toBe(0);
  expect(value.calls).toEqual(['/api/ops/firecracker-nodes/host-1/drain']);
  expect(result.output).toContain('server rejected the maintenance token');
  expect(result.output).toContain('earlier maintenance gate, if any, remains unchanged');
});

it('identifies a server build that does not expose the drain route', async () => {
  const value = await fixture(404);
  const result = await runRelease(value);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain('server build lacks the maintenance route');
  expect(result.output).toContain('Route POST:/api/ops/firecracker-nodes/host-1/drain not found');
});

it('leaves the node drained if the release command fails', async () => {
  const value = await fixture(200);
  const result = await runRelease(value, 7);
  expect(result.code).toBe(7);
  expect(value.calls).toEqual(['/api/ops/firecracker-nodes/host-1/drain']);
});
