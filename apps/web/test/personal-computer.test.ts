// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { AcpClient, SessionSummary } from '@trinity-harness/client-acp';
import { PersonalComputer } from '../src/personal-computer';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function mount(available = true, readOnly = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const result = { available, environment: null };
  const client = {
    getEnvironment: vi.fn(async () => result),
    changeEnvironment: vi.fn<AcpClient['changeEnvironment']>(async () => result),
    getBrowserPreview: vi.fn(async () => ({ state: 'unavailable' as const })),
    interactBrowser: vi.fn<AcpClient['interactBrowser']>(async () => ({
      state: {
        available: false,
        mode: 'paused',
        generation: null,
        epoch: 0,
        controllerId: null,
        expiresAt: null,
        nextSequence: 1,
      },
    })),
  };
  const session = (
    sessionId: string,
    userId = 'owner',
    scope: 'personal' | 'team' = 'personal',
  ): SessionSummary => ({
    sessionId,
    userId,
    scope,
    title: sessionId,
    workspaceUri: '/workspace',
    createdAt: '2026-10-26T00:00:00Z',
  });
  await act(async () =>
    root.render(
      createElement(PersonalComputer, {
        client,
        sessions: [
          session('task'),
          session('main'),
          session('other-owner', 'other'),
          session('team', 'owner', 'team'),
        ],
        userId: 'owner',
        mainSessionId: 'main',
        readOnly,
      }),
    ),
  );
  const button = (name: string) =>
    [...document.querySelectorAll('button')].find((node) => node.textContent === name)!;
  const close = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { client, button, close, container };
}
it('opens an owned browser without a browser tool call and filters other users/team sessions', async () => {
  const f = await mount();
  try {
    expect(f.client.getEnvironment).toHaveBeenCalledOnce();
    expect(f.client.interactBrowser).not.toHaveBeenCalled();
    await act(async () => f.button('Open browser').click());
    expect(f.client.interactBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'main', operation: 'state' }),
      expect.any(AbortSignal),
    );
    await act(async () => document.querySelector<HTMLButtonElement>('.ant-modal-close')!.click());
    await act(async () =>
      document
        .querySelector('.ant-select-selector')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    );
    expect(document.body.textContent).toContain('task');
    expect(document.body.textContent).not.toContain('other-owner');
    expect(document.body.textContent).not.toContain('team');
    await act(async () => document.querySelector<HTMLDivElement>('[title="task"]')!.click());
    await act(async () => f.button('Open browser').click());
    expect(f.client.interactBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'task' }),
      expect.any(AbortSignal),
    );
  } finally {
    await f.close();
  }
});
it('requires explicit VM actions and preserves unknown outcomes without retrying', async () => {
  const f = await mount();
  try {
    expect(f.client.changeEnvironment).not.toHaveBeenCalled();
    f.client.changeEnvironment.mockRejectedValueOnce(new Error('lost reply'));
    await act(async () => f.button('Wake VM').click());
    expect(f.client.changeEnvironment).toHaveBeenCalledWith('wake', expect.any(AbortSignal));
    expect(document.body.textContent).toContain('could not be confirmed');
    expect(f.button('Wake VM').disabled).toBe(true);
    await act(async () => f.button('Refresh VM status').click());
    expect(f.client.changeEnvironment).toHaveBeenCalledTimes(1);
    expect(f.client.getEnvironment).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});
it.each([
  [false, false],
  [true, true],
])(
  'disables VM mutations for unavailable/read-only environments (%s, %s)',
  async (available, readOnly) => {
    const f = await mount(available, readOnly);
    try {
      expect(f.button('Wake VM').disabled).toBe(true);
      expect(f.button('Suspend VM').disabled).toBe(true);
      expect(f.client.changeEnvironment).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);
