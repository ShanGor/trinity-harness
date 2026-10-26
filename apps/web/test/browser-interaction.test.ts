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
async function mount(initialStatus?: number) {
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
      if (request.operation === 'input') {
        seq++;
        return {
          state: state(),
          ...(request.capture === false ? { keyboardId } : { frame: frame() }),
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
        ...(request.operation === 'frame' ? { frame: frame(), keyboardId } : {}),
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
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(f.interactBrowser.mock.calls.filter(([r]) => r.operation === 'take')).toHaveLength(1);
    expect(f.interactBrowser.mock.calls.at(-1)![0].operation).toBe('state');
    expect(f.onUnsupported).not.toHaveBeenCalled();
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
