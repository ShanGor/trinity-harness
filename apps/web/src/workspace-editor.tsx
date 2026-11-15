import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { foldAll, unfoldAll, type LanguageSupport } from '@codemirror/language';
import { Transaction } from '@codemirror/state';
import { Alert, Button, Flex } from 'antd';
import { prettifyJson, workspaceEditorLanguage } from './workspace-editor-language';

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
  const editor = useRef<ReactCodeMirrorRef>(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ source: string; path: string; text: string }>();
  const [language, setLanguage] = useState<LanguageSupport>();
  useEffect(() => {
    let active = true;
    setLanguage(undefined);
    setError('');
    void workspaceEditorLanguage(path).then(
      (support) => {
        if (active) setLanguage(support);
      },
      () => {
        if (active) setError('Syntax support could not be loaded. Reopen the file to retry.');
      },
    );
    return () => {
      active = false;
    };
  }, [path]);
  const extensions = useMemo(() => (language ? [language] : []), [language]);
  const prettify = (): void => {
    const view = editor.current?.view;
    if (!view) return;
    const result = prettifyJson(readOnly ? value : view.state.doc.toString());
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setError('');
    if (readOnly) {
      setPreview({ source: value, path, text: result.text });
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: result.text },
      annotations: Transaction.userEvent.of('input'),
    });
    view.focus();
  };
  return (
    <Flex vertical gap={8}>
      {language && (
        <Flex gap={8} wrap>
          {/\.json$/i.test(path) && <Button onClick={prettify}>Prettify JSON</Button>}
          <Button onClick={() => editor.current?.view && foldAll(editor.current.view)}>
            Collapse all
          </Button>
          <Button onClick={() => editor.current?.view && unfoldAll(editor.current.view)}>
            Expand all
          </Button>
        </Flex>
      )}
      {error && <Alert type="error" message={error} />}
      <CodeMirror
        ref={editor}
        value={
          readOnly && preview?.source === value && preview.path === path ? preview.text : value
        }
        height="60vh"
        extensions={extensions}
        onChange={(text) => {
          setError('');
          if (!readOnly) onChange?.(text);
        }}
        readOnly={readOnly}
        editable={!readOnly}
        indentWithTab
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          searchKeymap: true,
          highlightSelectionMatches: true,
        }}
        aria-label={readOnly ? 'File preview or comparison' : 'File contents'}
      />
    </Flex>
  );
}
