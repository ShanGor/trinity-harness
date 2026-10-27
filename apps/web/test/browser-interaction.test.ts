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
  vi.useRealTimers();
});
it('maps resized image coordinates to viewport pixels and rejects letterbox/outside points', () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 },
    frame = { width: 1600, height: 800 };
  expect(mapBrowserPoint(rect, frame, 300, 150)).toEqual({ x: 800, y: 400 });
  expect(mapBrowserPoint(rect, frame, 501, 150)).toBeNull();
  expect(mapBrowserPoint({ ...rect, width: 0 }, frame, 300, 150)).toBeNull();
});
it('maps fractional layout and zoom coordinates to whole desktop pixels', () => {
  const rect = { left: 10.25, top: 20.5, width: 1137.5, height: 639.84375 };
  const frame = { width: 1920, height: 1080 };
  expect(mapBrowserPoint(rect, frame, 1024, 178)).toEqual({ x: 1711, y: 266 });
  expect(mapBrowserPoint(rect, frame, rect.left, rect.top)).toEqual({ x: 0, y: 0 });
  expect(mapBrowserPoint(rect, frame, rect.left + rect.width, rect.top + rect.height)).toEqual({
    x: 1919,
    y: 1079,
  });
});
async function mount(initialStatus?: number, desktop = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const sessionId = randomUUID();
  let generation = randomUUID();
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
    ...(desktop
      ? { surface: 'desktop' as const }
      : {
          browser: {
            tabs: [
              { id: 'tab', title: 'Example', url: 'https://example.com/', active: true },
              { id: 'other-tab', title: 'Other', url: 'https://other.example/', active: false },
            ],
          },
        }),
  });
  const keyboardId = randomUUID();
  const interactBrowser = vi.fn(
    async (request: BrowserInteractionRequest): Promise<BrowserInteractionResult> => {
      if (initialStatus) {
        const status = initialStatus;
        initialStatus = undefined;
        throw Object.assign(new Error('service unavailable'), { status });
      }
      if (request.operation === 'take') {
        available = true;
        mode = 'human';
        controllerId = request.viewId;
        return { state: state(), frame: frame() };
      }
      if (request.operation === 'reset') {
        available = false;
        mode = 'paused';
        controllerId = null;
        generation = randomUUID();
        epoch++;
        seq = 1;
        return { state: state() };
      }
      if (request.operation === 'input') {
        if (desktop) {
          const action = request.action;
          const points =
            action.type === 'drag'
              ? [action.from, action.to]
              : action.type === 'click' || action.type === 'scroll'
                ? action.point
                  ? [action.point]
                  : []
                : [];
          // Match the real guest's RFB boundary instead of accepting coordinates
          // that would quarantine control before any X11 input was sent.
          for (const point of points) {
            expect(Number.isInteger(point.x) && Number.isInteger(point.y)).toBe(true);
          }
        }
        seq++;
        return {
          state: state(),
          ...(request.capture === false ? (desktop ? {} : { keyboardId }) : { frame: frame() }),
          input: { requestId: request.requestId, effect: 'applied' },
        };
      }
      if (request.operation === 'release' || request.operation === 'pause') {
        mode = request.operation === 'release' ? 'agent' : 'paused';
        controllerId = null;
        epoch++;
        return { state: state() };
      }
      return {
        state: state(),
        ...(request.operation === 'frame'
          ? { frame: frame(), ...(!desktop ? { keyboardId } : {}) }
          : {}),
      };
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
it('keeps desktop control after a click on a fractionally scaled picture', async () => {
  const f = await mount(undefined, true);
  try {
    await act(async () => f.button('Start browser').click());
    const img = document.querySelector<HTMLImageElement>('.browser-preview-image')!;
    img.getBoundingClientRect = () => ({
      left: 10.25,
      top: 20.5,
      width: 563.75,
      height: 281.875,
      right: 574,
      bottom: 302.375,
      x: 10.25,
      y: 20.5,
      toJSON() {
        return {};
      },
    });
    await act(async () => {
      for (const type of ['pointerdown', 'pointerup'])
        img.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            clientX: 511,
            clientY: 104,
            button: 0,
          }),
        );
    });
    const input = f.interactBrowser.mock.calls.map(([r]) => r).find((r) => r.operation === 'input');
    expect(input).toMatchObject({ action: { type: 'click', point: { x: 711, y: 118 } } });
    expect(document.body.textContent).toContain('You control the browser');
    expect(document.body.textContent).not.toContain('Input outcome is unknown');
  } finally {
    await f.close();
  }
});
it('uses the native desktop chrome and captures a fresh frame for keyboard and wheel input', async () => {
  const f = await mount(undefined, true);
  try {
    await act(async () => f.button('Start browser').click());
    expect(document.querySelector('.browser-navigation-toolbar')).toBeNull();
    expect(document.querySelector('.browser-bookmark-toolbar')).toBeNull();
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
    const viewport = document.querySelector<HTMLElement>('.browser-interactive-viewport')!;
    await act(async () =>
      viewport.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: 110,
          clientY: 70,
          deltaY: 120,
        }),
      ),
    );
    expect(
      f.interactBrowser.mock.calls
        .map(([request]) => request)
        .find((request) => request.operation === 'input'),
    ).toMatchObject({
      action: { type: 'scroll', point: { x: 200, y: 100 }, dy: 120 },
      capture: true,
    });
    await act(async () =>
      keyboardInput().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })),
    );
    const input = f.interactBrowser.mock.calls
      .map(([request]) => request)
      .filter((request) => request.operation === 'input')
      .at(-1)!;
    expect(input).toMatchObject({ action: { type: 'key', key: 'Enter' }, capture: true });
    expect(input).not.toHaveProperty('keyboardId');
  } finally {
    await f.close();
  }
});
it('delivers a desktop double-click as two physical clicks', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-26T00:00:00Z'));
  const f = await mount(undefined, true);
  try {
    await act(async () => f.button('Start browser').click());
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
    for (let i = 0; i < 2; i++)
      await act(async () => {
        img.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, clientX: 110, clientY: 70, button: 0 }),
        );
        img.dispatchEvent(
          new MouseEvent('pointerup', { bubbles: true, clientX: 110, clientY: 70, button: 0 }),
        );
      });
    const clicks = f.interactBrowser.mock.calls
      .map(([request]) => request)
      .filter((request) => request.operation === 'input');
    expect(clicks).toHaveLength(2);
    expect(clicks.map((request) => request.action)).toMatchObject([
      { type: 'click', count: 1 },
      { type: 'click', count: 1 },
    ]);
  } finally {
    await f.close();
  }
});
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
function dismissBrowser(via: 'close button' | 'outside click' | 'Escape'): void {
  if (via === 'close button') {
    document.querySelector<HTMLButtonElement>('.ant-modal-close')!.click();
  } else {
    const wrap = document.querySelector('.ant-modal-wrap')!;
    if (via === 'Escape')
      wrap.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, keyCode: 27 }));
    else {
      wrap.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      wrap.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      wrap.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  }
}
it.each(['close button', 'outside click', 'Escape'] as const)(
  'returns control before closing with %s',
  async (via) => {
    const f = await mount();
    try {
      await act(async () => f.button('Start browser').click());
      const original = f.interactBrowser.getMockImplementation()!;
      let complete!: () => void;
      f.interactBrowser.mockImplementationOnce(async (request) => {
        expect(request.operation).toBe('release');
        await new Promise<void>((resolve) => {
          complete = resolve;
        });
        return original(request);
      });
      await act(async () => dismissBrowser(via));
      expect(f.onClose).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain('Returning control to the agent');
      await act(async () => complete());
      expect(f.interactBrowser.mock.calls.at(-1)![0]).toMatchObject({
        operation: 'release',
        sessionId: f.sessionId,
        epoch: 2,
      });
      expect(f.onClose).toHaveBeenCalledOnce();
      expect(document.querySelector('.browser-preview-image')).toBeNull();
    } finally {
      await f.close();
    }
  },
);
it('finishes a pending takeover before returning control on close', async () => {
  const f = await mount();
  try {
    const original = f.interactBrowser.getMockImplementation()!;
    let complete!: () => void;
    f.interactBrowser.mockImplementationOnce(async (request) => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return original(request);
    });
    await act(async () => f.button('Start browser').click());
    await act(async () => dismissBrowser('close button'));
    expect(f.onClose).not.toHaveBeenCalled();
    await act(async () => complete());
    expect(f.interactBrowser.mock.calls.map(([r]) => r.operation)).toEqual([
      'state',
      'take',
      'release',
    ]);
    expect(f.onClose).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
it('waits for active input and drops queued typing before returning control on close', async () => {
  fakeClock();
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    const original = f.interactBrowser.getMockImplementation()!;
    let complete!: () => void;
    f.interactBrowser.mockImplementationOnce(async (request) => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return original(request);
    });
    await act(async () => inputValue(keyboardInput(), 'first'));
    await act(async () => vi.advanceTimersByTimeAsync(35));
    await act(async () => inputValue(keyboardInput(), 'queued'));
    await act(async () => dismissBrowser('outside click'));
    expect(f.onClose).not.toHaveBeenCalled();
    expect(f.interactBrowser.mock.calls.at(-1)![0].operation).toBe('input');
    await act(async () => complete());
    expect(inputs(f).map((r) => r.action)).toEqual([{ type: 'text', text: 'first' }]);
    expect(f.interactBrowser.mock.calls.at(-1)![0].operation).toBe('release');
    expect(f.onClose).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
it.each(['rejected', 'disconnected'] as const)(
  'keeps the view open when returning control on close is %s',
  async (failure) => {
    const f = await mount();
    try {
      await act(async () => f.button('Start browser').click());
      const taken = f.interactBrowser.mock.results.at(-1)!.value;
      f.interactBrowser.mockImplementationOnce(async () => {
        if (failure === 'disconnected') throw Error('lost acknowledgement');
        const result = await taken;
        return {
          state: result.state,
          error: { code: 'PRIVACY_BLOCKED', message: 'A fresh non-private view is required.' },
        };
      });
      await act(async () => dismissBrowser('close button'));
      expect(f.onClose).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        failure === 'disconnected' ? 'Could not confirm' : 'Could not return control',
      );
      expect(f.interactBrowser.mock.calls.filter(([r]) => r.operation === 'release')).toHaveLength(
        1,
      );
    } finally {
      await f.close();
    }
  },
);
it('closes a view that never took control without sending a handoff', async () => {
  const f = await mount();
  try {
    await act(async () => dismissBrowser('close button'));
    expect(f.onClose).toHaveBeenCalledOnce();
    expect(f.interactBrowser.mock.calls.map(([r]) => r.operation)).toEqual(['state']);
  } finally {
    await f.close();
  }
});
it('returns control when closing after this view paused it', async () => {
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    await act(async () => f.button('Pause').click());
    await act(async () => dismissBrowser('close button'));
    expect(f.interactBrowser.mock.calls.at(-1)![0]).toMatchObject({
      operation: 'release',
      epoch: 3,
    });
    expect(f.onClose).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
it('preserves quarantine when closing during input with an unknown outcome', async () => {
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    let complete!: () => void;
    f.interactBrowser.mockImplementationOnce(async (request) => {
      if (request.operation !== 'input') throw Error('Expected input');
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return {
        state: {
          available: true,
          mode: 'quarantined',
          generation: request.generation,
          epoch: request.epoch + 1,
          controllerId: null,
          expiresAt: null,
          nextSequence: request.sequence + 1,
        },
        error: { code: 'UNKNOWN_EFFECT', message: 'Inspect the browser before continuing.' },
      };
    });
    await act(async () =>
      keyboardInput().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })),
    );
    await act(async () => dismissBrowser('close button'));
    await act(async () => complete());
    expect(f.onClose).toHaveBeenCalledOnce();
    expect(f.interactBrowser.mock.calls.filter(([r]) => r.operation === 'release')).toHaveLength(0);
    expect(inputs(f)).toHaveLength(1);
  } finally {
    await f.close();
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

function fakeClock(): void {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
}
it('keeps initial 503 failures recoverable and takes control after reconnecting', async () => {
  fakeClock();
  const f = await mount(503);
  try {
    expect(f.onUnsupported).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('temporarily unavailable');
    await act(async () => vi.advanceTimersByTimeAsync(4999));
    expect(f.interactBrowser).toHaveBeenCalledTimes(1);
    await act(async () => f.button('Retry connection').click());
    expect(f.interactBrowser.mock.calls.at(-1)![0].operation).toBe('state');
    await act(async () => f.button('Start browser').click());
    expect(document.body.textContent).toContain('You control the browser');
    expect(f.onUnsupported).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it('uses read-only fallback only when interaction is explicitly unconfigured', async () => {
  const f = await mount(501);
  try {
    expect(f.onUnsupported).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
it('does not retry failed takeover or input when the connection recovers', async () => {
  fakeClock();
  const f = await mount();
  try {
    f.interactBrowser.mockRejectedValueOnce(Object.assign(new Error('outage'), { status: 503 }));
    await act(async () => f.button('Start browser').click());
    expect(f.button('Start browser').disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(f.button('Start browser').disabled).toBe(false);
    expect(f.interactBrowser.mock.calls.filter(([r]) => r.operation === 'take')).toHaveLength(1);
    expect(f.interactBrowser.mock.calls.at(-1)![0].operation).toBe('state');
    expect(f.onUnsupported).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it('waits for durable state after a lost takeover response before allowing another start', async () => {
  fakeClock();
  const f = await mount();
  try {
    const original = f.interactBrowser.getMockImplementation()!;
    f.interactBrowser.mockImplementationOnce(async (request) => {
      await original(request);
      throw Object.assign(new Error('lost takeover response'), { status: 503 });
    });
    await act(async () => f.button('Start browser').click());
    expect(f.button('Start browser').disabled).toBe(true);
    await act(async () => f.button('Start browser').click());
    expect(f.interactBrowser.mock.calls.filter(([r]) => r.operation === 'take')).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(f.button('Start browser')).toBeUndefined();
    expect(f.button('Take control').disabled).toBe(true);
    expect(f.button('Restart browser').disabled).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(document.querySelector('.browser-preview-image')).not.toBeNull();
  } finally {
    await f.close();
  }
});
it('recovers state after picture failures and permits an explicit restart without repeating takeover', async () => {
  fakeClock();
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    expect(f.button('Take control').disabled).toBe(true);
    await act(async () => f.button('Take control').click());
    const original = f.interactBrowser.getMockImplementation()!;
    f.interactBrowser.mockImplementation(async (request) => {
      if (request.operation === 'frame')
        throw Object.assign(new Error('picture failed'), { status: 503 });
      return original(request);
    });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(document.querySelector('.browser-preview-image')).toBeNull();
    expect(f.button('Take control').disabled).toBe(true);
    expect(f.button('Restart browser').disabled).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(5250));
    expect(f.interactBrowser.mock.calls.filter(([r]) => r.operation === 'take')).toHaveLength(1);
    expect(f.button('Start browser')).toBeUndefined();
    await act(async () => f.button('Restart browser').click());
    expect(f.button('Start browser').disabled).toBe(false);
    f.interactBrowser.mockImplementation(original);
    await act(async () => f.button('Start browser').click());
    await act(async () => f.button('New tab').click());
    expect(inputs(f).at(-1)?.action).toEqual({ type: 'new_tab' });
    expect(f.interactBrowser.mock.calls.filter(([r]) => r.operation === 'take')).toHaveLength(2);
    expect(f.interactBrowser.mock.calls.filter(([r]) => r.operation === 'reset')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('clears unavailable pictures and backs off reads while preserving control and the local draft', async () => {
  fakeClock();
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    const draft = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Text to insert into browser"]',
    )!;
    await act(async () => inputValue(draft, 'Keep this draft'));
    const original = f.interactBrowser.getMockImplementation()!;
    f.interactBrowser.mockImplementationOnce(async (request) => ({
      state: (await original(request)).state,
      error: { code: 'UNAVAILABLE', message: 'A fresh browser picture is unavailable.' },
    }));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(document.querySelector('.browser-preview-image')).toBeNull();
    expect(f.button('Take control').disabled).toBe(true);
    expect(draft.value).toBe('Keep this draft');
    const calls = f.interactBrowser.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(4999));
    expect(f.interactBrowser).toHaveBeenCalledTimes(calls);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(document.querySelector('.browser-preview-image')).not.toBeNull();
    expect(draft.value).toBe('Keep this draft');
    expect(f.interactBrowser.mock.calls.filter(([r]) => r.operation === 'take')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('offers explicit new-tab recovery when capture fails without resending the previous input', async () => {
  fakeClock();
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    const original = f.interactBrowser.getMockImplementation()!;
    f.interactBrowser.mockImplementationOnce(async (request) => ({
      state: (await original(request)).state,
      error: { code: 'UNAVAILABLE', message: 'A fresh browser picture is unavailable.' },
    }));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(document.querySelector('.browser-preview-image')).toBeNull();
    await act(async () => f.button('Open new tab to recover').click());
    const sent = inputs(f);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.action).toEqual({ type: 'new_tab' });
    expect(sent[0]?.frameId).toBeUndefined();
    expect(document.querySelector('.browser-preview-image')).not.toBeNull();
    expect(f.button('Open new tab to recover')).toBeUndefined();
  } finally {
    await f.close();
  }
});

function inputValue(node: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, value);
  node.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
  );
}
function keyboardInput(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>('[aria-label="Browser keyboard input"]')!;
}
function inputs(f: Awaited<ReturnType<typeof mount>>) {
  return f.interactBrowser.mock.calls.map(([r]) => r).filter((r) => r.operation === 'input');
}
function pointerImage() {
  const img = document.querySelector<HTMLImageElement>('.browser-preview-image')!;
  let rect = new DOMRect(10, 20, 400, 200);
  let captured: number | undefined;
  img.getBoundingClientRect = () => rect;
  img.setPointerCapture = vi.fn((id: number) => {
    captured = id;
  });
  img.hasPointerCapture = (id: number) => captured === id;
  img.releasePointerCapture = vi.fn(() => {
    captured = undefined;
  });
  const dispatch = (type: string, x = 110, y = 70, pointerId = 1, button = 0): void => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button,
    });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    img.dispatchEvent(event);
  };
  return {
    img,
    dispatch,
    resize: () => {
      rect = new DOMRect(10, 20, 200, 100);
    },
  };
}
it('sends history and tab controls through ordered human input and keeps an edited address', async () => {
  fakeClock();
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    const address = document.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!;
    expect(address.value).toBe('https://example.com/');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        address,
        'https://draft.example/',
      );
      address.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(address.value).toBe('https://draft.example/');
    for (const label of ['Go back', 'Go forward', 'Reload page']) {
      await act(async () =>
        document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click(),
      );
    }
    await act(async () => f.button('New tab').click());
    await act(async () => f.button('Other').click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Close tab Other"]')!.click(),
    );
    expect(inputs(f).map((request) => request.action)).toEqual([
      { type: 'back' },
      { type: 'forward' },
      { type: 'reload' },
      { type: 'new_tab' },
      { type: 'switch_tab', tabId: 'other-tab' },
      { type: 'close_tab', tabId: 'other-tab' },
    ]);
    expect(inputs(f).map((request) => request.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  } finally {
    await f.close();
  }
});
it('magnifies for a two-pixel remote drag, pans locally, and preserves the keyboard node', async () => {
  fakeClock();
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    const keyboard = keyboardInput();
    const zoom = document.querySelector<HTMLSelectElement>('[aria-label="View zoom"]')!;
    await act(async () => {
      zoom.value = '4';
      zoom.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(document.querySelector<HTMLElement>('.browser-picture')!.style.width).toBe('3200px');
    const p = pointerImage();
    p.img.getBoundingClientRect = () => new DOMRect(10, 20, 3200, 1600);
    await act(async () => {
      p.dispatch('pointerdown');
      p.dispatch('pointermove', 118, 70);
      p.dispatch('pointerup', 118, 70);
    });
    expect(inputs(f)[0]?.action).toMatchObject({
      type: 'drag',
      from: { x: 25, y: 13 },
      to: { x: 27, y: 13 },
    });
    const before = inputs(f).length;
    await act(async () => f.button('Pan view').click());
    const viewport = document.querySelector<HTMLElement>('.browser-interactive-viewport')!;
    await act(async () => {
      p.dispatch('pointerdown', 300, 200);
      p.dispatch('pointermove', 100, 100);
      p.dispatch('pointerup', 100, 100);
    });
    expect(viewport.scrollLeft).toBe(200);
    expect(viewport.scrollTop).toBe(100);
    expect(inputs(f)).toHaveLength(before);
    expect(keyboardInput()).toBe(keyboard);
    await act(async () => {
      zoom.value = 'fit';
      zoom.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(viewport.classList.contains('is-zoomed')).toBe(false);
    expect(f.button('Pan view').disabled).toBe(true);
  } finally {
    await f.close();
  }
});
it('cancels a gesture on zoom and keeps Ctrl-wheel magnification local', async () => {
  fakeClock();
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    const p = pointerImage();
    await act(async () => p.dispatch('pointerdown'));
    await act(async () =>
      document
        .querySelector('.browser-interactive-viewport')!
        .dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -20 }),
        ),
    );
    await act(async () => p.dispatch('pointerup', 310, 170));
    expect(inputs(f)).toHaveLength(0);
    expect(document.querySelector<HTMLSelectElement>('[aria-label="View zoom"]')!.value).toBe(
      '1.25',
    );
  } finally {
    await f.close();
  }
});
it('captures a drag across polling intervals and sends one action bound to the starting frame', async () => {
  fakeClock();
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    const takeIndex = f.interactBrowser.mock.calls.findIndex(([r]) => r.operation === 'take');
    const initial = await f.interactBrowser.mock.results[takeIndex]!.value;
    const p = pointerImage();
    await act(async () => p.dispatch('pointerdown'));
    expect(p.img.setPointerCapture).toHaveBeenCalledWith(1);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(f.interactBrowser.mock.calls.filter(([r]) => r.operation === 'frame')).toHaveLength(0);
    expect(f.interactBrowser.mock.calls.some(([r]) => r.operation === 'heartbeat')).toBe(true);
    // Another pointer cannot complete or replace the captured gesture.
    await act(async () => {
      p.dispatch('pointerdown', 210, 120, 2);
      p.dispatch('pointerup', 210, 120, 2);
    });
    expect(inputs(f)).toHaveLength(0);
    await act(async () => p.dispatch('pointerup', 310, 170));
    expect(p.img.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(inputs(f)).toHaveLength(1);
    expect(inputs(f)[0]).toMatchObject({
      frameId: initial.frame!.frameId,
      generation: initial.frame!.generation,
      epoch: initial.frame!.epoch,
      capture: true,
      action: { type: 'drag', from: { x: 200, y: 100 }, to: { x: 600, y: 300 } },
    });
    expect(document.activeElement).toBe(keyboardInput());
  } finally {
    await f.close();
  }
});
it('keeps an in-flight screenshot from replacing the frame during a drag', async () => {
  fakeClock();
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    const takeIndex = f.interactBrowser.mock.calls.findIndex(([r]) => r.operation === 'take');
    const initial = await f.interactBrowser.mock.results[takeIndex]!.value;
    const p = pointerImage();
    const src = p.img.src;
    let complete!: () => void;
    f.interactBrowser.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return {
        state: initial.state,
        frame: { ...initial.frame!, frameId: randomUUID(), png: 'bmV3', width: 1600 },
      };
    });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    await act(async () => p.dispatch('pointerdown'));
    await act(async () => complete());
    expect(p.img.src).toBe(src);
    expect(p.img.width).toBe(800);
    await act(async () => p.dispatch('pointerup', 310, 170));
    expect(inputs(f)[0]).toMatchObject({
      frameId: initial.frame!.frameId,
      action: { type: 'drag', from: { x: 200, y: 100 }, to: { x: 600, y: 300 } },
    });
  } finally {
    await f.close();
  }
});
it.each(['pointercancel', 'lostpointercapture', 'resize', 'outside', 'pause', 'right button'])(
  'discards a drag after %s without sending an effect',
  async (reason) => {
    fakeClock();
    const f = await mount();
    try {
      await act(async () => f.button('Start browser').click());
      const p = pointerImage();
      const button = reason === 'right button' ? 2 : 0;
      await act(async () => p.dispatch('pointerdown', 110, 70, 1, button));
      await act(async () => {
        if (reason === 'resize') p.resize();
        else if (reason === 'pause') f.button('Pause').click();
        else if (reason === 'pointercancel' || reason === 'lostpointercapture') p.dispatch(reason);
      });
      await act(async () =>
        p.dispatch('pointerup', reason === 'outside' ? 500 : 310, 170, 1, button),
      );
      expect(inputs(f)).toHaveLength(0);
      expect(p.img.releasePointerCapture).toHaveBeenCalledWith(1);
    } finally {
      await f.close();
    }
  },
);
it('batches adjacent text and preserves text, Enter and later text ordering without capture responses', async () => {
  fakeClock();
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    const keyboard = keyboardInput();
    await act(async () => {
      inputValue(keyboard, 'h');
      inputValue(keyboard, 'e');
      inputValue(keyboard, 'llo');
      keyboard.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      inputValue(keyboard, 'next');
    });
    expect(inputs(f)).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(70));
    expect(inputs(f).map((r) => r.action)).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'key', key: 'Enter', modifiers: [] },
      { type: 'text', text: 'next' },
    ]);
    expect(inputs(f).map((r) => r.sequence)).toEqual([1, 2, 3]);
    expect(inputs(f).every((r) => r.capture === false)).toBe(true);
    expect(inputs(f)[0]!.keyboardId).toBeUndefined();
    expect(inputs(f)[1]!.keyboardId).toBeDefined();
    expect(f.interactBrowser.mock.calls.filter(([r]) => r.operation === 'frame')).toHaveLength(0);
    expect(keyboardInput()).toBe(keyboard);
  } finally {
    await f.close();
  }
});
it('commits IME text once, ignores composition Enter, and keeps paste ahead of Tab', async () => {
  fakeClock();
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    const keyboard = keyboardInput();
    await act(async () => {
      keyboard.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      inputValue(keyboard, 'shi');
      keyboard.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', isComposing: true }),
      );
      keyboard.value = '世界';
      keyboard.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '世界' }),
      );
      keyboard.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertFromComposition',
          data: '世界',
        }),
      );
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', { value: { getData: () => ' pasted' } });
      keyboard.dispatchEvent(paste);
      keyboard.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(35));
    expect(inputs(f).map((r) => r.action)).toEqual([
      { type: 'text', text: '世界 pasted' },
      { type: 'key', key: 'Tab', modifiers: [] },
    ]);
  } finally {
    await f.close();
  }
});
it('keeps the local text draft and focus during polling and pending input, then inserts without submitting', async () => {
  fakeClock();
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    const composer = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Text to insert into browser"]',
    )!;
    await act(async () => {
      composer.focus();
      inputValue(composer, 'A local draft\n第二行');
    });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(composer.value).toBe('A local draft\n第二行');
    expect(document.activeElement).toBe(composer);
    let complete!: () => void;
    f.interactBrowser.mockImplementationOnce(async (request) => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      if (request.operation !== 'input') throw Error('Expected input');
      return {
        state: {
          available: true,
          mode: 'human',
          generation: request.generation,
          epoch: request.epoch,
          controllerId: request.viewId,
          expiresAt: null,
          nextSequence: request.sequence + 1,
        },
        input: { requestId: request.requestId, effect: 'applied' },
        keyboardId: randomUUID(),
      };
    });
    await act(async () => f.button('Insert text').click());
    await act(async () => vi.advanceTimersByTimeAsync(35));
    expect(inputs(f).map((r) => r.action)).toEqual([
      { type: 'text', text: 'A local draft\n第二行' },
    ]);
    expect(composer.value).toBe('A local draft\n第二行');
    expect(f.button('Insert text').disabled).toBe(true);
    await act(async () => inputValue(composer, 'Keep editing'));
    expect(composer.disabled).toBe(false);
    expect(composer.value).toBe('Keep editing');
    await act(async () => complete());
    expect(document.querySelector('[aria-label="Text to insert into browser"]')).toBe(composer);
    expect(composer.value).toBe('Keep editing');
    expect(document.activeElement).toBe(composer);
    await act(async () => f.button('Insert text').click());
    await act(async () => vi.advanceTimersByTimeAsync(35));
    expect(composer.value).toBe('');
    expect(inputs(f).at(-1)?.action).toEqual({ type: 'text', text: 'Keep editing' });
  } finally {
    await f.close();
  }
});

