import { createServer, type Server } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LocalSandbox,
  ZendriverBrowserDriver,
  ZendriverMcpConnection,
  ZendriverOperationGate,
  ManagedBrowserSupervisor,
  browserRuntimeFailure,
} from '@trinity-harness/core';
import type {
  BrowserControlRecord,
  BrowserInputRecord,
  BrowserInteractionStore,
  BrowserRuntimeStore,
  BrowserRuntimeRecord,
  BrowserCommandRecord,
  BrowserRuntimeRequest,
  ToolContext,
} from '@trinity-harness/contracts';
import { GuestDesktop } from '../src/desktop.js';

const enabled = process.env['DESKTOP_INTEGRATION'] === '1';
describe.skipIf(!enabled)('disposable headed Chrome and desktop dialog feasibility', () => {
  let root: string;
  let desktop: GuestDesktop;
  let server: Server;
  let connection: ZendriverMcpConnection;
  let driver: ZendriverBrowserDriver;
  let context: ToolContext;
  let width: number;
  let url: string;
  const signal = AbortSignal.timeout(60_000);
  beforeAll(async () => {
    const xvfb = process.env['DESKTOP_XVFB'];
    const x11vnc = process.env['DESKTOP_X11VNC'];
    const xdotool = process.env['DESKTOP_XDOTOOL'];
    const xwd = process.env['DESKTOP_XWD'];
    const xclip = process.env['DESKTOP_XCLIP'];
    const binary = process.env['ZENDRIVER_BINARY'];
    if (
      !xvfb ||
      !x11vnc ||
      !xdotool ||
      !xwd ||
      !xclip ||
      !binary ||
      ![xvfb, x11vnc, xdotool, xwd, xclip, binary].every(path.isAbsolute)
    )
      throw new Error('Desktop fixture binaries must be absolute');
    root = await mkdtemp(path.join(os.tmpdir(), 'trinity-desktop-test-'));
    const sandbox = new LocalSandbox(root);
    const manager = path.join(root, 'window-manager');
    await writeFile(manager, '#!/bin/sh\nexec /bin/sleep 180\n');
    await chmod(manager, 0o700);
    const libraryPath = process.env['LD_LIBRARY_PATH'];
    desktop = await GuestDesktop.launch(
      sandbox,
      {
        runtimeDirectory: root,
        xvfb,
        x11vnc,
        xdotool,
        xwd,
        xclip,
        windowManager: manager,
        ...(libraryPath ? { env: { LD_LIBRARY_PATH: libraryPath } } : {}),
      },
      signal,
    );
    width = (await desktop.capture(signal)).width;
    server = createServer((_req, response) =>
      response.end(
        `<!doctype html><style>button { display:block; width:200px; height:100px }</style>
        <button onclick="document.body.dataset.answer=prompt('Fixture prompt','default')">Prompt</button>
        <button onclick="alert('Fixture alert'); document.body.dataset.alert='done'">Alert</button>
        <button onclick="document.body.dataset.confirm=confirm('Fixture confirm')">Confirm</button>`,
      ),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture address');
    url = `http://127.0.0.1:${address.port}/`;
    const sessionId = randomUUID();
    connection = new ZendriverMcpConnection(
      sandbox.openProcess(binary, ['--log', 'off', '--user-data-dir', path.join(root, 'profile')], {
        processGroup: true,
        env: desktop.environment(),
      }),
    );
    driver = new ZendriverBrowserDriver(connection, sessionId, randomUUID(), async () => true);
    context = { sandbox, workspaceRoot: root, sessionId, callId: 'fixture', signal };
    await connection.initialize(signal);
    await driver.open(signal, '155.0.8059.84', false);
    await connection.call(
      'browser_goto',
      { url, wait_for: 'load', return_snapshot: false },
      signal,
    );
  }, 40_000);
  afterAll(async () => {
    await connection?.dispose();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await desktop?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const send = async (action: Parameters<GuestDesktop['input']>[0]): Promise<void> => {
    const frame = await desktop.capture(signal);
    expect(
      await desktop.input(
        action,
        {
          width: frame.width,
          height: frame.height,
          ...(frame.focusRevision ? { focusRevision: frame.focusRevision } : {}),
        },
        signal,
      ),
    ).toBe('applied');
  };
  it('shows a prompt while the browser call is blocked, then returns after desktop input', async () => {
    const captured = await driver.humanFrame(true, context);
    expect(captured.preview.state).toBe('frame');
    if (!captured.target) throw new Error('No browser fixture target');
    const before = PNG.sync.read(Buffer.from((await desktop.capture(signal)).png, 'base64')).data;
    let resolved = false;
    const input = driver
      .humanInput(
        { type: 'click', point: { x: 40, y: 40 }, button: 'left', count: 1, modifiers: [] },
        { ...captured.target, frameId: randomUUID() },
        context,
      )
      .then((result) => {
        resolved = true;
        return result;
      });
    // A changed desktop is necessary but not sufficient to establish a dialog;
    // the still-blocked driver and the returned prompt value complete the test.
    await expect
      .poll(
        async () => {
          const after = PNG.sync.read(
            Buffer.from((await desktop.capture(signal)).png, 'base64'),
          ).data;
          let changed = 0;
          for (let y = 100; y < 300; y++)
            for (let x = 300; x < 760; x++) {
              const i = (y * width + x) * 4;
              if (Math.abs(after[i]! - before[i]!) > 40) changed++;
            }
          return changed;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(10_000);
    expect(resolved).toBe(false);
    await send({ type: 'key', key: 'a', modifiers: ['ctrl'] });
    await send({ type: 'text', text: 'A中🙂' });
    await send({ type: 'key', key: 'Enter', modifiers: [] });
    expect(await input).toMatchObject({ effect: 'applied' });
    expect(
      (
        await connection.call(
          'browser_evaluate',
          { expression: 'document.body.dataset.answer' },
          signal,
        )
      ).structuredContent,
    ).toEqual({ value: 'A中🙂' });
  }, 35_000);
  it('dismisses an alert and accepts or cancels a confirmation and prompt', async () => {
    const dismiss = async (y: number, key: 'Enter' | 'Escape'): Promise<void> => {
      const captured = await driver.humanFrame(true, context);
      if (!captured.target) throw new Error('No browser fixture target');
      const before = PNG.sync.read(Buffer.from((await desktop.capture(signal)).png, 'base64')).data;
      let resolved = false;
      const input = driver
        .humanInput(
          { type: 'click', point: { x: 40, y }, button: 'left', count: 1, modifiers: [] },
          { ...captured.target, frameId: randomUUID() },
          context,
        )
        .then((result) => {
          resolved = true;
          return result;
        });
      await expect
        .poll(
          async () => {
            const after = PNG.sync.read(
              Buffer.from((await desktop.capture(signal)).png, 'base64'),
            ).data;
            let changed = 0;
            for (let row = 100; row < 300; row++)
              for (let col = 300; col < 760; col++) {
                const i = (row * width + col) * 4;
                if (Math.abs(after[i]! - before[i]!) > 40) changed++;
              }
            return changed;
          },
          { timeout: 15_000 },
        )
        .toBeGreaterThan(10_000);
      expect(resolved).toBe(false);
      await send({ type: 'key', key, modifiers: [] });
      expect(await input).toMatchObject({ effect: 'applied' });
    };
    const value = async (name: 'alert' | 'confirm' | 'answer'): Promise<unknown> =>
      (
        await connection.call(
          'browser_evaluate',
          { expression: `document.body.dataset.${name}` },
          signal,
        )
      ).structuredContent;
    await dismiss(140, 'Enter');
    expect(await value('alert')).toEqual({ value: 'done' });
    await dismiss(240, 'Enter');
    expect(await value('confirm')).toEqual({ value: 'true' });
    await dismiss(240, 'Escape');
    expect(await value('confirm')).toEqual({ value: 'false' });
    await dismiss(40, 'Escape');
    expect(await value('answer')).toEqual({ value: 'null' });
  }, 45_000);

  it('lets the supervisor take control and dismiss a real dialog during a blocked agent call', async () => {
    const sessionId = randomUUID(),
      viewId = randomUUID(),
      generation = randomUUID();
    let binding: BrowserRuntimeRecord | null = null;
    const commands = new Map<string, BrowserCommandRecord>();
    const tails = new Map<string, Promise<void>>();
    const journal: BrowserRuntimeStore = {
      async run<T>(
        id: string,
        action: (signal: AbortSignal) => Promise<T>,
        active?: AbortSignal,
      ): Promise<T> {
        const previous = tails.get(id) ?? Promise.resolve();
        let done!: () => void;
        tails.set(
          id,
          new Promise<void>((resolve) => {
            done = resolve;
          }),
        );
        await previous;
        try {
          return await action(active ?? new AbortController().signal);
        } finally {
          done();
        }
      },
      binding: async () => binding,
      bind: async (record) => {
        binding = record;
      },
      command: async (_session, id) => commands.get(id) ?? null,
      begin: async (_session, id, hash) => {
        commands.set(id, { hash, result: null });
      },
      finish: async (_session, id, result) => {
        commands.get(id)!.result = result;
      },
    };
    let control: BrowserControlRecord | null = null;
    const inputs = new Map<string, BrowserInputRecord>();
    const controls: BrowserInteractionStore = {
      get: async () => (control ? structuredClone(control) : null),
      put: async (record) => {
        control = structuredClone(record);
      },
      input: async (_session, id) => inputs.get(id) ?? null,
      reserve: async (record, id, sourceSessionId) => {
        control = structuredClone(record);
        inputs.set(id, {
          sourceSessionId,
          generation: record.generation,
          epoch: record.epoch,
          sequence: record.sequence,
          viewId: record.controllerId!,
          effect: 'unknown',
        });
      },
      finish: async (_session, id, effect) => {
        inputs.get(id)!.effect = effect;
      },
    };
    let gate: ZendriverOperationGate | undefined;
    let dispatched!: () => void;
    const started = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const supervisor = new ManagedBrowserSupervisor({
      store: journal,
      interactionStore: controls,
      owner: randomUUID(),
      authorize: async () => true,
      authorizePreview: async () => true,
      maxSessions: 1,
      idleMs: 300_000,
      create: async () => ({
        generation,
        execute: async (request, active) => {
          gate = new ZendriverOperationGate(connection);
          try {
            const pending = gate.call(
              'browser_mouse',
              {
                action: 'click',
                x: 40,
                y: 40,
                button: 'left',
                click_count: 1,
                immediate: true,
                modifiers: [],
                return_snapshot: false,
              },
              active,
            );
            dispatched();
            await pending;
            await gate.call('browser_evaluate', { expression: 'true' }, active);
          } catch {
            return browserRuntimeFailure(request, 'NOT_EXECUTED', 'unknown');
          } finally {
            gate = undefined;
          }
          return browserRuntimeFailure(request, 'DRIVER_FAILED', 'unknown');
        },
        fenceAgent: () => {
          if (!gate) return false;
          gate.fence();
          return true;
        },
        humanFrame: async (privateView, active) => {
          if (!privateView) return { preview: { state: 'privacy_blocked' } };
          const capturedAt = new Date().toISOString();
          const picture = await desktop.capture(active);
          return {
            surface: 'desktop',
            preview: {
              state: 'frame',
              generation,
              capturedAt,
              securityMode: 'trusted-managed',
              width: picture.width,
              height: picture.height,
              png: picture.png,
            },
            target: {
              tabId: 'desktop',
              documentRevision: generation,
              fingerprint: 'a'.repeat(64),
              width: picture.width,
              height: picture.height,
              capturedAt,
              ...(picture.focusRevision ? { focusRevision: picture.focusRevision } : {}),
            },
          };
        },
        humanHandoff: async () => ({
          preview: { state: 'unavailable' },
          handoff: 'navigation_only',
        }),
        humanInput: async (action, target, active) => {
          if (!('frameId' in target) || action.type !== 'key') return { effect: 'none' };
          const effect = await desktop.input(
            action,
            {
              width: target.width,
              height: target.height,
              ...(target.focusRevision ? { focusRevision: target.focusRevision } : {}),
            },
            active,
          );
          return { effect };
        },
        dispose: async () => {},
      }),
    });
    const command: BrowserRuntimeRequest = {
      sessionId,
      callId: randomUUID(),
      args: { operation: 'navigate', url: 'https://example.com/' },
      permissionGranted: false,
    };
    const before = PNG.sync.read(Buffer.from((await desktop.capture(signal)).png, 'base64'));
    const agent = supervisor.execute(command, signal);
    try {
      await started;
      let view = await supervisor.interact({ sessionId, viewId, operation: 'take' }, signal);
      expect(view.frame?.surface).toBe('desktop');
      await expect
        .poll(
          async () => {
            view = await supervisor.interact({ sessionId, viewId, operation: 'frame' }, signal);
            if (!view.frame) return 0;
            const after = PNG.sync.read(Buffer.from(view.frame.png, 'base64'));
            let changed = 0;
            for (let i = 0; i < after.data.length; i += 4)
              if (Math.abs(after.data[i]! - before.data[i]!) > 40) changed++;
            return changed;
          },
          { timeout: 15_000 },
        )
        .toBeGreaterThan(10_000);
      expect(view.frame).toBeDefined();
      const input = await supervisor.interact(
        {
          sessionId,
          viewId,
          operation: 'input',
          generation,
          epoch: view.state.epoch,
          sequence: view.state.nextSequence,
          requestId: randomUUID(),
          frameId: view.frame!.frameId,
          action: { type: 'key', key: 'Enter', modifiers: [] },
        },
        signal,
      );
      expect(input.input?.effect).toBe('applied');
      const release = {
        sessionId,
        viewId,
        operation: 'release' as const,
        generation,
        epoch: input.state.epoch,
      };
      await expect
        .poll(async () => (await supervisor.interact(release, signal)).state.mode, {
          timeout: 10_000,
        })
        .toBe('agent');
      expect((await agent).value).toMatchObject({ effect: 'unknown' });
      expect(
        (
          await connection.call(
            'browser_evaluate',
            { expression: 'document.body.dataset.answer' },
            signal,
          )
        ).structuredContent,
      ).toEqual({ value: 'default' });
    } finally {
      await supervisor.dispose();
    }
  }, 40_000);
});
