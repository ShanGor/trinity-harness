import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  LocalSandbox,
  RemoteSandbox,
  FileSkillCatalog,
  ZendriverMcpConnection,
  ZendriverBrowserDriver,
  captureBrowserPreview,
} from '@trinity-harness/core';
import { guestResponseSchema, type GuestRequestPort } from '@trinity-harness/contracts';
import { GuestRuntime } from '../src/runtime.js';
import { buildGuestServer } from '../src/server.js';
import { openGuestBrowser } from '../src/browser-process.js';

it.skipIf(process.env['ZENDRIVER_INTEGRATION'] !== '1')(
  'runs private Zendriver MCP through the guest RPC process channel and returns preview pixels',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'trinity-guest-zendriver-'));
    const environmentId = randomUUID(),
      generation = randomUUID(),
      sessionId = randomUUID();
    const tenantId = randomUUID(),
      userId = randomUUID();
    const sandbox = new LocalSandbox(root, { envMode: 'minimal' });
    const fixture = createServer((_request, reply) => {
      reply.setHeader('content-type', 'text/html');
      reply.end('<main><h1>Guest Zendriver</h1><p>Private MCP preview.</p></main>');
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Missing local fixture');
    const runtime = new GuestRuntime(
      environmentId,
      generation,
      async () => sandbox,
      new FileSkillCatalog(),
      () => root,
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
    const rpc: GuestRequestPort = {
      call: async (id, operation) => {
        const response = await app.inject({
          method: 'POST',
          url: '/rpc',
          payload: {
            requestId: randomUUID(),
            environmentId,
            generation,
            sessionId: id,
            workspace: 'personal',
            operation,
          },
        });
        if (response.statusCode !== 200) throw new Error(`Guest RPC failed: ${operation.kind}`);
        return guestResponseSchema.parse(response.json()).value;
      },
    };
    const remote = new RemoteSandbox(rpc, sessionId);
    const signal = AbortSignal.timeout(20_000);
    const connection = new ZendriverMcpConnection(remote.openBrowser(signal));
    try {
      await connection.initialize(signal);
      const driver = new ZendriverBrowserDriver(
        connection,
        sessionId,
        generation,
        async () => true,
      );
      await driver.open(signal);
      const url = `http://127.0.0.1:${address.port}/`;
      const context = {
        sessionId,
        callId: 'guest-preview',
        sandbox: remote,
        workspaceRoot: root,
        signal,
      };
      const binding = await driver.authorize(sessionId, 'navigate', url, signal);
      await driver.navigate(binding, url, context);
      expect(
        await captureBrowserPreview(
          driver,
          driver,
          context,
          generation,
          () => new Date('2026-10-24T00:00:00Z'),
        ),
      ).toMatchObject({ state: 'frame', securityMode: 'trusted-managed', generation });
    } finally {
      await connection.dispose();
      await runtime.dispose();
      await app.close();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
