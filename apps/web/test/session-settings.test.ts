// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from '@trinity-harness/client-acp';
import type { SessionSettings } from '@trinity-harness/shared';
import { SessionSettingsModal } from '../src/session-settings';

const session: SessionSettings = {
  sessionId: crypto.randomUUID(),
  userId: crypto.randomUUID(),
  title: 'Research notes',
  kind: 'chat',
  sessionRole: 'main',
  createdAt: '2026-10-26T00:00:00Z',
  workspaceUri: '/workspace/sessions/owner/research',
  scope: 'personal',
  policy: 'workspace-write',
  canChangePolicy: true,
};
let container: HTMLDivElement;
let root: Root;
let client: AcpClient;
let onClose: ReturnType<typeof vi.fn>;

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      createElement(SessionSettingsModal, {
        key: session.sessionId,
        client,
        sessionId: session.sessionId,
        teams: [
          { teamId: 'team-id', name: 'Research team', createdAt: session.createdAt, members: [] },
        ],
        onClose,
      }),
    ),
  );
}
async function click(element: Element | undefined | null): Promise<void> {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}
function button(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((element) => element.textContent === text);
}
async function selectReadOnly(): Promise<void> {
  await act(async () => {
    document
      .querySelector('.ant-select-selector')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await click(document.querySelector('.ant-select-item-option[title="Read only"]'));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
  client = new AcpClient();
  vi.spyOn(client, 'getSessionSettings').mockResolvedValue({ ...session });
  vi.spyOn(client, 'setSessionPolicy').mockResolvedValue();
  onClose = vi.fn();
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

describe('session settings', () => {
  it('loads current details, saves once, and preserves the confirmed policy', async () => {
    await render();
    expect(client.getSessionSettings).toHaveBeenCalledWith(
      session.sessionId,
      expect.any(AbortSignal),
    );
    expect(document.body.textContent).toContain('Main chat');
    expect(document.body.textContent).toContain(session.workspaceUri);
    expect(document.body.textContent).toContain('Personal');
    expect(document.body.textContent).toContain('Running and already queued requests');
    expect(button('Save permissions')?.disabled).toBe(true);
    let finish!: () => void;
    vi.mocked(client.setSessionPolicy).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await selectReadOnly();
    await click(button('Save permissions'));
    expect(client.setSessionPolicy).toHaveBeenCalledExactlyOnceWith(session.sessionId, 'read-only');
    expect(button('Close')?.disabled).toBe(true);
    expect(document.querySelector('.ant-modal-close')).toBeNull();
    await act(async () => finish());
    expect(document.body.textContent).toContain('Permissions saved.');
    expect(button('Save permissions')?.disabled).toBe(true);
    await click(button('Close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('blocks editing on failed reads and supports retry with fresh server values', async () => {
    vi.mocked(client.getSessionSettings).mockRejectedValueOnce(new Error('offline'));
    await render();
    expect(document.body.textContent).toContain('Could not load session settings.');
    expect(document.querySelector('[aria-label="Tool permissions"]')).toBeNull();
    expect(button('Save permissions')).toBeUndefined();
    await click(button('Retry'));
    expect(client.getSessionSettings).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[aria-label="Tool permissions"]')).not.toBeNull();
  });

  it('requires a fresh read after an uncertain save and never retries the write', async () => {
    vi.mocked(client.setSessionPolicy).mockRejectedValueOnce(new Error('connection lost'));
    await render();
    await selectReadOnly();
    await click(button('Save permissions'));
    expect(document.body.textContent).toContain('Could not confirm the save.');
    expect(button('Save permissions')?.disabled).toBe(true);
    vi.mocked(client.getSessionSettings).mockResolvedValueOnce({ ...session, policy: 'read-only' });
    await click(button('Reload settings'));
    expect(document.querySelector('.ant-select-selection-item')?.textContent).toBe('Read only');
    expect(button('Save permissions')?.disabled).toBe(true);
    expect(client.setSessionPolicy).toHaveBeenCalledOnce();
  });

  it('shows team visibility and disables permission changes for viewers', async () => {
    vi.mocked(client.getSessionSettings).mockResolvedValueOnce({
      ...session,
      kind: 'work',
      sessionRole: 'task',
      scope: 'team',
      scopeId: 'team-id',
      canChangePolicy: false,
    });
    await render();
    expect(document.body.textContent).toContain('Shared with team · Research team');
    expect(document.body.textContent).toContain('You have read-only access');
    expect(document.querySelector('.ant-select-disabled') !== null).toBe(true);
    expect(button('Save permissions')).toBeUndefined();
    expect(client.setSessionPolicy).not.toHaveBeenCalled();
  });

  it.each(['danger-full-access', '{"tools":{"bash":"denied"}}'])(
    'preserves an existing %s policy until explicitly replaced',
    async (policy) => {
      vi.mocked(client.getSessionSettings).mockResolvedValueOnce({ ...session, policy });
      await render();
      expect(document.querySelector('.ant-select-selection-item')?.textContent).toContain(
        policy === 'danger-full-access' ? 'Full access' : 'Custom policy',
      );
      expect(button('Save permissions')?.disabled).toBe(true);
      expect(client.setSessionPolicy).not.toHaveBeenCalled();
      await selectReadOnly();
      expect(document.body.textContent).toContain('replaces the existing rules and command grants');
      await click(button('Save permissions'));
      expect(client.setSessionPolicy).toHaveBeenCalledWith(session.sessionId, 'read-only');
    },
  );

  it('cancels pending reads on close without rendering their stale results', async () => {
    let finish!: (value: SessionSettings) => void;
    vi.mocked(client.getSessionSettings).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    const signal = vi.mocked(client.getSessionSettings).mock.calls[0]![1]!;
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    await act(async () => finish(session));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