it.each(['lost', 'unknown'] as const)(
  'retains the local draft after a %s insertion result without retrying',
  async (outcome) => {
    fakeClock();
    const f = await mount();
    try {
      await act(async () => f.button('Start browser').click());
      const composer = document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Text to insert into browser"]',
      )!;
      await act(async () => inputValue(composer, 'Keep this text'));
      f.interactBrowser.mockImplementationOnce(async (request) => {
        if (outcome === 'lost') throw Error('lost response');
        if (request.operation !== 'input') throw Error('Expected input');
        return {
          state: {
            available: true,
            mode: 'quarantined',
            generation: request.generation,
            epoch: request.epoch + 1,
            controllerId: null,
            expiresAt: null,
            nextSequence: request.sequence + 1,
          },
          error: { code: 'UNKNOWN_EFFECT', message: 'Inspect the browser before continuing.' },
        };
      });
      await act(async () => f.button('Insert text').click());
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(composer.value).toBe('Keep this text');
      expect(inputs(f)).toHaveLength(1);
      expect(f.button('Insert text').disabled).toBe(outcome === 'unknown');
    } finally {
      await f.close();
    }
  },
);

it('chunks a long paste without splitting Unicode characters', async () => {
  fakeClock();
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    const value = 'a'.repeat(3999) + '😀b';
    await act(async () => {
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', { value: { getData: () => value } });
      keyboardInput().dispatchEvent(paste);
    });
    await act(async () => vi.advanceTimersByTimeAsync(70));
    const chunks = inputs(f).map((r) => (r.action.type === 'text' ? r.action.text : ''));
    expect(chunks).toHaveLength(2);
    expect(chunks.join('')).toBe(value);
    expect(
      chunks.every((chunk) => chunk.length <= 4000 && Buffer.from(chunk).toString() === chunk),
    ).toBe(true);
  } finally {
    await f.close();
  }
});
it('drops queued typing after an uncertain input and never resends it', async () => {
  fakeClock();
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    let fail!: () => void;
    f.interactBrowser.mockImplementationOnce(async () => {
      await new Promise<void>((_resolve, reject) => {
        fail = () => reject(new Error('lost acknowledgement'));
      });
      throw Error('unreachable');
    });
    await act(async () => inputValue(keyboardInput(), 'first'));
    await act(async () => vi.advanceTimersByTimeAsync(35));
    await act(async () => inputValue(keyboardInput(), 'queued'));
    await act(async () => fail());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(inputs(f).map((r) => r.action)).toEqual([{ type: 'text', text: 'first' }]);
  } finally {
    await f.close();
  }
});

