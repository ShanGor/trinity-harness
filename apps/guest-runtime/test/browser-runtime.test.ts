import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { GuestEnvelope, GuestValue, LongRunningProcess } from '@trinity-harness/contracts';
import { BrowserGuestRuntime } from '../src/browser-runtime.js';

function fixture() {
  const environmentId = randomUUID(),
    generation = randomUUID(),
    sessionId = randomUUID();
  const request = (
    operation: GuestEnvelope['operation'],
    override: Partial<GuestEnvelope> = {},
  ): GuestEnvelope => ({
    requestId: randomUUID(),
    environmentId,
    generation,
    sessionId,
    workspace: 'personal',
    operation,
    ...override,
  });
  const lost = new AbortController();
  const desktop = {
    environment: () => ({ DISPLAY: ':9', XAUTHORITY: '/private/auth' }),
    signal: lost.signal,
    capture: vi.fn(async () => ({
      kind: 'desktopFrame' as const,
      width: 2,
      height: 1,
      capturedAt: new Date().toISOString(),
      png: 'AA==',
    })),
    input: vi.fn(async () => 'applied' as const),
    dispose: vi.fn(async () => undefined),
  };
  let finish!: (value: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    finish = resolve;
  });
  const child: LongRunningProcess = {
    write: vi.fn(),
    chunks: async function* () {
      yield new Uint8Array();
    },
    exited,
    kill: vi.fn(() => finish(null)),
  };
  const launchDesktop = vi.fn<(signal: AbortSignal) => Promise<typeof desktop>>(
    async () => desktop,
  );
  const launchBrowser = vi.fn<
    (
      session: string,
      env: Record<string, string>,
      signal: AbortSignal,
    ) => Promise<LongRunningProcess>
  >(async () => child);
  const runtime = {
    execute: vi.fn(async (envelope: GuestEnvelope, signal?: AbortSignal): Promise<GuestValue> => {
      if (envelope.operation.kind === 'browserOpen') {
        await browser.openProcess(envelope.sessionId, signal!);
        return { kind: 'process', processId: randomUUID() };
      }
      if (envelope.operation.kind === 'processKill') {
        child.kill();
        await child.exited;
      }
      return { kind: 'ok' };
    }),
    dispose: vi.fn(async () => {
      child.kill();
      await child.exited;
    }),
  };
  const browser = new BrowserGuestRuntime(
    environmentId,
    generation,
    runtime,
    launchDesktop,
    launchBrowser,
  );
  return { browser, request, runtime, desktop, launchDesktop, launchBrowser, child, lost };
}

it('binds private desktop operations to the browser session, workspace and guest generation', async () => {
  const f = fixture();
  try {
    await expect(f.browser.execute(f.request({ kind: 'desktopFrame' }))).rejects.toThrow(
      'ownership',
    );
    await expect(f.browser.execute(f.request({ kind: 'browserOpen' }))).resolves.toMatchObject({
      kind: 'process',
    });
    expect(f.launchBrowser).toHaveBeenCalledWith(
      expect.any(String),
      { DISPLAY: ':9', XAUTHORITY: '/private/auth' },
      expect.any(AbortSignal),
    );
    await expect(f.browser.execute(f.request({ kind: 'desktopFrame' }))).resolves.toMatchObject({
      kind: 'desktopFrame',
      width: 2,
    });
    await expect(
      f.browser.execute(
        f.request({
          kind: 'desktopInput',
          action: { type: 'key', key: 'Enter', modifiers: [] },
          target: { width: 2, height: 1, focusRevision: '1' },
        }),
      ),
    ).resolves.toEqual({ kind: 'desktopInput', effect: 'applied' });
    await expect(
      f.browser.execute(f.request({ kind: 'desktopFrame' }, { workspace: 'other' })),
    ).rejects.toThrow('ownership');
    await expect(
      f.browser.execute(f.request({ kind: 'desktopFrame' }, { sessionId: randomUUID() })),
    ).rejects.toThrow('ownership');
    await expect(
      f.browser.execute(f.request({ kind: 'desktopFrame' }, { generation: randomUUID() })),
    ).rejects.toThrow('generation');
    await expect(
      f.browser.execute(f.request({ kind: 'read', path: 'file', maxBytes: 1 })),
    ).rejects.toThrow('browser endpoint');
    await expect(f.browser.execute(f.request({ kind: 'browserOpen' }))).rejects.toThrow(
      'already allocated',
    );
    expect(f.desktop.input).toHaveBeenCalledTimes(1);
  } finally {
    await f.browser.dispose();
  }
  expect(f.desktop.dispose).toHaveBeenCalledTimes(1);
});

it('kills the managed browser if its desktop exits', async () => {
  const f = fixture();
  try {
    await f.browser.execute(f.request({ kind: 'browserOpen' }));
    f.lost.abort();
    await f.child.exited;
    expect(f.child.kill).toHaveBeenCalled();
    await expect(f.browser.execute(f.request({ kind: 'desktopFrame' }))).rejects.toThrow();
  } finally {
    await f.browser.dispose();
  }
  expect(f.desktop.dispose).toHaveBeenCalledTimes(1);
});

it('waits for a cancelled allocation and disposes its late desktop without launching Chrome', async () => {
  const f = fixture();
  let complete!: (desktop: typeof f.desktop) => void;
  f.launchDesktop.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const opening = f.browser.execute(f.request({ kind: 'browserOpen' }));
  await vi.waitFor(() => expect(complete).toBeDefined());
  const closing = f.browser.dispose();
  complete(f.desktop);
  await expect(opening).rejects.toThrow();
  await closing;
  expect(f.desktop.dispose).toHaveBeenCalledTimes(1);
  expect(f.launchBrowser).not.toHaveBeenCalled();
});
