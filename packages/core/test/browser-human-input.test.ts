/// <reference lib="dom" />
// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PNG } from 'pngjs';
import {
  browserHumanInputResultSchema,
  type BrowserKeyboardTarget,
  type BrowserSurface,
} from '@trinity-harness/contracts';
import { ZendriverBrowserDriver, LocalSandbox } from '../src/index.js';
import { interactionFromSurface } from '../src/tools/browser-interactions.js';
import type { ZendriverClient } from '../src/tools/zendriver-mcp.js';

const browser = globalThis as unknown as {
  document: Document;
  window: Window & { eval(script: string): unknown };
};
afterEach(() => vi.restoreAllMocks());
function setup() {
  browser.document.body.innerHTML = '<input id="first"><input id="second">';
  const first = browser.document.querySelector<HTMLInputElement>('#first')!;
  const second = browser.document.querySelector<HTMLInputElement>('#second')!;
  first.focus();
  const state = {
    tabId: 'tab',
    documentRevision: 'revision',
    url: 'https://example.com/',
    browserVersion: 'Chrome/155',
  };
  let owner = true;
  let redirectFocus = false;
  const call = vi.fn<ZendriverClient['call']>(async (name, args) => {
    if (name === 'browser_evaluate') {
      const { expression } = z.object({ expression: z.string() }).parse(args);
      return { content: [], structuredContent: { value: browser.window.eval(expression) } };
    }
    if (name === 'browser_key_sequence') {
      const { sequence } = z
        .object({
          sequence: z.array(z.object({ text: z.string().optional(), key: z.string().optional() })),
        })
        .parse(args);
      for (const step of sequence) {
        if (step.text) (browser.document.activeElement as HTMLInputElement).value += step.text;
        if (step.key === 'Tab' || redirectFocus) second.focus();
        if (step.key === 'Enter') state.documentRevision = 'next_document';
      }
      return { content: [], structuredContent: { ok: true } };
    }
    throw new Error(`Unexpected call: ${name}`);
  });
  const sessionId = randomUUID();
  const driver = new ZendriverBrowserDriver({ call }, sessionId, randomUUID(), async () => owner);
  vi.spyOn(driver, 'inspect').mockImplementation(async () => ({ ...state }));
  const surface: BrowserSurface = {
    context: {
      width: 800,
      height: 600,
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
  const readSurface = vi.spyOn(driver, 'surface').mockResolvedValue(surface);
  const target = {
    frameId: randomUUID(),
    tabId: state.tabId,
    documentRevision: state.documentRevision,
    fingerprint: interactionFromSurface(surface).fingerprint,
    width: 800,
    height: 600,
    capturedAt: '2026-10-26T00:00:00Z',
  };
  const ctx = {
    sessionId,
    callId: 'input',
    sandbox: new LocalSandbox('/workspace'),
    workspaceRoot: '/workspace',
    signal: new AbortController().signal,
  };
  const begin = async (): Promise<BrowserKeyboardTarget> => {
    const result = browserHumanInputResultSchema.parse(
      await driver.humanInput({ type: 'text', text: 'A' }, target, ctx),
    );
    if (result.effect !== 'applied' || !result.keyboard) throw Error('Missing keyboard binding');
    return result.keyboard;
  };
  return {
    driver,
    call,
    first,
    second,
    state,
    readSurface,
    target,
    ctx,
    begin,
    revoke: () => {
      owner = false;
    },
    redirect: () => {
      redirectFocus = true;
    },
  };
}
it('continues typing through DOM changes without screenshots or repeated surface reads', async () => {
  const f = setup(),
    keyboard = await f.begin();
  browser.document.body.append(browser.document.createElement('p'));
  expect(await f.driver.humanInput({ type: 'text', text: '世界' }, keyboard, f.ctx)).toMatchObject({
    effect: 'applied',
    keyboard,
  });
  expect(f.first.value).toBe('A世界');
  expect(f.readSurface).toHaveBeenCalledTimes(1);
  expect(f.call.mock.calls.filter(([name]) => name === 'browser_key_sequence')).toHaveLength(2);
});
it('rejects focus changes, including moving away and back to the same input, before typing', async () => {
  const f = setup(),
    keyboard = await f.begin();
  f.second.focus();
  f.first.focus();
  expect(await f.driver.humanInput({ type: 'text', text: 'unsafe' }, keyboard, f.ctx)).toEqual({
    effect: 'none',
  });
  expect(f.first.value).toBe('A');
});
it.each(['tabId', 'documentRevision'] as const)(
  'rejects a changed %s before typing',
  async (field) => {
    const f = setup(),
      keyboard = await f.begin();
    f.state[field] = 'changed';
    expect(await f.driver.humanInput({ type: 'text', text: 'unsafe' }, keyboard, f.ctx)).toEqual({
      effect: 'none',
    });
    expect(f.first.value).toBe('A');
  },
);
it('renews the binding after an explicit Tab and stops continuation after navigation', async () => {
  const f = setup(),
    keyboard = await f.begin();
  const tab = await f.driver.humanInput(
    { type: 'key', key: 'Tab', modifiers: [] },
    keyboard,
    f.ctx,
  );
  if (tab.effect !== 'applied' || !tab.keyboard) throw Error('Missing new binding');
  expect(tab.keyboard.focusRevision).not.toBe(keyboard.focusRevision);
  await f.driver.humanInput({ type: 'text', text: 'B' }, tab.keyboard, f.ctx);
  expect(f.second.value).toBe('B');
  expect(
    await f.driver.humanInput({ type: 'key', key: 'Enter', modifiers: [] }, tab.keyboard, f.ctx),
  ).toEqual({ effect: 'applied' });
});
it('does not authorize pointer actions with a keyboard binding or retain it after text changes focus', async () => {
  const f = setup(),
    keyboard = await f.begin();
  expect(
    await f.driver.humanInput(
      { type: 'click', point: { x: 10, y: 10 }, button: 'left', count: 1, modifiers: [] },
      keyboard,
      f.ctx,
    ),
  ).toEqual({ effect: 'none' });
  f.redirect();
  expect(await f.driver.humanInput({ type: 'text', text: 'B' }, keyboard, f.ctx)).toEqual({
    effect: 'applied',
  });
});
it('rechecks ownership for every keyboard action', async () => {
  const f = setup(),
    keyboard = await f.begin();
  f.revoke();
  await expect(
    f.driver.humanInput({ type: 'text', text: 'unsafe' }, keyboard, f.ctx),
  ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  expect(f.first.value).toBe('A');
});

it('binds initial frame-based typing to its observed focus and suppresses capture across focus changes', async () => {
  const f = setup();
  vi.spyOn(f.driver, 'paint').mockResolvedValue('ready');
  const png = PNG.sync.write(new PNG({ width: 800, height: 600 }));
  const screenshot = vi.spyOn(f.driver, 'screenshot').mockResolvedValue(png);
  const captured = await f.driver.humanFrame(true, f.ctx, () => new Date('2026-10-26T00:00:00Z'));
  expect(captured.target?.focusRevision).toBeDefined();
  if (!captured.target) throw Error('Missing frame target');
  f.second.focus();
  expect(
    await f.driver.humanInput(
      { type: 'text', text: 'unsafe' },
      { ...captured.target, frameId: randomUUID() },
      f.ctx,
    ),
  ).toEqual({ effect: 'none' });
  expect(f.first.value).toBe('');
  expect(f.second.value).toBe('');
  screenshot.mockImplementationOnce(async () => {
    f.first.focus();
    return png;
  });
  expect(
    (await f.driver.humanFrame(true, f.ctx, () => new Date('2026-10-26T00:00:00Z'))).preview.state,
  ).toBe('busy');
});