it('coalesces wheel bursts behind an in-flight action and converts line deltas to pixels', async () => {
  fakeClock();
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    const original = f.interactBrowser.getMockImplementation()!;
    let complete!: () => void;
    f.interactBrowser.mockImplementationOnce(async (request) => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return original(request);
    });
    const viewport = document.querySelector('.browser-interactive-viewport')!;
    const wheel = (): void => {
      viewport.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 2, deltaMode: 1 }),
      );
    };
    await act(async () => wheel());
    await act(async () => {
      for (let i = 0; i < 20; i++) wheel();
    });
    expect(inputs(f)).toHaveLength(1);
    await act(async () => complete());
    expect(inputs(f).map((request) => request.action)).toEqual([
      { type: 'scroll', dx: 0, dy: 32 },
      { type: 'scroll', dx: 0, dy: 640 },
    ]);
    expect(inputs(f).map((request) => request.sequence)).toEqual([1, 2]);
  } finally {
    await f.close();
  }
});
it('shows drag feedback and cancels the gesture when expanding without replacing the text draft', async () => {
  fakeClock();
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    const draft = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Text to insert into browser"]',
    )!;
    await act(async () => inputValue(draft, 'Keep this draft'));
    const p = pointerImage();
    await act(async () => {
      p.dispatch('pointerdown');
      p.dispatch('pointermove', 310, 170);
    });
    expect(document.querySelector('.browser-drag-preview')).not.toBeNull();
    expect(document.body.textContent).toContain('Release to drop');
    await act(async () => f.button('Expand view').click());
    await act(async () => p.dispatch('pointerup', 310, 170));
    expect(inputs(f)).toHaveLength(0);
    expect(document.querySelector('.browser-drag-preview')).toBeNull();
    expect(document.querySelector('[aria-label="Text to insert into browser"]')).toBe(draft);
    expect(draft.value).toBe('Keep this draft');
    expect(f.button('Restore view').getAttribute('aria-pressed')).toBe('true');
  } finally {
    await f.close();
  }
});

