import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { LocalSandbox, FileSkillCatalog } from '@trinity-harness/core';
import { browserPreviewSchema } from '@trinity-harness/contracts';
import { GuestRuntime } from '../src/runtime.js';
import { buildGuestServer } from '../src/server.js';
import { openGuestBrowser } from '../src/browser-process.js';

it.skipIf(process.env['ZENDRIVER_INTEGRATION'] !== '1' || process.getuid?.() !== 1000)(
  'exercises the deployment acceptance CLI against actual guest RPC and Zendriver across generations',
  async () => {
    // This socket fixture exercises the CLI; only the operator's VMM run proves KVM boot.
    const root = await mkdtemp(path.join(os.tmpdir(), 'tga-'));
    const repo = fileURLToPath(new URL('../../../', import.meta.url));
    const environmentId = randomUUID(),
      tenantId = randomUUID(),
      userId = randomUUID(),
      sessionId = randomUUID();
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const sandbox = new LocalSandbox(workspace, { envMode: 'minimal' });
    const host = new LocalSandbox(repo, { envMode: 'minimal' });
    try {
      for (const phase of ['write', 'read']) {
        const generation = randomUUID();
        const directory = path.join(root, 'jailer/firecracker', generation, 'root');
        await mkdir(directory, { recursive: true });
        const runtime = new GuestRuntime(
          environmentId,
          generation,
          async () => sandbox,
          new FileSkillCatalog(),
          () => workspace,
          120_000,
          (id, signal) =>
            openGuestBrowser(
              sandbox,
              {
                binary: process.env['ZENDRIVER_BINARY']!,
                profileRoot: path.join(root, 'profiles'),
                tenantId,
                userId,
              },
              id,
              signal,
            ),
        );
        const app = buildGuestServer(runtime);
        await app.ready();
        const bridge = createServer((socket) => {
          socket.once('data', (chunk: Buffer) => {
            if (chunk.toString() !== 'CONNECT 4050\n') {
              socket.destroy();
              return;
            }
            socket.write('OK 42\n');
            app.server.emit('connection', socket);
          });
        });
        await new Promise<void>((resolve) =>
          bridge.listen(path.join(directory, 'vsock.sock'), resolve),
        );
        try {
          const previewPath = path.join(root, `${phase}.json`);
          const result = await host.execArgv(
            process.execPath,
            [
              path.join(repo, 'apps/guest-runtime/node_modules/tsx/dist/cli.mjs'),
              path.join(repo, 'scripts/firecracker-guest-check.ts'),
              root,
              environmentId,
              generation,
              tenantId,
              userId,
              sessionId,
              phase,
              previewPath,
            ],
            { maxOutputBytes: 64 * 1024, timeoutMs: 90_000 },
          );
          expect(result, result.stderr).toMatchObject({ exitCode: 0, outputOverflow: false });
          expect(result.stdout).toContain('stale-generation rejection passed');
          expect((await readFile(`${previewPath}.png`)).subarray(0, 8)).toEqual(
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          );
          expect(
            browserPreviewSchema.parse(JSON.parse(await readFile(previewPath, 'utf8'))).state,
          ).toBe('frame');
        } finally {
          await runtime.dispose();
          app.server.closeAllConnections();
          await new Promise<void>((resolve) => bridge.close(() => resolve()));
          await app.close();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
