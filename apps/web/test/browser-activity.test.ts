// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserActivity } from '../src/browser-activity';
import type { BrowserPreview } from '@trinity-harness/shared';

afterEach(() => vi.unstubAllGlobals());
it.each([
  ['privacy_blocked', 'Preview hidden to protect private page information.'],
  ['runtime_unavailable', 'Managed browser service is unavailable.'],
  ['unavailable', 'No active browser available.'],
] as const)('renders %s and cancels viewing without stopping the task', async (state, message) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = {
    getBrowserPreview: vi.fn(async (id: string, signal?: AbortSignal): Promise<BrowserPreview> => {
      expect(id).toBe('session');
      expect(signal?.aborted).toBe(false);
      return { state };
    }),
  };
  try {
    await act(async () =>
      root.render(createElement(BrowserActivity, { client, sessionId: 'session', running: true })),
    );
    expect(container.textContent).toContain('Agent is browsing');
    expect(client.getBrowserPreview).not.toHaveBeenCalled();
    await act(async () => container.querySelector('button')!.click());
    expect(document.body.textContent).toContain(message);
    expect(document.querySelector('.browser-preview-image')).toBeNull();
    expect(client.getBrowserPreview).toHaveBeenCalledTimes(1);
    const signal = client.getBrowserPreview.mock.calls[0]![1]!;
    await act(async () => document.querySelector<HTMLButtonElement>('.ant-modal-close')!.click());
    expect(signal.aborted).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
