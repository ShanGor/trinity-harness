// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { foldedRanges, syntaxTree } from '@codemirror/language';
import { undo } from '@codemirror/commands';
import WorkspaceEditor from '../src/workspace-editor';
import { prettifyJson, workspaceEditorLanguage } from '../src/workspace-editor-language';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  'a.json',
  'a.yaml',
  'a.yml',
  'a.toml',
  'a.py',
  'a.java',
  'a.rs',
  'a.go',
  'a.css',
  'a.ts',
  'a.html',
  'a.md',
  'a.cpp',
  'Dockerfile',
])('loads syntax support for %s', async (path) => {
  expect(await workspaceEditorLanguage(path)).toBeDefined();
});

it('retains unknown files as plain text and parses JSON as JSON', async () => {
  expect(await workspaceEditorLanguage('a.unknown-extension')).toBeUndefined();
  const support = (await workspaceEditorLanguage('a.JSON'))!;
  const state = EditorState.create({ doc: '{"count": 2}', extensions: [support] });
  expect(syntaxTree(state).toString()).toContain('PropertyName');
});

it('prettifies JSON without changing large numbers, duplicate keys, or escaped strings', () => {
  expect(prettifyJson('{"n":9007199254740993,"n":1e999,"s":"a \\" b","a":[{},true,null]}')).toEqual(
    {
      text: '{\n  "n": 9007199254740993,\n  "n": 1e999,\n  "s": "a \\" b",\n  "a": [\n    {},\n    true,\n    null\n  ]\n}\n',
    },
  );
  expect(prettifyJson('{bad')).toHaveProperty('error');
  expect(prettifyJson('['.repeat(3000) + '0' + ']'.repeat(3000))).toHaveProperty('error');
  expect(prettifyJson('null')).toEqual({ text: 'null\n' });
});

it('prettifies as an undoable draft edit, folds and expands, and preserves read-only content', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const original = '{"items":[1,2]}';
  function Harness({ readOnly = false }: { readOnly?: boolean }): ReturnType<typeof createElement> {
    const [value, setValue] = useState(original);
    return createElement(WorkspaceEditor, {
      path: 'test.json',
      value,
      onChange: setValue,
      readOnly,
    });
  }
  const click = async (label: string): Promise<void> => {
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
    expect(button).toBeTruthy();
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(createElement(Harness)));
    await vi.waitFor(() => expect(container.textContent).toContain('Prettify JSON'));
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!;
    await click('Prettify JSON');
    expect(view.state.doc.toString()).toBe('{\n  "items": [\n    1,\n    2\n  ]\n}\n');
    await click('Collapse all');
    expect(foldedRanges(view.state).size).toBeGreaterThan(0);
    await click('Expand all');
    expect(foldedRanges(view.state).size).toBe(0);
    await act(async () => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe(original);
    await act(async () =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '{bad' } }),
    );
    await click('Prettify JSON');
    expect(container.textContent).toContain('Invalid JSON');
    expect(view.state.doc.toString()).toBe('{bad');
    await act(async () => root.render(createElement(Harness, { readOnly: true })));
    expect(container.textContent).toContain('Prettify JSON');
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('false');
    await click('Collapse all');
    await click('Expand all');
    expect(view.state.doc.toString()).toBe('{bad');
    const onChange = vi.fn();
    const renderPreview = async (value: string): Promise<void> => {
      await act(async () =>
        root.render(
          createElement(WorkspaceEditor, {
            path: 'preview.json',
            value,
            readOnly: true,
            onChange,
          }),
        ),
      );
      await vi.waitFor(() => expect(container.textContent).toContain('Prettify JSON'));
    };
    await renderPreview(original);
    const previewView = EditorView.findFromDOM(
      container.querySelector('.cm-editor') as HTMLElement,
    )!;
    await click('Prettify JSON');
    expect(previewView.state.doc.toString()).toBe('{\n  "items": [\n    1,\n    2\n  ]\n}\n');
    expect(previewView.state.readOnly).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    await renderPreview('{"updated":true}');
    expect(previewView.state.doc.toString()).toBe('{"updated":true}');
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
