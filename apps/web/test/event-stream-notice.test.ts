// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { EventStreamNotice } from '../src/event-stream-notice';

it('escalates a continuing outage, offers explicit retry, and clears the deadline on recovery', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onRetry = vi.fn();
  const status = {
    state: 'reconnecting' as const,
    since: Date.now(),
    retryCount: 1,
    disconnectedForMs: 0,
    readyState: 0,
  };
  try {
    await act(async () => root.render(createElement(EventStreamNotice, { status, onRetry })));
    expect(container.textContent).toContain('Connection interrupted');
    expect(container.querySelector('button')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(14_000));
    await act(async () =>
      root.render(
        createElement(EventStreamNotice, { status: { ...status, retryCount: 2 }, onRetry }),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(container.textContent).toContain('still disconnected');
    await act(async () => container.querySelector('button')?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () =>
      root.render(createElement(EventStreamNotice, { status: { state: 'open' }, onRetry })),
    );
    expect(container.textContent).toBe('');
    for (const [reason, text] of [
      ['authentication', 'Sign in again'],
      ['access', 'no longer have access'],
      ['not_found', 'conversation is unavailable'],
    ] as const) {
      await act(async () =>
        root.render(
          createElement(EventStreamNotice, { status: { state: 'blocked', reason }, onRetry }),
        ),
      );
      expect(container.textContent).toContain(text);
      expect(container.textContent).not.toContain('Retrying automatically');
      expect(container.querySelector('button')?.textContent).toBe('Retry connection');
    }
    await act(async () =>
      root.render(
        createElement(EventStreamNotice, { status: { ...status, since: Date.now() }, onRetry }),
      ),
    );
    await act(async () =>
      root.render(createElement(EventStreamNotice, { status: { state: 'open' }, onRetry })),
    );
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(container.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
