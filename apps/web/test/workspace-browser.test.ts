// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AcpClient } from '@trinity-harness/client-acp';
import { compareText } from '../src/workspace-document';
import { WorkspaceBrowser } from '../src/workspace-browser';

vi.mock('../src/workspace-editor', () => ({
  default: ({
    value,
    onChange,
    readOnly,
  }: {
    value: string;
    onChange: (value: string) => void;
    readOnly?: boolean;
  }) =>
    createElement('textarea', {
      value,
      readOnly,
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
  const copy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', Object.assign(navigator, { clipboard: { writeText: copy } }));
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
    const button = [
      ...document.querySelectorAll<HTMLElement>(
        'button, .ant-segmented-item-label, [role="menuitem"]',
      ),
    ].find((value) => value.textContent === label || value.getAttribute('aria-label') === label);
    expect(button).toBeTruthy();
    await act(async () => button!.click());
  };
  try {
    await act(async () =>
      root.render(
        createElement(WorkspaceBrowser, {
          client,
          sessionId: 'one',
          workspaceUri: '/home/test/workspace',
        }),
      ),
    );
    expect(list).not.toHaveBeenCalled();
    await click('Workspace');
    expect(list).toHaveBeenLastCalledWith('one', '', expect.any(AbortSignal));
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });
    read.mockResolvedValueOnce({ base64: 'UEs=' });
    await click('More workspace actions');
    await click('Download folder as ZIP');
    expect(downloads).toEqual(['workspace.zip']);
    expect(read).toHaveBeenLastCalledWith(
      'one',
      { operation: 'archive', path: '' },
      expect.any(AbortSignal),
    );
    read.mockRejectedValueOnce(new Error('Folder ZIP unavailable'));
    await click('More workspace actions');
    await click('Download folder as ZIP');
    expect(document.body.textContent).toContain('Folder ZIP unavailable');

    await click('notes');
    expect(list).toHaveBeenLastCalledWith('one', 'notes', expect.any(AbortSignal));
    read.mockResolvedValueOnce({ base64: 'UEs=' });
    await click('More workspace actions');
    await click('Download folder as ZIP');
    expect(downloads).toEqual(['workspace.zip', 'notes.zip']);
    expect(read).toHaveBeenLastCalledWith(
      'one',
      { operation: 'archive', path: 'notes' },
      expect.any(AbortSignal),
    );

    await click('hello.txt');
    expect(read).toHaveBeenCalledWith(
      'one',
      { operation: 'read', path: 'notes/hello.txt' },
      expect.any(AbortSignal),
    );
    expect(document.querySelector('textarea')?.value).toBe('<script>unsafe()</script>');
    expect(document.querySelector('textarea')?.readOnly).toBe(true);
    expect(document.querySelector('script')).toBeNull();
    expect(document.body.textContent).not.toContain('Folder:');
    expect(document.querySelector('.workspace-document-title')?.textContent).toBe('hello.txt');
    await click('More workspace actions');
    await click('Copy absolute path');
    expect(copy).toHaveBeenLastCalledWith('/home/test/workspace/notes/hello.txt');
    copy.mockRejectedValueOnce(new Error('Clipboard denied'));
    await click('More workspace actions');
    await click('Copy absolute path');
    expect(document.body.textContent).toContain('Could not copy the path.');
    await click('Edit');
    const editor = document.querySelector('textarea')!;
    expect(editor.readOnly).toBe(false);
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
    await click('Source');
    expect(document.querySelector('textarea')?.readOnly).toBe(true);
    expect(document.querySelector('textarea')?.value).toBe('<script>unsafe()</script>');
    expect(document.body.textContent).toContain('You have unsaved edits');
    await click('Edit');
    expect(document.querySelector('textarea')?.value).toBe('changed draft');
    read.mockRejectedValueOnce(new Error('File changed'));
    await click('Save revision');
    expect(document.querySelector('textarea')?.value).toBe('changed draft');
    expect(document.body.textContent).toContain('File changed');
    await click('Discard edits');
    await click('More workspace actions');
    await click('Revision history');
    expect(read).toHaveBeenLastCalledWith(
      'one',
      { operation: 'history', path: 'notes/hello.txt' },
      expect.any(AbortSignal),
    );
    expect(document.body.textContent).toContain('No saved revisions yet.');
    await click('Preview');
    expect(document.body.textContent).not.toContain('Back to folder');
    await click('notes');
    await click('Refresh workspace');
    expect(list).toHaveBeenCalledTimes(4);
    const signal = list.mock.calls.at(-1)![2]!;
    let finishArchive!: (value: { base64: string }) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishArchive = resolve;
        }),
    );
    await click('More workspace actions');
    await click('Download folder as ZIP');
    const archiveSignal = read.mock.calls.at(-1)![2]!;
    expect(document.body.textContent).toContain('Preparing folder ZIP…');
    await click('Close');
    expect(signal.aborted).toBe(true);
    expect(archiveSignal.aborted).toBe(true);
    await act(async () => finishArchive({ base64: 'UEs=' }));
    expect(downloads).toEqual(['workspace.zip', 'notes.zip']);
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

it.each([
  ['report.html', '<h1>Report</h1>', 'HTML preview'],
  ['report.md', '# Report', 'Markdown preview'],
  ['image.png', undefined, undefined],
])(
  'offers a read-only source for text and preserves rendered preview for %s',
  async (path, text, title) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }),
    );
    vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
    const computedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
    const client = new AcpClient();
    const request = vi
      .spyOn(client, 'workspaceDocument')
      .mockResolvedValue(
        text === undefined ? { base64: 'YQ==' } : { text, version: 'a'.repeat(64) },
      );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const clickView = async (label: string): Promise<void> => {
      const target = [...document.querySelectorAll<HTMLElement>('.ant-segmented-item-label')].find(
        (element) => element.textContent === label,
      )!;
      await act(async () => target.click());
    };
    try {
      await act(async () =>
        root.render(createElement(WorkspaceBrowser, { client, sessionId: 'one' })),
      );
      await act(async () =>
        window.dispatchEvent(
          new CustomEvent('trinity:workspace-open', {
            detail: { sessionId: 'one', path: `reports/${path}` },
          }),
        ),
      );
      expect(document.querySelector('.workspace-document-title')?.textContent).toBe(path);
      if (text !== undefined) {
        const preview = document.querySelector('iframe')!;
        expect(preview.title).toBe(title);
        expect(preview.getAttribute('sandbox')).toBe('');
        await clickView('Source');
        expect(document.querySelector('iframe')).toBeNull();
        expect(document.querySelector('textarea')?.value).toBe(text);
        expect(document.querySelector('textarea')?.readOnly).toBe(true);
        await clickView('Preview');
        expect(document.querySelector('iframe')?.title).toBe(title);
      } else {
        expect(document.querySelector('img')?.alt).toBe(`reports/${path}`);
        const source = [...document.querySelectorAll('.ant-segmented-item')].find(
          (element) => element.textContent === 'Source',
        )!;
        expect(source.querySelector('input')?.disabled).toBe(true);
      }
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]![1]).toEqual({ operation: 'read', path: `reports/${path}` });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  },
);