it('opens native bookmarks and account settings only after taking control', async () => {
  fakeClock();
  const f = await mount();
  try {
    expect(f.button('Bookmarks').disabled).toBe(true);
    expect(f.button('Chrome account').disabled).toBe(true);
    await act(async () => f.button('Start browser').click());
    await act(async () => f.button('Bookmarks').click());
    await act(async () => f.button('Chrome account').click());
    expect(inputs(f).map((r) => r.action)).toEqual([
      { type: 'open_browser_page', page: 'bookmarks' },
      { type: 'open_browser_page', page: 'account' },
    ]);
    await act(async () => f.button('Return control to agent').click());
    expect(f.button('Bookmarks').disabled).toBe(true);
    expect(f.button('Chrome account').disabled).toBe(true);
  } finally {
    await f.close();
  }
});

it('expands the picture in Fit mode without replacing its image or sending remote input', async () => {
  fakeClock();
  const f = await mount();
  try {
    await act(async () => f.button('Start browser').click());
    const picture = document.querySelector('.browser-picture');
    const image = document.querySelector('.browser-preview-image');
    const zoom = document.querySelector<HTMLSelectElement>('[aria-label="View zoom"]')!;
    await act(async () => {
      zoom.value = '0.5';
      zoom.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => f.button('Expand view').click());
    expect(zoom.value).toBe('fit');
    expect(document.querySelector('.browser-view-expanded')).not.toBeNull();
    expect(document.querySelector('.browser-picture')).toBe(picture);
    expect(document.querySelector('.browser-preview-image')).toBe(image);
    expect(document.querySelector('.browser-interactive-viewport.is-zoomed')).toBeNull();
    expect(inputs(f)).toHaveLength(0);
  } finally {
    await f.close();
  }
});
