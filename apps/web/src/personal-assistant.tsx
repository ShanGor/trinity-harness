import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  Alert,
  Button,
  Collapse,
  Flex,
  Form,
  Input,
  List,
  Modal,
  Select,
  Tag,
  Typography,
  App,
} from 'antd';
import type { AcpClient, SessionSummary } from '@trinity-harness/client-acp';
import { newId } from '@trinity-harness/shared';
import type { SavedMemory, TopicEpisode, RecallReceipt } from '@trinity-harness/shared';

export function AssistantMemory({
  client,
  sessionId,
}: {
  client: AcpClient;
  sessionId: string | null;
}): ReactElement {
  const { message } = App.useApp();
  const [items, setItems] = useState<SavedMemory[]>([]);
  const [editing, setEditing] = useState<SavedMemory | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [receipts, setReceipts] = useState<{ at: string; receipt: RecallReceipt }[]>([]);
  const [form] = Form.useForm<{ subject: string; predicate: string; value: string }>();
  const refresh = useCallback(async () => {
    try {
      setItems((await client.getMemory()).items);
      setError('');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [client]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    void client
      .getMemorySelections(sessionId)
      .then((result) => {
        if (active) setReceipts(result.selections);
      })
      .catch(() => {
        if (active) setReceipts([]);
      });
    return () => {
      active = false;
    };
  }, [client, sessionId]);
  const change = async (item: SavedMemory, forget: boolean): Promise<void> => {
    setSaving(true);
    try {
      await client.changeMemory({
        operationId: newId(),
        memoryId: item.memoryId,
        expectedRevision: item.revision,
        operation: forget ? 'forget' : 'save',
        subject: item.subject,
        predicate: item.predicate,
        value: item.value,
      });
      await refresh();
      setEditing(null);
      message.success(
        forget
          ? 'Forgotten for future recall. Original conversation history is retained.'
          : 'Memory saved.',
      );
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="assistant-page">
      <Typography.Title level={2}>Memory</Typography.Title>
      <Typography.Paragraph type="secondary">
        Personal facts and preferences you explicitly save. These are available in your personal
        chats. Team tasks receive no personal memory.
      </Typography.Paragraph>
      {error && (
        <Alert
          type="error"
          message="Memory unavailable"
          description={error}
          action={<Button onClick={() => void refresh()}>Retry</Button>}
        />
      )}
      <Button
        type="primary"
        disabled={!!error}
        onClick={() => {
          form.resetFields();
          setEditing('new');
        }}
      >
        Remember something
      </Button>
      <List
        dataSource={items.filter((item) => item.status === 'active')}
        locale={{ emptyText: 'No saved memories' }}
        renderItem={(item) => (
          <List.Item
            actions={[
              <Button
                key="edit"
                onClick={() => {
                  form.setFieldsValue(item);
                  setEditing(item);
                }}
              >
                Edit
              </Button>,
              <Button key="forget" danger loading={saving} onClick={() => void change(item, true)}>
                Forget
              </Button>,
            ]}
          >
            <List.Item.Meta
              title={`${item.subject} · ${item.predicate}`}
              description={
                <>
                  <Typography.Paragraph>{item.value}</Typography.Paragraph>
                  <Typography.Text type="secondary">
                    Personal · revision {item.revision} ·{' '}
                    {new Date(item.recordedAt).toLocaleString()}
                    {item.source ? ` · source ${item.source.eventId}` : ' · saved by you'}
                  </Typography.Text>
                </>
              }
            />
          </List.Item>
        )}
      />
      <Collapse
        items={[
          {
            key: 'used',
            label: 'Memory used for answers in this conversation',
            children: receipts.length
              ? receipts.map(({ receipt, at }, i) => (
                  <div key={`${receipt.promptId}-${i}`}>
                    <Typography.Text>
                      {new Date(at).toLocaleString()} · policy revision {receipt.policyRevision}
                    </Typography.Text>
                    <MemoryContextDisclosure receipt={receipt} />
                  </div>
                ))
              : 'No recorded recall selections.',
          },
        ]}
      />
      <Typography.Paragraph type="secondary">
        Forget prevents future automatic recall. It retains original conversations and audit
        records. Previously dispatched model requests may already contain the value.
      </Typography.Paragraph>
      <Modal
        open={editing !== null}
        title={editing === 'new' ? 'Save a memory' : 'Edit memory'}
        confirmLoading={saving}
        onCancel={() => setEditing(null)}
        onOk={() => form.submit()}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) =>
            void change(
              {
                ...values,
                memoryId: editing && editing !== 'new' ? editing.memoryId : newId(),
                revision: editing && editing !== 'new' ? editing.revision : 0,
                status: 'active',
                recordedAt: new Date().toISOString(),
              },
              false,
            )
          }
        >
          <Form.Item
            name="subject"
            label="Subject"
            initialValue="Me"
            rules={[{ required: true, max: 200 }]}
          >
            <Input disabled={editing !== 'new'} />
          </Form.Item>
          <Form.Item
            name="predicate"
            label="Preference or fact"
            rules={[{ required: true, max: 200 }]}
          >
            <Input disabled={editing !== 'new'} placeholder="Response language" />
          </Form.Item>
          <Form.Item name="value" label="Value" rules={[{ required: true, max: 2000 }]}>
            <Input.TextArea placeholder="English" />
          </Form.Item>
        </Form>
      </Modal>
    </section>
  );
}

