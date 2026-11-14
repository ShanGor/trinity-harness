// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AcpClient } from '@trinity-harness/client-acp';
import { compareText } from '../src/workspace-document';
import { WorkspaceBrowser } from '../src/workspace-browser';

vi.mock('../src/workspace-editor', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    createElement('textarea', {
      value,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    }),
}));

it('browses folders, previews text safely, refreshes, and cancels on close without touching the composer', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }),
  );
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
  const client = new AcpClient();
  const list = vi.spyOn(client, 'listWorkspaceDirectory').mockImplementation(async (_id, path) => ({
    entries: path ? [{ name: 'hello.txt', kind: 'file' }] : [{ name: 'notes', kind: 'directory' }],
    truncated: false,
  }));
  const read = vi
    .spyOn(client, 'workspaceDocument')
    .mockResolvedValue({ text: '<script>unsafe()</script>', version: 'a'.repeat(64) });
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
    expect(read).toHaveBeenCalledWith(
      'one',
      { operation: 'read', path: 'notes/hello.txt' },
      expect.any(AbortSignal),
    );
    expect(document.querySelector('pre')?.textContent).toBe('<script>unsafe()</script>');
    expect(document.querySelector('script')).toBeNull();
    await click('Edit');
    const editor = document.querySelector('textarea')!;
    expect(editor.value).toBe('<script>unsafe()</script>');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        editor,
        'changed draft',
      );
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Compare changes');
    expect(document.querySelector('[aria-label="Unsaved changes"]')?.textContent).toContain(
      '+changed draft',
    );
    read.mockRejectedValueOnce(new Error('File changed'));
    await click('Save revision');
    expect(editor.value).toBe('changed draft');
    expect(document.body.textContent).toContain('File changed');
    await click('Discard edits');
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

it('compares changed lines, insertions, deletions and unchanged versions', () => {
  expect(compareText('a\nb\nc', 'a\nnew\nc')).toBe('@@ -2,1 +2,1 @@\n-b\n+new');
  expect(compareText('a', 'a\nb')).toContain('+b');
  expect(compareText('a\nb', 'a')).toContain('-b');
  expect(compareText('a', 'a')).toBe('No changes');
});
