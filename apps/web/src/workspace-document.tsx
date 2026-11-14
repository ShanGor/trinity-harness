import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, Flex, Input, Select, Spin } from 'antd';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AcpClient } from '@trinity-harness/client-acp';
import type { WorkspaceDocument, WorkspaceDocumentRequest } from '@trinity-harness/shared';

/** A bounded unified comparison; unchanged prefix/suffix are omitted. */
export function compareText(before: string, after: string): string {
  if (before === after) return 'No changes';
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return [
    `@@ -${start + 1},${a.length - start - end} +${start + 1},${b.length - start - end} @@`,
    ...a.slice(start, a.length - end).map((line) => '-' + line),
    ...b.slice(start, b.length - end).map((line) => '+' + line),
  ].join('\n');
}

function Differences({
  before,
  after,
  label,
}: {
  before: string;
  after: string;
  label: string;
}): ReactElement {
  return (
    <pre aria-label={label} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {compareText(before, after)
        .split('\n')
        .map((line, index) => (
          <span
            key={index}
            style={{
              display: 'block',
              background: line.startsWith('+')
                ? '#e6ffed'
                : line.startsWith('-')
                  ? '#ffeef0'
                  : undefined,
              color: line.startsWith('+')
                ? '#116329'
                : line.startsWith('-')
                  ? '#82071e'
                  : undefined,
            }}
          >
            {line}
          </span>
        ))}
    </pre>
  );
}

export function WorkspaceDocumentView({
  client,
  sessionId,
  path,
  onDirtyChange,
}: {
  client: AcpClient;
  sessionId: string;
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
}): ReactElement {
  const operationController = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    operationController.current = controller;
    return () => controller.abort();
  }, []);
  const requestDocument = (request: WorkspaceDocumentRequest): Promise<WorkspaceDocument> =>
    client.workspaceDocument(sessionId, request, operationController.current?.signal);
  const [document, setDocument] = useState<WorkspaceDocument>();
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState('preview');
  const [history, setHistory] = useState<NonNullable<WorkspaceDocument['revisions']>>([]);
  const [baseline, setBaseline] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    onDirtyChange?.(document?.text !== undefined && draft !== document.text);
    return () => onDirtyChange?.(false);
  }, [draft, document?.text, onDirtyChange]);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    void client
      .workspaceDocument(sessionId, { operation: 'read', path }, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setDocument(value);
          setDraft(value.text ?? '');
          setBaseline(undefined);
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [client, sessionId, path, reload]);
  const perform = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      if (!operationController.current?.signal.aborted) setError(String(e));
    } finally {
      if (!operationController.current?.signal.aborted) setBusy(false);
    }
  };
  const [downloadUrl, setDownloadUrl] = useState('');
  useEffect(() => {
    if (document?.base64 === undefined) {
      setDownloadUrl('');
      return;
    }
    const bytes = Uint8Array.from(atob(document.base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(
      new Blob([bytes], {
        type: path.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
      }),
    );
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [document?.base64, path]);
  const download = (): void => {
    if (!downloadUrl) return;
    const link = window.document.createElement('a');
    link.href = downloadUrl;
    link.download = path.split('/').at(-1) ?? 'download';
    link.click();
  };
  const extension = path.split('.').at(-1)?.toLowerCase();
  const imageMime = (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
    } as Record<string, string>
  )[extension ?? ''];
  return (
    <Flex vertical gap={12}>
      <Flex gap={8} wrap>
        <Button onClick={() => setMode('preview')}>Preview</Button>
        <Button disabled={document?.text === undefined || busy} onClick={() => setMode('edit')}>
          Edit
        </Button>
        <Button disabled={document?.base64 === undefined} onClick={download}>
          Download original
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const result = await requestDocument({
                operation: 'history',
                path,
              });
              setHistory(result.revisions ?? []);
              setMode('history');
            })
          }
        >
          Revision history
        </Button>
      </Flex>
      {error && <Alert type="error" message={error} />}
      {busy && <Spin />}
      {mode === 'edit' && document?.text !== undefined && (
        <>
          <Input.TextArea
            aria-label="File contents"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoSize={{ minRows: 12, maxRows: 30 }}
            disabled={busy}
          />
          <Differences label="Unsaved changes" before={document.text} after={draft} />
          <Flex gap={8}>
            <Button
              disabled={busy || draft === document.text}
              onClick={() =>
                void perform(async () => {
                  await requestDocument({
                    operation: 'save',
                    path,
                    expectedVersion: document.version!,
                    content: draft,
                  });
                  onDirtyChange?.(false);
                  setMode('preview');
                  setReload((n) => n + 1);
                })
              }
            >
              Save revision
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setDraft(document.text ?? '');
                setMode('preview');
              }}
            >
              Discard edits
            </Button>
          </Flex>
        </>
      )}
      {mode === 'history' && (
        <>
          <Alert
            type="info"
            message="Captured text versions, including proposed content retained before a save. Agent changes appear as a baseline on the next editor save. Compare a version with the current file below."
          />
          <Select
            aria-label="Compare revision"
            placeholder="Choose a revision"
            style={{ width: '100%' }}
            options={history.map((item) => ({
              value: item.version,
              label: `${item.capturedAt} · ${item.version.slice(0, 12)}`,
            }))}
            onChange={(revision: string) =>
              void perform(async () => {
                const value = await requestDocument({
                  operation: 'read',
                  path,
                  revision,
                });
                setBaseline(value.text);
              })
            }
          />
          {history.length === 0 && <p>No saved revisions yet.</p>}
          {baseline !== undefined && (
            <Differences
              label="Revision differences"
              before={baseline}
              after={document?.text ?? ''}
            />
          )}
        </>
      )}
      {mode === 'preview' &&
        document &&
        (extension === 'pdf' && downloadUrl ? (
          <iframe
            title="PDF preview"
            src={downloadUrl}
            sandbox=""
            style={{ width: '100%', height: 600 }}
          />
        ) : imageMime && document.base64 ? (
          <img
            alt={path}
            src={`data:${imageMime};base64,${document.base64}`}
            style={{ maxWidth: '100%' }}
          />
        ) : document.text !== undefined ? (
          extension === 'md' || extension === 'markdown' ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                img: () => <span>[Image: download the original to view linked media]</span>,
                a: ({ children }) => <span>{children}</span>,
              }}
            >
              {document.text}
            </ReactMarkdown>
          ) : extension === 'html' || extension === 'htm' ? (
            <iframe
              title="HTML preview"
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">${document.text}`}
              style={{ width: '100%', height: 500, border: 0 }}
            />
          ) : (
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {document.text || '(Empty file)'}
            </pre>
          )
        ) : (
          <Alert
            type="info"
            message="Visual preview is unavailable for this format or file size. Download the original. Text editing is limited to complete UTF-8 files up to 64 KiB; downloads up to 5 MiB."
          />
        ))}
    </Flex>
  );
}
