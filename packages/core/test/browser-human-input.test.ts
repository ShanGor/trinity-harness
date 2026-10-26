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
import { interactionFromSurface, browserSurfaceScript } from '../src/tools/browser-interactions.js';
import { browserStateScript } from '../src/tools/browser-driver-scripts.js';
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
    tabCount: 2,
  };
  let owner = true;
  let redirectFocus = false;
  const call = vi.fn<ZendriverClient['call']>(async (name, args) => {
    if (name === 'browser_tab_list')
      return {
        content: [],
        structuredContent: {
          tabs: [
            { id: state.tabId, url: state.url, title: 'Example', is_current: true },
            { id: 'other-tab', url: 'https://other.example/', title: 'Other', is_current: false },
          ],
        },
      };
    if (name === 'browser_tab_activate')
      return { content: [], structuredContent: { id: 'other-tab' } };
    if (name === 'browser_tab_close')
      return { content: [], structuredContent: { closed_id: 'other-tab' } };
    if (name === 'browser_tab_new') return { content: [], structuredContent: { id: 'new-tab' } };
    if (['browser_back', 'browser_forward', 'browser_reload'].includes(name))
      return { content: [], structuredContent: { url: state.url, title: 'Example' } };
    if (name === 'browser_status')
      return {
        content: [],
        structuredContent: {
          open: true,
          tab_count: state.tabCount,
          current_tab: { id: state.tabId, url: state.url },
        },
      };
    if (name === 'browser_evaluate') {
      const { expression } = z.object({ expression: z.string() }).parse(args);
      if (
        expression === '(()=>{history.back();return {ok:true}})()' ||
        expression === '(()=>{history.forward();return {ok:true}})()'
      )
        return { content: [], structuredContent: { value: { ok: true } } };
      let script = expression.replace(browserStateScript, JSON.stringify(state));
      if (script.includes(browserSurfaceScript('all'))) {
        readSurface();
        script = script.replace(browserSurfaceScript('all'), JSON.stringify(surface));
      }
      return { content: [], structuredContent: { value: browser.window.eval(script) } };
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
  const readSurface = vi.fn();
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
it.each([
  [
    { type: 'back' },
    'browser_evaluate',
    { expression: '(()=>{history.back();return {ok:true}})()' },
  ],
  [
    { type: 'forward' },
    'browser_evaluate',
    { expression: '(()=>{history.forward();return {ok:true}})()' },
  ],
  [{ type: 'reload' }, 'browser_reload', { return_snapshot: false }],
  [{ type: 'new_tab' }, 'browser_tab_new', { activate: true }],
  [{ type: 'switch_tab', tabId: 'other-tab' }, 'browser_tab_activate', { tab_id: 'other-tab' }],
  [{ type: 'close_tab', tabId: 'other-tab' }, 'browser_tab_close', { tab_id: 'other-tab' }],
] as const)(
  'dispatches private browser chrome action %j against the owned tab',
  async (action, name, args) => {
    const f = setup();
    // Navigation/tab controls depend on document identity, not mutable page layout.
    expect(
      await f.driver.humanInput(action, { ...f.target, fingerprint: '0'.repeat(64) }, f.ctx),
    ).toEqual({ effect: 'applied' });
    expect(f.call).toHaveBeenCalledWith(name, args, f.ctx.signal);
    expect(f.readSurface).not.toHaveBeenCalled();
  },
);
it('rejects foreign tab ids and changed active documents without dispatch', async () => {
  const f = setup();
  expect(
    await f.driver.humanInput({ type: 'switch_tab', tabId: 'foreign-tab' }, f.target, f.ctx),
  ).toEqual({ effect: 'none' });
  expect(
    await f.driver.humanInput({ type: 'close_tab', tabId: 'foreign-tab' }, f.target, f.ctx),
  ).toEqual({ effect: 'none' });
  f.state.documentRevision = 'changed';
  expect(await f.driver.humanInput({ type: 'new_tab' }, f.target, f.ctx)).toEqual({
    effect: 'none',
  });
  expect(
    f.call.mock.calls.some(([name]) =>
      ['browser_tab_activate', 'browser_tab_close', 'browser_tab_new'].includes(name),
    ),
  ).toBe(false);
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

it('rechecks ownership and document identity after capture before returning private pixels', async () => {
  const f = setup();
  vi.spyOn(f.driver, 'paint').mockResolvedValue('ready');
  const png = PNG.sync.write(new PNG({ width: 800, height: 600 }));
  const screenshot = vi.spyOn(f.driver, 'screenshot').mockImplementationOnce(async () => {
    f.state.documentRevision = 'new-document';
    return png;
  });
  expect((await f.driver.humanFrame(true, f.ctx)).preview.state).toBe('busy');
  screenshot.mockImplementationOnce(async () => {
    f.revoke();
    return png;
  });
  await expect(f.driver.humanFrame(true, f.ctx)).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
});
