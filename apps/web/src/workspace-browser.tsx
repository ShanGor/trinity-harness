import { workspacePathSchema } from '@trinity-harness/shared';
import { WorkspaceDocumentView } from './workspace-document';
import { useEffect, useState, type ReactElement } from 'react';
import {
  Alert,
  Breadcrumb,
  Button,
  Drawer,
  Empty,
  Flex,
  List,
  Modal,
  Spin,
  Typography,
} from 'antd';
import { FileOutlined, FolderOutlined, ReloadOutlined } from '@ant-design/icons';
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
  return (
    <>
      <Button icon={<FolderOutlined />} onClick={() => setOpen(true)}>
        Workspace
      </Button>
      <Drawer
        title="Session workspace"
        open={open}
        onClose={() => leave(() => setOpen(false))}
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
              onClick={() => leave(() => setRevision((value) => value + 1))}
              aria-label="Refresh workspace"
            />
          </Flex>
          {file !== null && (
            <Flex vertical gap={8}>
              <Button onClick={() => leave(() => setFile(null))}>Back to folder</Button>
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
              onDirtyChange={setDirty}
            />
          )}
        </Flex>
      </Drawer>
    </>
  );
}
