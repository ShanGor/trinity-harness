// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  BrowserInteractionRequest,
  BrowserInteractionResult,
  BrowserControlState,
} from '@trinity-harness/shared';
import { InteractiveBrowserView, mapBrowserPoint } from '../src/browser-interaction';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('maps resized image coordinates to viewport pixels and rejects letterbox/outside points', () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 },
    frame = { width: 1600, height: 800 };
  expect(mapBrowserPoint(rect, frame, 300, 150)).toEqual({ x: 800, y: 400 });
  expect(mapBrowserPoint(rect, frame, 501, 150)).toBeNull();
  expect(mapBrowserPoint({ ...rect, width: 0 }, frame, 300, 150)).toBeNull();
});
async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const sessionId = randomUUID(),
    generation = randomUUID();
  let seq = 1,
    epoch = 2,
    controllerId: string | null = null;
  let mode: BrowserControlState['mode'] = 'agent';
  let available = false;
  const state = (): BrowserControlState => ({
    available,
    mode,
    generation: available ? generation : null,
    epoch,
    controllerId,
    expiresAt: controllerId ? '2026-10-26T00:01:00Z' : null,
    nextSequence: seq,
  });
  const frame = () => ({
    state: 'frame' as const,
    generation,
    epoch,
    frameId: randomUUID(),
    capturedAt: '2026-10-26T00:00:00Z',
    securityMode: 'trusted-managed' as const,
    width: 800,
    height: 400,
    png: 'aW1hZ2U=',
  });
  const interactBrowser = vi.fn(
    async (request: BrowserInteractionRequest): Promise<BrowserInteractionResult> => {
      if (request.operation === 'take') {
        available = true;
        mode = 'human';
        controllerId = request.viewId;
        return { state: state(), frame: frame() };
      }
      if (request.operation === 'input') {
        seq++;
        return {
          state: state(),
          frame: frame(),
          input: { requestId: request.requestId, effect: 'applied' },
        };
      }
      if (request.operation === 'release' || request.operation === 'pause') {
        mode = request.operation === 'release' ? 'agent' : 'paused';
        controllerId = null;
        epoch++;
        return { state: state() };
      }
      return { state: state() };
    },
  );
  const onClose = vi.fn(),
    onUnsupported = vi.fn();
  await act(async () =>
    root.render(
      createElement(InteractiveBrowserView, {
        client: { interactBrowser },
        sessionId,
        onClose,
        onUnsupported,
      }),
    ),
  );
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.ant-modal button')].find(
      (b) => b.textContent === name,
    )!;
  const close = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { interactBrowser, button, close, onClose, onUnsupported, root, sessionId };
}
it('opens on explicit takeover and sends mapped pointer and keyboard input without changing the parent draft', async () => {
  const draft = document.createElement('textarea');
  draft.value = 'Unsent composer draft';
  document.body.append(draft);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-26T00:00:00Z'));
  const f = await mount();
  try {
    expect(f.interactBrowser.mock.calls[0]![0].operation).toBe('state');
    await act(async () => f.button('Start browser').click());
    expect(document.body.textContent).toContain('You control the browser');
    const img = document.querySelector<HTMLImageElement>('.browser-preview-image')!;
    img.getBoundingClientRect = () => ({
      left: 10,
      top: 20,
      width: 400,
      height: 200,
      right: 410,
      bottom: 220,
      x: 10,
      y: 20,
      toJSON() {
        return {};
      },
    });
    await act(async () => {
      img.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, clientX: 110, clientY: 70, button: 0 }),
      );
      img.dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, clientX: 110, clientY: 70, button: 0 }),
      );
    });
    const click = f.interactBrowser.mock.calls.map(([r]) => r).find((r) => r.operation === 'input');
    expect(click).toMatchObject({
      operation: 'input',
      sequence: 1,
      action: { type: 'click', point: { x: 200, y: 100 } },
    });
    await act(async () => {
      img.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, clientX: 110, clientY: 70, button: 0 }),
      );
      img.dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, clientX: 110, clientY: 70, button: 0 }),
      );
    });
    expect(
      f.interactBrowser.mock.calls
        .map(([r]) => r)
        .filter((r) => r.operation === 'input')
        .at(-1),
    ).toMatchObject({ action: { type: 'click', count: 2 } });
    const keyboard = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Browser keyboard input"]',
    )!;
    await act(async () =>
      keyboard.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })),
    );
    expect(
      f.interactBrowser.mock.calls.map(([r]) => r).filter((r) => r.operation === 'input'),
    ).toHaveLength(3);
    expect(draft.value).toBe('Unsent composer draft');
    expect(draft.isConnected).toBe(true);
  } finally {
    await f.close();
    draft.remove();
  }
});
it('drops private pixels when returning control and cancels the watch when closed', async () => {
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    expect(document.querySelector('.browser-preview-image')).not.toBeNull();
    await act(async () => f.button('Return control to agent').click());
    expect(document.querySelector('.browser-preview-image')).toBeNull();
    const signal = f.interactBrowser.mock.calls[0]?.[1];
    await f.close();
    expect(signal?.aborted).toBe(true);
  } catch (error) {
    await f.close();
    throw error;
  }
});
it('does not retry an input after its response is lost', async () => {
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    f.interactBrowser.mockImplementationOnce(async () => {
      throw new Error('lost response');
    });
    const keyboard = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Browser keyboard input"]',
    )!;
    await act(async () =>
      keyboard.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })),
    );
    expect(
      f.interactBrowser.mock.calls.map(([r]) => r).filter((r) => r.operation === 'input'),
    ).toHaveLength(1);
    expect(document.body.textContent).toContain('Input was not retried');
  } finally {
    await f.close();
  }
});

it('creates a control view on LAN HTTP without crypto.randomUUID', async () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    const request = f.interactBrowser.mock.calls.find(([r]) => r.operation === 'take')![0];
    expect(request.viewId).toMatch(/^[0-9a-f-]{36}$/);
    expect(document.body.textContent).toContain('You control the browser');
  } finally {
    await f.close();
  }
});
