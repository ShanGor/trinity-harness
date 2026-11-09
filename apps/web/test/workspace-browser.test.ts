// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AcpClient } from '@trinity-harness/client-acp';
import { WorkspaceBrowser } from '../src/workspace-browser';

it('browses folders, previews text safely, refreshes, and cancels on close without touching the composer', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
  const client = new AcpClient();
  const list = vi.spyOn(client, 'listWorkspaceDirectory').mockImplementation(async (_id, path) => ({
    entries: path ? [{ name: 'hello.txt', kind: 'file' }] : [{ name: 'notes', kind: 'directory' }],
    truncated: false,
  }));
  const read = vi
    .spyOn(client, 'readWorkspaceFile')
    .mockResolvedValue({ content: '<script>unsafe()</script>', truncated: false, offset: 1 });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const click = async (label: string): Promise<void> => {
    const button = [...document.querySelectorAll('button')].find(
      (value) => value.textContent === label || value.getAttribute('aria-label') === label,
    );
    expect(button).toBeTruthy();
    await act(async () => button!.click());
  };
  try {
    await act(async () =>
      root.render(createElement(WorkspaceBrowser, { client, sessionId: 'one' })),
    );
    expect(list).not.toHaveBeenCalled();
    await click('Workspace');
    expect(list).toHaveBeenLastCalledWith('one', '', expect.any(AbortSignal));
    await click('notes');
    expect(list).toHaveBeenLastCalledWith('one', 'notes', expect.any(AbortSignal));
    await click('hello.txt');
    expect(read).toHaveBeenCalledWith('one', 'notes/hello.txt', expect.any(AbortSignal));
    expect(document.querySelector('pre')?.textContent).toBe('<script>unsafe()</script>');
    expect(document.querySelector('script')).toBeNull();
    await click('Back to folder');
    await click('Refresh workspace');
    expect(list).toHaveBeenCalledTimes(4);
    const signal = list.mock.calls.at(-1)![2]!;
    await click('Close');
    expect(signal.aborted).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
