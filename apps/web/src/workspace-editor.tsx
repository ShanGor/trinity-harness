import { useMemo, type ReactElement } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';

export default function WorkspaceEditor({
  value,
  path,
  onChange,
  readOnly = false,
}: {
  value: string;
  path: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
}): ReactElement {
  const extensions = useMemo(
    () =>
      /\.html?$/i.test(path)
        ? [html()]
        : /\.(md|markdown)$/i.test(path)
          ? [markdown()]
          : /\.[jt]sx?$/i.test(path)
            ? [javascript({ typescript: /\.tsx?$/i.test(path), jsx: /\.[jt]sx$/i.test(path) })]
            : [],
    [path],
  );
  return (
    <CodeMirror
      value={value}
      height="60vh"
      extensions={extensions}
      onChange={onChange}
      readOnly={readOnly}
      editable={!readOnly}
      indentWithTab
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        searchKeymap: true,
        highlightSelectionMatches: true,
      }}
      aria-label={readOnly ? 'File comparison' : 'File contents'}
    />
  );
}
