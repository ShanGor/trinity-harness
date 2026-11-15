import { workspacePathSchema } from '@trinity-harness/shared';
import { WorkspaceDocumentView } from './workspace-document';
import { WorkspaceMoreMenu } from './workspace-more-menu';
import './workspace-browser.css';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Breadcrumb, Button, Drawer, Empty, Flex, List, Modal, Spin } from 'antd';
import { DownloadOutlined, FileOutlined, FolderOutlined, ReloadOutlined } from '@ant-design/icons';
import type { AcpClient } from '@trinity-harness/client-acp';
import type { WorkspaceDirectory } from '@trinity-harness/shared';

/** Human file viewer. Kept outside the transcript so browsing preserves the composer and stream. */
export function WorkspaceBrowser({
  client,
  sessionId,
  workspaceUri,
}: {
  client: AcpClient;
  sessionId: string;
  workspaceUri?: string | null;
}): ReactElement {
  const [dirty, setDirty] = useState(false);
  const leave = (action: () => void): void => {
    if (!dirty) {
      action();
      return;
    }
    Modal.confirm({
      title: 'Discard unsaved edits?',
      content: 'Your edits have not been saved as a revision.',
      okText: 'Discard edits',
      onOk: () => {
        setDirty(false);
        action();
      },
    });
  };
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const [directory, setDirectory] = useState<WorkspaceDirectory | null>(null);
  const [file, setFile] = useState<string | null>(null);

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [archiving, setArchiving] = useState(false);
  const archiveController = useRef<AbortController | null>(null);
  useEffect(() => {
    archiveController.current?.abort();
    setArchiving(false);
    return () => archiveController.current?.abort();
  }, [client, sessionId, path, file, open]);
  const downloadFolder = async (): Promise<void> => {
    if (archiveController.current && !archiveController.current.signal.aborted) return;
    const controller = new AbortController();
    archiveController.current = controller;
    setArchiving(true);
    setError('');
    try {
      const archive = await client.workspaceDocument(
        sessionId,
        { operation: 'archive', path },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (archive.base64 === undefined) throw new Error('Folder ZIP unavailable');
      const bytes = Uint8Array.from(atob(archive.base64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${path.split('/').at(-1) || 'workspace'}.zip`;
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        URL.revokeObjectURL(url);
      }
    } catch (failure: unknown) {
      if (!controller.signal.aborted) setError(String(failure));
    } finally {
      if (!controller.signal.aborted) setArchiving(false);
      controller.abort();
    }
  };

  useEffect(() => {
    if (!open || file !== null) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setDirectory(null);

    const request = client.listWorkspaceDirectory(sessionId, path, controller.signal);
    void request
      .then((result) => {
        if (controller.signal.aborted) return;
        setDirectory(result);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(String(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, sessionId, open, path, file, revision]);
  const navigate = (next: string): void => {
    leave(() => {
      setPath(next);
      setFile(null);
    });
  };
  useEffect(() => {
    const receive = (event: Event): void => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (
        !detail ||
        typeof detail !== 'object' ||
        !('sessionId' in detail) ||
        detail.sessionId !== sessionId ||
        !('path' in detail)
      )
        return;
      const parsed = workspacePathSchema.safeParse(detail.path);
      if (!parsed.success || !parsed.data) return;
      leave(() => {
        setDirectory(null);
        setFile(parsed.data);
        setPath(parsed.data.split('/').slice(0, -1).join('/'));
        setOpen(true);
      });
    };
    window.addEventListener('trinity:workspace-open', receive);
    return () => window.removeEventListener('trinity:workspace-open', receive);
  }, [sessionId, dirty]);
  const segments = path ? path.split('/') : [];
  const absolutePath = workspaceUri
    ? `${workspaceUri.replace(/\/$/, '')}${file || path ? '/' + (file ?? path) : ''}`
    : undefined;
  return (
    <>
      <Button icon={<FolderOutlined />} onClick={() => setOpen(true)}>
        Workspace
      </Button>
      <Drawer
        title="Workspace"
        className="workspace-drawer"
        open={open}
        onClose={() => leave(() => setOpen(false))}
        width="min(900px, 100vw)"
        destroyOnHidden
      >
        <Flex vertical gap={16}>
          <Flex className="workspace-navigation" justify="space-between" align="center" gap={8}>
            <Breadcrumb
              className="workspace-breadcrumbs"
              items={[
                {
                  title: (
                    <Button type="link" size="small" onClick={() => navigate('')}>
                      Workspace
                    </Button>
                  ),
                },
                ...segments.map((part, index) => ({
                  title: (
                    <Button
                      type="link"
                      size="small"
                      title={part}
                      onClick={() => navigate(segments.slice(0, index + 1).join('/'))}
                    >
                      {part}
                    </Button>
                  ),
                })),
              ]}
            />
            {file === null && (
              <Flex gap={4}>
                <Button
                  type="text"
                  icon={<ReloadOutlined />}
                  onClick={() => setRevision((value) => value + 1)}
                  aria-label="Refresh workspace"
                />
                <WorkspaceMoreMenu
                  absolutePath={absolutePath}
                  items={[
                    {
                      key: 'download-folder',
                      label: archiving ? 'Preparing ZIP…' : 'Download folder as ZIP',
                      icon: <DownloadOutlined />,
                      disabled: archiving || loading || !directory,
                      onClick: () => void downloadFolder(),
                    },
                  ]}
                />
              </Flex>
            )}
          </Flex>
          {archiving && <Alert type="info" message="Preparing folder ZIP…" showIcon />}
          {loading && (
            <Spin tip="Loading workspace…">
              <div style={{ height: 80 }} />
            </Spin>
          )}
          {error && <Alert type="error" message={error} showIcon />}
          {directory && (
            <>
              <List
                dataSource={directory.entries}
                locale={{ emptyText: <Empty description="This folder is empty" /> }}
                renderItem={(entry) => (
                  <List.Item>
                    <Button
                      type="text"
                      disabled={entry.kind === 'other'}
                      icon={entry.kind === 'directory' ? <FolderOutlined /> : <FileOutlined />}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        justifyContent: 'flex-start',
                        height: 'auto',
                        whiteSpace: 'normal',
                        overflowWrap: 'anywhere',
                      }}
                      onClick={() => {
                        const next = path ? `${path}/${entry.name}` : entry.name;
                        if (entry.kind === 'directory') navigate(next);
                        else {
                          setDirectory(null);
                          setFile(next);
                        }
                      }}
                    >
                      {entry.name}
                      {entry.kind === 'other' ? ' (unavailable)' : ''}
                    </Button>
                  </List.Item>
                )}
              />
              {directory.truncated && (
                <Alert type="info" message="Showing the first 500 entries in this folder." />
              )}
            </>
          )}
          {file !== null && !loading && (
            <WorkspaceDocumentView
              key={sessionId + ':' + file + ':' + revision}
              client={client}
              sessionId={sessionId}
              path={file}
              absolutePath={absolutePath}
              onRefresh={() => leave(() => setRevision((value) => value + 1))}
              onDirtyChange={setDirty}
            />
          )}
        </Flex>
      </Drawer>
    </>
  );
}
