import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LocalSandbox,
  LocalBlobStore,
  MemorySessionStore,
  createBrowserTool,
  ZendriverMcpConnection,
  ZendriverBrowserDriver,
  captureBrowserPreview,
} from '../src/index.js';
import {
  browserResultSchema,
  type ToolContext,
  type BrowserBinding,
  type BrowserArguments,
} from '@trinity-harness/contracts';

describe.skipIf(process.env['ZENDRIVER_INTEGRATION'] !== '1')(
  'Zendriver pinned Chrome compatibility (local fixture only)',
  () => {
    let root: string;
    let connection: ZendriverMcpConnection;
    let driver: ZendriverBrowserDriver;
    let context: ToolContext;
    let binding: BrowserBinding;
    let url: string;
    const generation = randomUUID();
    const sessionId = randomUUID();
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(
        '<!doctype html><main><h1>Evidence 😀</h1><p>Exact “quote”：世界.</p><input aria-label="Search" value="old"><button onclick="document.querySelector(\'p\').textContent=\'Clicked\'">Apply</button></main>',
      );
    });
    beforeAll(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), 'trinity-zendriver-'));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No fixture address');
      url = `http://127.0.0.1:${address.port}/`;
      const sandbox = new LocalSandbox(root);
      connection = new ZendriverMcpConnection(
        sandbox.openProcess(
          process.env['ZENDRIVER_BINARY'] ?? 'zendriver-mcp',
          ['--log', 'off', '--user-data-dir', path.join(root, 'profile')],
          {
            processGroup: true,
            env: { TMPDIR: root },
          },
        ),
      );
      driver = new ZendriverBrowserDriver(connection, sessionId, generation, async () => true);
      context = {
        sandbox,
        workspaceRoot: root,
        sessionId,
        callId: 'fixture',
        signal: AbortSignal.timeout(20_000),
      };
      await connection.initialize(context.signal);
      await driver.open(context.signal);
      binding = await driver.authorize(sessionId, 'navigate', url, context.signal);
      await driver.navigate(binding, url, context);
      binding = await driver.authorize(sessionId, 'read_page', undefined, context.signal);
    }, 30_000);
    afterAll(async () => {
      await connection?.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (root) await rm(root, { recursive: true, force: true });
    });
    it('captures user-facing previews with Zendriver and suppresses sensitive pages', async () => {
      const preview = () =>
        captureBrowserPreview(
          driver,
          driver,
          context,
          generation,
          () => new Date('2026-10-24T00:00:00Z'),
        );
      const frame = await preview();
      expect(frame).toMatchObject({ state: 'frame', generation, securityMode: 'trusted-managed' });
      if (frame.state !== 'frame') throw new Error('Zendriver preview did not return pixels');
      expect(Buffer.from(frame.png, 'base64').subarray(1, 4).toString()).toBe('PNG');
      await connection.call(
        'browser_evaluate',
        { expression: 'document.querySelector("input").type = "password"' },
        context.signal,
      );
      expect(await preview()).toEqual({ state: 'privacy_blocked' });
      await connection.call(
        'browser_evaluate',
        { expression: 'document.querySelector("input").type = "text"' },
        context.signal,
      );
    });
    it('preserves exact Unicode text, replaces input, dispatches native click, and returns bounded PNG', async () => {
      const capture = await driver.capture(binding, 'article', undefined, context);
      expect(capture.blocks.map((block) => block.text)).toContain('Exact “quote”：世界.');
      const surface = await driver.surface(binding, 'interactive', undefined, context);
      const input = surface.targets.find((target) => target.role === 'textbox')!;
      const button = surface.targets.find((target) => target.role === 'button')!;
      expect(input).toBeDefined();
      await driver.act(
        binding,
        { operation: 'fill', path: input.path, text: 'replacement' },
        context,
      );
      const evaluated = await connection.call(
        'browser_evaluate',
        { expression: 'document.querySelector("input").value' },
        context.signal,
      );
      expect(evaluated.structuredContent).toEqual({ value: 'replacement' });
      await driver.act(binding, { operation: 'key', path: input.path, key: 'ArrowLeft' }, context);
      await driver.act(binding, { operation: 'click', path: button.path }, context);
      expect(await driver.readiness(binding, 'Clicked', 1000, context)).toBe('ready');
      expect(
        (await driver.capture(binding, 'article', undefined, context)).blocks.map(
          (block) => block.text,
        ),
      ).toContain('Clicked');
      const png = await driver.screenshot(binding, context);
      expect(Buffer.from(png).subarray(1, 4).toString()).toBe('PNG');
      expect(png.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    });
    it('runs the evidence pipeline and replays saved images offline', async () => {
      const store = new MemorySessionStore();
      const blobs = new LocalBlobStore(path.join(root, 'blobs'));
      const tool = createBrowserTool({
        store,
        blobs,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        access: driver,
        driver,
      });
      const event = () => ({ eventId: randomUUID(), at: '2026-01-01T00:00:00.000Z' });
      await store.append(sessionId, [
        {
          ...event(),
          type: 'message/user',
          surfaceOp: 'append',
          content: [{ kind: 'text', text: 'Inspect the fixture' }],
        },
      ]);
      const run = async (args: BrowserArguments) => {
        const callId = randomUUID();
        await store.append(sessionId, [
          { ...event(), type: 'tool/call', callId, name: 'browser', args },
        ]);
        const result = await tool.execute(args, { ...context, callId, permissionGranted: true });
        expect(result.isError).toBe(false);
        await store.append(sessionId, [{ ...event(), type: 'tool/result', callId, ...result }]);
        return browserResultSchema.parse(result.value);
      };
      const captured = await run({ operation: 'navigate', url });
      expect(captured.blocks.some((block) => block.text.includes('Exact “quote”：世界.'))).toBe(
        true,
      );
      expect(captured.driver?.engine).toBe('zendriver');
      const page = await run({ operation: 'read_page', filter: 'interactive' });
      const button = page.snapshot!.targets.find((target) => target.role === 'button')!;
      const clicked = await run({
        operation: 'click',
        snapshotId: page.snapshot!.snapshotId,
        ref: button.ref,
        readiness: { text: 'Clicked', timeoutMs: 1000 },
      });
      expect(clicked.blocks.some((block) => block.text === 'Clicked')).toBe(true);
      const image = await run({ operation: 'screenshot' });
      expect(image.image?.bytes).toBeGreaterThan(0);
      const offline = createBrowserTool({
        store,
        blobs,
        now: () => new Date('2026-01-02T00:00:00.000Z'),
      });
      const restored = browserResultSchema.parse(
        (
          await offline.execute(
            { operation: 'read_observation', observationId: image.observationId },
            { ...context, callId: randomUUID() },
          )
        ).value,
      );
      expect(restored.saved).toBe(true);
      expect(restored.image).toEqual(image.image);
      expect(restored.capturedAt).toBe(image.capturedAt);
    });
  },
);
