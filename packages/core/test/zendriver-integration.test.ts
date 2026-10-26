import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  type BrowserHumanAction,
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
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.url === '/drag') {
        response.end(`<!doctype html><style>
          #source,#drop,#slider {position:absolute;top:40px;width:120px;height:100px}
          #source {left:20px;background:coral} #drop {left:300px;background:lightblue}
          #slider {top:200px;left:20px;width:400px}
        </style><div id="source" draggable="true">Move me</div><div id="drop">Drop here</div>
        <input id="slider" type="range" min="0" max="100" value="0">
        <button id="nativeclick" style="position:absolute;top:350px;left:20px;width:120px;height:60px"
          onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1);this.dataset.shift=String(event.shiftKey)"
          ondblclick="this.dataset.double='true'">Click</button>
        <script>
          source.ondragstart=e=>e.dataTransfer.setData('text/plain','item');
          drop.ondragover=e=>e.preventDefault();
          drop.ondrop=e=>{e.preventDefault();drop.textContent=e.dataTransfer.getData('text/plain');drop.dataset.trusted=String(e.isTrusted)};
        </script>`);
        return;
      }
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
    it('keeps evidence in its originating chat when two source drivers share one browser connection', async () => {
      const sideId = randomUUID();
      const sideDriver = new ZendriverBrowserDriver(
        connection,
        sideId,
        generation,
        async () => true,
      );
      const store = new MemorySessionStore();
      const blobs = new LocalBlobStore(path.join(root, 'shared-source-blobs'));
      const mainTool = createBrowserTool({
        store,
        blobs,
        now: () => new Date(),
        driver,
        access: driver,
      });
      const sideTool = createBrowserTool({
        store,
        blobs,
        now: () => new Date(),
        driver: sideDriver,
        access: sideDriver,
      });
      const mainContext = { ...context, callId: randomUUID(), signal: AbortSignal.timeout(20_000) };
      const main = browserResultSchema.parse(
        (await mainTool.execute({ operation: 'navigate', url }, mainContext)).value,
      );
      await store.append(sessionId, [
        {
          type: 'tool/call',
          eventId: randomUUID(),
          at: new Date().toISOString(),
          callId: mainContext.callId,
          name: 'browser',
          args: { operation: 'navigate', url },
        },
        {
          type: 'tool/result',
          eventId: randomUUID(),
          at: new Date().toISOString(),
          callId: mainContext.callId,
          isError: false,
          value: main,
        },
      ]);
      const sideContext = { ...mainContext, sessionId: sideId, callId: randomUUID() };
      const side = browserResultSchema.parse(
        (await sideTool.execute({ operation: 'read_page', filter: 'all' }, sideContext)).value,
      );
      expect(side.sessionId).toBe(sideId);
      expect(side.artifactUri).toContain(`/${sideId}/`);
      expect(side.bindingId).not.toBe(main.bindingId);
      expect(side.tabId).toBe(main.tabId);
      expect(side.driver?.runtimeGeneration).toBe(main.driver?.runtimeGeneration);
      expect(side.blocks.some((block) => block.text.includes('Exact “quote”：世界.'))).toBe(true);
      const denied = await sideTool.execute(
        { operation: 'read_observation', observationId: main.observationId },
        { ...sideContext, callId: randomUUID() },
      );
      expect(denied.isError).toBe(true);
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
    it('captures private user frames and applies native human coordinates and focused typing', async () => {
      const ctx = { ...context, signal: AbortSignal.timeout(20_000) };
      await driver.navigate(
        await driver.authorize(sessionId, 'navigate', url, ctx.signal),
        url,
        ctx,
      );
      const live = await driver.authorize(sessionId, 'read_page', undefined, ctx.signal);
      const surface = await driver.surface(live, 'interactive', undefined, ctx);
      const input = surface.targets.find((target) => target.role === 'textbox')!;
      const button = surface.targets.find((target) => target.role === 'button')!;
      const frame = async () => {
        const captured = await driver.humanFrame(true, ctx, () => new Date());
        expect(captured.preview.state).toBe('frame');
        if (!captured.target) throw new Error('No human frame target');
        return { ...captured.target, frameId: randomUUID() };
      };
      const point = (target: typeof input) => ({
        x: target.box.x + target.box.width / 2,
        y: target.box.y + target.box.height / 2,
      });
      const clicked = await driver.humanInput(
        { type: 'click', point: point(input), button: 'left', count: 1, modifiers: [] },
        await frame(),
        ctx,
      );
      if (clicked.effect !== 'applied' || !clicked.keyboard) throw new Error('No keyboard target');
      const selected = await driver.humanInput(
        { type: 'key', key: 'a', modifiers: ['ctrl'] },
        clicked.keyboard,
        ctx,
      );
      if (selected.effect !== 'applied' || !selected.keyboard)
        throw new Error('No keyboard target');
      const typed = await driver.humanInput(
        { type: 'text', text: 'Human 世界' },
        selected.keyboard,
        ctx,
      );
      expect(typed.effect).toBe('applied');
      expect(
        (
          await connection.call(
            'browser_evaluate',
            { expression: 'document.querySelector("input").value' },
            ctx.signal,
          )
        ).structuredContent,
      ).toEqual({ value: 'Human 世界' });
      await driver.humanInput(
        { type: 'click', point: point(button), button: 'left', count: 1, modifiers: [] },
        await frame(),
        ctx,
      );
      expect(await driver.readiness(live, 'Clicked', 1000, ctx)).toBe('ready');
      await connection.call(
        'browser_evaluate',
        { expression: 'document.querySelector("input").type = "password"' },
        ctx.signal,
      );
      expect((await driver.humanFrame(false, ctx, () => new Date())).preview.state).toBe(
        'privacy_blocked',
      );
      expect((await driver.humanFrame(true, ctx, () => new Date())).preview.state).toBe('frame');
      await connection.call(
        'browser_evaluate',
        { expression: 'document.querySelector("input").type = "text"' },
        ctx.signal,
      );
    });
    it('moves a native HTML draggable into its drop target and drags a slider', async () => {
      const ctx = { ...context, signal: AbortSignal.timeout(20_000) };
      await driver.navigate(binding, `${url}drag`, ctx);
      const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
        const captured = await driver.humanFrame(true, ctx);
        if (!captured.target) throw new Error('Missing drag frame');
        expect(
          await driver.humanInput(
            { type: 'drag', from, to },
            { ...captured.target, frameId: randomUUID() },
            ctx,
          ),
        ).toMatchObject({ effect: 'applied' });
      };
      await drag({ x: 80, y: 90 }, { x: 360, y: 90 });
      expect(
        (
          await connection.call(
            'browser_evaluate',
            {
              expression:
                '({text:document.querySelector("#drop").textContent,trusted:document.querySelector("#drop").dataset.trusted})',
            },
            ctx.signal,
          )
        ).structuredContent,
      ).toEqual({ value: { text: 'item', trusted: 'true' } });
      await drag({ x: 30, y: 250 }, { x: 400, y: 250 });
      const slider = await connection.call(
        'browser_evaluate',
        {
          expression: 'Number(document.querySelector("#slider").value)>90',
        },
        ctx.signal,
      );
      expect(slider.structuredContent).toEqual({ value: true });
      const click = async (count: 1 | 2, shift = false): Promise<void> => {
        const captured = await driver.humanFrame(true, ctx);
        if (!captured.target) throw new Error('Missing click frame');
        expect(
          await driver.humanInput(
            {
              type: 'click',
              point: { x: 80, y: 380 },
              button: 'left',
              count,
              modifiers: shift ? ['shift'] : [],
            },
            { ...captured.target, frameId: randomUUID() },
            ctx,
          ),
        ).toMatchObject({ effect: 'applied' });
      };
      await click(1);
      await click(2);
      expect(
        (
          await connection.call(
            'browser_evaluate',
            {
              expression: '({...document.querySelector("#nativeclick").dataset})',
            },
            ctx.signal,
          )
        ).structuredContent,
      ).toEqual({ value: { clicks: '2', double: 'true', shift: 'false' } });
      await click(1, true);
      expect(
        (
          await connection.call(
            'browser_evaluate',
            {
              expression: 'document.querySelector("#nativeclick").dataset.shift',
            },
            ctx.signal,
          )
        ).structuredContent,
      ).toEqual({ value: 'true' });
      await driver.navigate(binding, url, ctx);
    });
    it('captures a private frame with bounded viewer tab metadata', async () => {
      const calls = vi.spyOn(connection, 'call');
      try {
        expect(
          (await driver.humanFrame(true, { ...context, signal: AbortSignal.timeout(20_000) }))
            .preview.state,
        ).toBe('frame');
        expect(calls.mock.calls.map(([name]) => name)).toEqual([
          'browser_status',
          'browser_evaluate',
          'browser_evaluate',
          'browser_screenshot',
          'browser_status',
          'browser_evaluate',
          'browser_tab_list',
        ]);
      } finally {
        calls.mockRestore();
      }
    });
    it('navigates history and manages tabs while fencing stale targets', async () => {
      const ctx = { ...context, signal: AbortSignal.timeout(30_000) };
      const frame = async () => {
        const captured = await driver.humanFrame(true, ctx);
        if (!captured.target || !captured.browser) throw new Error('Missing browser frame');
        return { ...captured, target: { ...captured.target, frameId: randomUUID() } };
      };
      const input = async (action: BrowserHumanAction) => {
        expect(await driver.humanInput(action, (await frame()).target, ctx)).toEqual({
          effect: 'applied',
        });
      };
      const original = await frame();
      const originalId = original.target.tabId;
      await input({ type: 'navigate', url: `${url}?second` });
      await input({ type: 'back' });
      expect((await frame()).browser!.tabs.find((tab) => tab.active)?.url).toBe(url);
      await input({ type: 'forward' });
      expect((await frame()).browser!.tabs.find((tab) => tab.active)?.url).toBe(`${url}?second`);
      await input({ type: 'reload' });
      await input({ type: 'new_tab' });
      const created = await frame();
      expect(created.browser!.tabs).toHaveLength(2);
      const newId = created.target.tabId;
      expect(newId).not.toBe(originalId);
      expect(
        (await captureBrowserPreview(driver, driver, ctx, generation, () => new Date())).state,
      ).toBe('frame');
      await input({ type: 'back' });
      await input({ type: 'forward' });
      expect(await driver.humanInput({ type: 'reload' }, original.target, ctx)).toEqual({
        effect: 'none',
      });
      await input({ type: 'switch_tab', tabId: originalId });
      expect((await frame()).target.tabId).toBe(originalId);
      await input({ type: 'switch_tab', tabId: newId });
      await input({ type: 'close_tab', tabId: newId });
      const closed = await frame();
      expect(closed.target.tabId).toBe(originalId);
      expect(closed.browser!.tabs).toHaveLength(1);
      await input({ type: 'navigate', url });
    }, 35_000);
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
