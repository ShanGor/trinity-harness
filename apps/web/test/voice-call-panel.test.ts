// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VoiceCallPanel } from '../src/voice-call-panel.js';
import type { VoiceCallSnapshot } from '../src/voice-call-controller.js';

const CALL: VoiceCallSnapshot = {
  active: true,
  status: 'speaking',
  muted: false,
  startedAt: Date.now(),
  userText: 'Hello',
  assistantText: 'Hello. How can I help?',
  error: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function click(label: string): Promise<void> {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

describe('VoiceCallPanel', () => {
  it('exposes mute, interruption, text and hangup as distinct controls', async () => {
    const props = {
      call: CALL,
      minimized: false,
      onMinimize: vi.fn(),
      onOpen: vi.fn(),
      onShowText: vi.fn(),
      onToggleMute: vi.fn(),
      onInterrupt: vi.fn(async () => undefined),
      onRetry: vi.fn(async () => undefined),
      onEnd: vi.fn(),
    };
    await act(async () => root.render(createElement(VoiceCallPanel, props)));

    await click('Mute microphone');
    await click('Interrupt Trinity');
    await click('View text conversation');
    await click('End voice call');

    expect(props.onToggleMute).toHaveBeenCalledOnce();
    expect(props.onInterrupt).toHaveBeenCalledOnce();
    expect(props.onShowText).toHaveBeenCalledOnce();
    expect(props.onEnd).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Turn-taking mode');
  });

  it('keeps an active call visible and stoppable while minimized', async () => {
    const props = {
      call: CALL,
      minimized: true,
      onMinimize: vi.fn(),
      onOpen: vi.fn(),
      onShowText: vi.fn(),
      onToggleMute: vi.fn(),
      onInterrupt: vi.fn(async () => undefined),
      onRetry: vi.fn(async () => undefined),
      onEnd: vi.fn(),
    };
    await act(async () => root.render(createElement(VoiceCallPanel, props)));

    expect(container.querySelector('[aria-label="Active voice call"]')).not.toBeNull();
    await click('Open voice call');
    await click('End voice call');
    expect(props.onOpen).toHaveBeenCalledOnce();
    expect(props.onEnd).toHaveBeenCalledOnce();
  });
});
