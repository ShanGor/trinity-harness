// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PretextTextArea } from '../src/pretext-textarea';

const measurement = vi.hoisted(() => ({
  prepare: vi.fn((text: string) => ({ text })),
  layout: vi.fn((prepared: { text: string }, width: number, lineHeight: number) => ({
    height:
      prepared.text
        .split('\n')
        .reduce((lines, line) => lines + Math.max(1, Math.ceil((line.length * 10) / width)), 0) *
      lineHeight,
  })),
}));
vi.mock('@chenglou/pretext', () => measurement);

let container: HTMLDivElement;
let root: Root;
let width: number;
let resize: () => void;
const disconnect = vi.fn();

async function render(value: string): Promise<void> {
  await act(async () =>
    root.render(
      createElement(PretextTextArea, {
        value,
        autoSize: { minRows: 1, maxRows: 3 },
      }),
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  width = 120;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    width,
    height: 30,
    top: 0,
    left: 0,
    right: width,
    bottom: 30,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }));
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    fontStyle: 'normal',
    fontWeight: '400',
    fontSize: '16px',
    fontFamily: 'sans-serif',
    lineHeight: '20px',
    paddingLeft: '8px',
    paddingRight: '8px',
    paddingTop: '4px',
    paddingBottom: '4px',
    borderLeftWidth: '2px',
    borderRightWidth: '2px',
    borderTopWidth: '1px',
    borderBottomWidth: '1px',
    boxSizing: 'border-box',
    letterSpacing: 'normal',
    getPropertyValue: () => '',
  } as unknown as CSSStyleDeclaration);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe(): void {}
      disconnect = disconnect;
    },
  );
  measurement.prepare.mockClear();
  measurement.layout.mockClear();
  disconnect.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Pretext composer sizing', () => {
  it('sizes hard breaks and trailing newlines, clamps rows and preserves the textarea', async () => {
    await render('');
    const textarea = container.querySelector('textarea')!;
    expect(textarea.style.height).toBe('30px');
    textarea.focus();
    await render('one\ntwo\n');
    expect(textarea.style.height).toBe('70px');
    expect(textarea.style.overflowY).toBe('hidden');
    await render('one\ntwo\nthree\nfour');
    expect(textarea.style.height).toBe('70px');
    expect(textarea.style.overflowY).toBe('auto');
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe('one\ntwo\nthree\nfour');
    expect(measurement.prepare).toHaveBeenLastCalledWith(
      'one\ntwo\nthree\nfour',
      'normal 400 16px sans-serif',
      { whiteSpace: 'pre-wrap' },
    );
  });

  it('caches DOM metrics while typing and reuses prepared text on width changes', async () => {
    await render('short');
    const reads = vi.mocked(window.getComputedStyle).mock.calls.length;
    await render('123456789012345678901');
    expect(window.getComputedStyle).toHaveBeenCalledTimes(reads);
    const preparations = measurement.prepare.mock.calls.length;
    expect(container.querySelector('textarea')!.style.height).toBe('70px');
    width = 240;
    await act(async () => resize());
    expect(container.querySelector('textarea')!.style.height).toBe('30px');
    expect(measurement.prepare).toHaveBeenCalledTimes(preparations);
    const resizedReads = vi.mocked(window.getComputedStyle).mock.calls.length;
    await act(async () => resize());
    expect(window.getComputedStyle).toHaveBeenCalledTimes(resizedReads);
    await act(async () => root.unmount());
    expect(disconnect).toHaveBeenCalled();
  });
});
