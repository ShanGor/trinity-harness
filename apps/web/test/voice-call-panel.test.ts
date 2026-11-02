// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VoiceCallPanel } from '../src/voice-call-panel.js';
import type { VoiceCallSnapshot } from '../src/voice-call-controller.js';

vi.mock('../src/x-du-companion', () => ({
  XDuCompanion: ({ state }: { state: string }) =>
    createElement('div', { 'data-testid': 'companion', 'data-state': state }),
}));

const CALL: VoiceCallSnapshot = {
  active: true,
  status: 'speaking',
  muted: false,
  depth: 'brief',
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
  it('changes explanation depth without submitting a prompt or interrupting playback', async () => {
    const props = {
      call: CALL,
      companionState: 'speaking' as const,
      sessionId: 'session-1',
      minimized: false,
      onMinimize: vi.fn(),
      onOpen: vi.fn(),
      onShowText: vi.fn(),
      onToggleMute: vi.fn(),
      onFinishUtterance: vi.fn(),
      onDepthChange: vi.fn(),
      onInterrupt: vi.fn(async () => undefined),
      onRetry: vi.fn(async () => undefined),
      onEnd: vi.fn(),
    };
    await act(async () => root.render(createElement(VoiceCallPanel, props)));
    const detailed = container.querySelector('input[value="detailed"]') as HTMLInputElement;
    await act(async () => detailed.click());
    expect(props.onDepthChange).toHaveBeenCalledWith('detailed');
    expect(props.onInterrupt).not.toHaveBeenCalled();
    expect(props.onFinishUtterance).not.toHaveBeenCalled();
    expect(container.textContent).toContain('查看详情');
    expect(
      container
        .querySelector('[role="dialog"] [data-testid="companion"]')
        ?.getAttribute('data-state'),
    ).toBe('speaking');
  });

  it('lets a listening user explicitly finish speaking and disables sending while muted or busy', async () => {
    const props = {
      call: { ...CALL, status: 'listening' as const },
      companionState: 'listening' as const,
      sessionId: 'session-1',
      minimized: false,
      onMinimize: vi.fn(),
      onOpen: vi.fn(),
      onShowText: vi.fn(),
      onToggleMute: vi.fn(),
      onFinishUtterance: vi.fn(),
      onDepthChange: vi.fn(),
      onInterrupt: vi.fn(async () => undefined),
      onRetry: vi.fn(async () => undefined),
      onEnd: vi.fn(),
    };
    await act(async () => root.render(createElement(VoiceCallPanel, props)));
    await click('Finish speaking');
    expect(props.onFinishUtterance).toHaveBeenCalledOnce();
    for (const call of [{ ...props.call, muted: true }, { ...CALL }]) {
      await act(async () => root.render(createElement(VoiceCallPanel, { ...props, call })));
      expect(
        container.querySelector('button[aria-label="Finish speaking"]')?.hasAttribute('disabled'),
      ).toBe(true);
    }
  });
  it('exposes mute, interruption, text and hangup as distinct controls', async () => {
    const props = {
      call: CALL,
      companionState: 'speaking' as const,
      sessionId: 'session-1',
      minimized: false,
      onMinimize: vi.fn(),
      onOpen: vi.fn(),
      onShowText: vi.fn(),
      onToggleMute: vi.fn(),
      onFinishUtterance: vi.fn(),
      onDepthChange: vi.fn(),
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
      companionState: 'speaking' as const,
      sessionId: 'session-1',
      minimized: true,
      onMinimize: vi.fn(),
      onOpen: vi.fn(),
      onShowText: vi.fn(),
      onToggleMute: vi.fn(),
      onFinishUtterance: vi.fn(),
      onDepthChange: vi.fn(),
      onInterrupt: vi.fn(async () => undefined),
      onRetry: vi.fn(async () => undefined),
      onEnd: vi.fn(),
    };
    await act(async () => root.render(createElement(VoiceCallPanel, props)));

    expect(container.querySelector('[aria-label="Active voice call"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="companion"]')).toBeNull();
    await click('Open voice call');
    await click('End voice call');
    expect(props.onOpen).toHaveBeenCalledOnce();
    expect(props.onEnd).toHaveBeenCalledOnce();
  });
});
