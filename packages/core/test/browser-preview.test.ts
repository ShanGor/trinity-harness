import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import type {
  BrowserDriverPort,
  BrowserAccessPort,
  BrowserBinding,
  BrowserSurface,
} from '@trinity-harness/contracts';
import {
  captureBrowserPreview,
  captureCommittedCdpPreview,
  MemorySessionStore,
} from '../src/index.js';
import { FakeSandbox } from '../src/testing/index.js';

function fixture() {
  const binding: BrowserBinding = {
    bindingId: 'binding',
    tabId: 'tab',
    documentRevision: 'doc',
    cliVersion: '0.38.2',
    browserVersion: 'Chrome',
    cliSession: 'session',
    observedUrl: 'https://example.com/',
    securityMode: 'trusted-managed',
  };
  const surface: BrowserSurface = {
    context: {
      width: 2,
      height: 2,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      locale: 'en',
      timezone: 'UTC',
    },
    targets: [],
    truncated: false,
    privacyDenied: false,
  };
  const access: BrowserAccessPort = { authorize: vi.fn(async () => ({ ...binding })) };
  const driver: BrowserDriverPort = {
    verify: vi.fn(async () => {}),
    surface: vi.fn(async () => structuredClone(surface)),
    paint: vi.fn(async () => 'ready' as const),
    screenshot: vi.fn(async () => PNG.sync.write(new PNG({ width: 2, height: 2 }))),
    capture: vi.fn(),
    navigate: vi.fn(),
    act: vi.fn(),
    pointAllowed: vi.fn(),
    readiness: vi.fn(),
    accessibility: vi.fn(),
  };
  const ctx = {
    sessionId: randomUUID(),
    callId: 'preview',
    sandbox: new FakeSandbox(),
    workspaceRoot: '/workspace',
    signal: new AbortController().signal,
  };
  const generation = randomUUID();
  return {
    binding,
    surface,
    driver,
    access,
    ctx,
    generation,
    run: () =>
      captureBrowserPreview(
        access,
        driver,
        ctx,
        generation,
        () => new Date('2026-10-24T00:00:00Z'),
      ),
  };
}
describe('ephemeral browser preview', () => {
  it('never attaches a CDP viewer without a committed owned-tab delivery', async () => {
    const f = fixture();
    expect(
      await captureCommittedCdpPreview(
        new MemorySessionStore(),
        f.access,
        f.driver,
        f.ctx,
        () => new Date('2026-10-24T00:00:00Z'),
      ),
    ).toEqual({ state: 'unavailable' });
    expect(f.access.authorize).not.toHaveBeenCalled();
    expect(f.driver.screenshot).not.toHaveBeenCalled();
  });
  it('returns bounded pixels and provenance without artifacts, evidence or target refs', async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({
      state: 'frame',
      generation: f.generation,
      capturedAt: '2026-10-24T00:00:00.000Z',
      width: 2,
      height: 2,
    });
    expect(f.access.authorize).toHaveBeenCalledTimes(2);
    expect(f.driver.act).not.toHaveBeenCalled();
    expect(f.driver.capture).not.toHaveBeenCalled();
  });
  it('checks sensitive URL and forms before taking pixels', async () => {
    const f = fixture();
    f.binding.observedUrl = 'https://example.com/?token=private';
    expect(await f.run()).toEqual({ state: 'privacy_blocked' });
    expect(f.driver.screenshot).not.toHaveBeenCalled();
    f.binding.observedUrl = 'https://example.com/';
    f.surface.privacyDenied = true;
    expect(await f.run()).toEqual({ state: 'privacy_blocked' });
    expect(f.driver.screenshot).not.toHaveBeenCalled();
  });
  it('allows an empty managed tab to be handed back while denying arbitrary internal pages', async () => {
    const f = fixture();
    f.binding.observedUrl = 'about:blank';
    expect(await f.run()).toMatchObject({ state: 'frame' });
    expect(f.driver.capture).not.toHaveBeenCalled();
    f.binding.securityMode = 'trusted-cdp';
    expect(await f.run()).toEqual({ state: 'unavailable' });
    f.binding.securityMode = 'trusted-managed';
    for (const url of ['chrome://settings/', 'file:///etc/passwd', 'about:config']) {
      f.binding.observedUrl = url;
      expect(await f.run()).toEqual({ state: 'unavailable' });
    }
  });
  it('discards pixels when a private control appears during capture', async () => {
    const f = fixture();
    vi.mocked(f.driver.screenshot).mockImplementation(async () => {
      f.surface.privacyDenied = true;
      return PNG.sync.write(new PNG({ width: 2, height: 2 }));
    });
    expect(await f.run()).toEqual({ state: 'privacy_blocked' });
  });
  it('discards changing documents and malformed or oversized PNGs', async () => {
    const f = fixture();
    vi.mocked(f.driver.screenshot).mockImplementation(async () => {
      f.binding.documentRevision = 'changed';
      return PNG.sync.write(new PNG({ width: 2, height: 2 }));
    });
    expect(await f.run()).toEqual({ state: 'busy' });
    vi.mocked(f.driver.screenshot).mockResolvedValue(new Uint8Array(2 * 1024 * 1024 + 1));
    expect(await f.run()).toEqual({ state: 'unavailable' });
    vi.mocked(f.driver.screenshot).mockResolvedValue(new Uint8Array([137, 80]));
    expect(await f.run()).toEqual({ state: 'unavailable' });
  });
  it('fails closed on owner revocation and propagates cancellation', async () => {
    const f = fixture();
    vi.mocked(f.access.authorize).mockRejectedValue(new Error('denied'));
    expect(await f.run()).toEqual({ state: 'unavailable' });
    f.ctx.signal = AbortSignal.abort();
    await expect(f.run()).rejects.toThrow();
  });
});
