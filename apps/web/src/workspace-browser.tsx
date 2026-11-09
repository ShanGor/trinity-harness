import { useEffect, useState, type ReactElement } from 'react';
import { Alert, Breadcrumb, Button, Drawer, Empty, Flex, List, Spin, Typography } from 'antd';
import { FileOutlined, FolderOutlined, ReloadOutlined } from '@ant-design/icons';
import type { AcpClient } from '@trinity-harness/client-acp';
import type { ReadFileResult, WorkspaceDirectory } from '@trinity-harness/shared';

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
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const [directory, setDirectory] = useState<WorkspaceDirectory | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReadFileResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setDirectory(null);
    setPreview(null);
    const request =
      file === null
        ? client.listWorkspaceDirectory(sessionId, path, controller.signal)
        : client.readWorkspaceFile(sessionId, file, controller.signal);
    void request
      .then((result) => {
        if (controller.signal.aborted) return;
        if ('entries' in result) setDirectory(result);
        else setPreview(result);
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
    setPath(next);
    setFile(null);
  };
  const segments = path ? path.split('/') : [];
  return (
    <>
      <Button icon={<FolderOutlined />} onClick={() => setOpen(true)}>
        Workspace
      </Button>
      <Drawer
        title="Session workspace"
        open={open}
        onClose={() => setOpen(false)}
        width="min(900px, 100vw)"
        destroyOnHidden
      >
        <Flex vertical gap={16}>
          {workspaceUri && (
            <Typography.Text type="secondary" style={{ overflowWrap: 'anywhere' }}>
              Folder: {workspaceUri}
            </Typography.Text>
          )}
          <Flex justify="space-between" align="center" gap={8}>
            <Breadcrumb
              items={[
                {
                  title: (
                    <Button type="link" onClick={() => navigate('')}>
                      Workspace
                    </Button>
                  ),
                },
                ...segments.map((part, index) => ({
                  title: (
                    <Button
                      type="link"
                      onClick={() => navigate(segments.slice(0, index + 1).join('/'))}
                    >
                      {part}
                    </Button>
                  ),
                })),
              ]}
            />
            <Button
              icon={<ReloadOutlined />}
              onClick={() => setRevision((value) => value + 1)}
              aria-label="Refresh workspace"
            />
          </Flex>
          {file !== null && (
            <Flex vertical gap={8}>
              <Button onClick={() => setFile(null)}>Back to folder</Button>
              <Typography.Text strong style={{ overflowWrap: 'anywhere' }}>
                {file}
              </Typography.Text>
            </Flex>
          )}
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
                        else setFile(next);
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
          {preview && (
            <>
              {preview.truncated && (
                <Alert type="info" message="Preview limited to 64 KiB or 2,000 lines." />
              )}
              {preview.content.includes('\0') ? (
                <Alert type="info" message="This binary file cannot be previewed as text." />
              ) : (
                <pre
                  style={{
                    margin: 0,
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {preview.content || '(Empty file)'}
                </pre>
              )}
            </>
          )}
        </Flex>
      </Drawer>
    </>
  );
}