export function AssistantHistory({
  client,
  onOpen,
}: {
  client: AcpClient;
  onOpen: (id: string) => void;
}): ReactElement {
  const [episodes, setEpisodes] = useState<TopicEpisode[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [date, setDate] = useState('');
  const [timezone, setTimezone] = useState(
    () =>
      localStorage.getItem('trinity.history.timezone') ??
      Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<TopicEpisode | null>(null);
  const [title, setTitle] = useState('');
  const load = useCallback(
    async (cursor?: number) => {
      try {
        const result = await client.getHistory({
          ...(cursor ? { before: cursor } : {}),
          query,
          ...(date ? { date } : {}),
          timezone,
          limit: 20,
        });
        setEpisodes((prev) => (cursor ? [...prev, ...result.episodes] : result.episodes));
        setBefore(result.nextBefore);
        setError('');
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
    },
    [client, query, date, timezone],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="assistant-page">
      <Typography.Title level={2}>History</Typography.Title>
      <Typography.Paragraph type="secondary">
        Topic episodes keep your main conversation continuous. Dates filter history without
        resetting it.
      </Typography.Paragraph>
      <Flex gap={8} wrap>
        <Input.Search
          aria-label="Search topic history"
          placeholder="Topic or phrase"
          allowClear
          onSearch={setQuery}
        />
        <Input
          type="date"
          aria-label="History date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
        <Input
          aria-label="History timezone"
          value={timezone}
          onChange={(event) => {
            setTimezone(event.target.value);
            localStorage.setItem('trinity.history.timezone', event.target.value);
          }}
        />
      </Flex>
      {error && <Alert type="error" message="History unavailable" description={error} />}
      <List
        dataSource={episodes}
        locale={{ emptyText: 'No indexed episodes in this page' }}
        renderItem={(episode) => (
          <List.Item
            actions={[
              <Button key="open" onClick={() => onOpen(episode.sessionId)}>
                Open
              </Button>,
              <Button
                key="topic"
                onClick={() => {
                  setTitle(episode.topic);
                  setEditing(episode);
                }}
              >
                Change topic
              </Button>,
              <Button
                key="exclude"
                onClick={() =>
                  void client
                    .reviseEpisode(episode.episodeId, { excluded: !episode.excluded })
                    .then(() => load())
                    .catch((error: unknown) => setError(String(error)))
                }
              >
                {episode.excluded ? 'Allow recall' : 'Exclude from recall'}
              </Button>,
            ]}
          >
            <List.Item.Meta
              title={
                <>
                  {episode.topic} {episode.excluded && <Tag>Excluded from recall</Tag>}
                </>
              }
              description={
                <>
                  <Typography.Text type="secondary">
                    {new Date(episode.at).toLocaleString()} · source events {episode.fromSeq}–
                    {episode.toSeq}
                  </Typography.Text>
                  <Typography.Paragraph ellipsis={{ rows: 2 }}>
                    {episode.request}
                  </Typography.Paragraph>
                  <Collapse
                    items={[
                      { key: 'outcome', label: 'Recorded outcome', children: episode.outcome },
                    ]}
                  />
                </>
              }
            />
          </List.Item>
        )}
      />
      {before !== null && <Button onClick={() => void load(before)}>Load older episodes</Button>}
      <Modal
        open={!!editing}
        title="Change topic"
        onCancel={() => setEditing(null)}
        onOk={() => {
          if (editing && title.trim())
            void client
              .reviseEpisode(editing.episodeId, { topic: title.trim() })
              .then(() => {
                setEditing(null);
                void load();
              })
              .catch((error: unknown) => setError(String(error)));
        }}
      >
        <Input maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
      </Modal>
    </section>
  );
}

export function AssistantTasks({
  sessions,
  onOpen,
}: {
  client: AcpClient;
  sessions: SessionSummary[];
  onOpen: (id: string) => void;
}): ReactElement {
  const [filter, setFilter] = useState('all');
  return (
    <section className="assistant-page">
      <Typography.Title level={2}>Tasks</Typography.Title>
      <Typography.Paragraph type="secondary">
        Open Work to view its recorded execution, approvals and results.
      </Typography.Paragraph>
      <Select
        aria-label="Task workspace filter"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All workspaces' },
          { value: 'active', label: 'Active' },
          { value: 'needs_approval', label: 'Needs you' },
          { value: 'completed', label: 'Completed' },
          { value: 'personal', label: 'Personal' },
          { value: 'team', label: 'Team' },
        ]}
      />
      <List
        dataSource={sessions.filter(
          (session) =>
            filter === 'all' ||
            session.scope === filter ||
            session.taskState === filter ||
            (filter === 'active' &&
              ['queued', 'running', 'needs_approval'].includes(session.taskState ?? '')),
        )}
        locale={{ emptyText: 'No Work tasks yet. Choose New → Work to start one.' }}
        renderItem={(session) => (
          <List.Item
            actions={[
              <Button key="open" onClick={() => onOpen(session.sessionId)}>
                Open task
              </Button>,
            ]}
          >
            <List.Item.Meta
              title={
                <>
                  {session.title || 'Untitled work'}{' '}
                  <Tag>{session.taskState?.replaceAll('_', ' ') ?? 'draft'}</Tag>
                </>
              }
              description={`${session.scope === 'team' ? 'Shared team workspace' : 'Personal workspace'} · ${new Date(session.createdAt).toLocaleString()}`}
            />
          </List.Item>
        )}
      />
    </section>
  );
}

export function MemoryContextDisclosure({ receipt }: { receipt: RecallReceipt }): ReactElement {
  return (
    <Collapse
      size="small"
      className="memory-context"
      items={[
        {
          key: 'memory',
          label: `Memory context · ${receipt.memories.length} saved · ${receipt.episodes.length} episodes`,
          children: (
            <>
              {receipt.commandResult && (
                <Typography.Paragraph>{receipt.commandResult}</Typography.Paragraph>
              )}
              <List
                size="small"
                dataSource={receipt.memories}
                locale={{ emptyText: 'No saved facts selected' }}
                renderItem={(item) => (
                  <List.Item>
                    <List.Item.Meta
                      title={item.predicate.replaceAll('_', ' ')}
                      description={`${item.value} · Personal · saved ${new Date(item.recordedAt).toLocaleDateString()}`}
                    />
                  </List.Item>
                )}
              />
              {receipt.episodes.map((episode) => (
                <details key={episode.episodeId}>
                  <summary>
                    {episode.topic} · {new Date(episode.at).toLocaleDateString()}
                  </summary>
                  <Typography.Paragraph>{episode.request}</Typography.Paragraph>
                  <Typography.Paragraph>{episode.outcome}</Typography.Paragraph>
                </details>
              ))}
              {receipt.omitted && (
                <Typography.Text type="secondary">
                  Some history was omitted or excluded from recall.
                </Typography.Text>
              )}
            </>
          ),
        },
      ]}
    />
  );
}
