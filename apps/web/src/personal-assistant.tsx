import { readHistoryTimezone, saveHistoryTimezone } from './history-timezone';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  Alert,
  Button,
  Collapse,
  Flex,
  Input,
  List,
  Modal,
  Select,
  Switch,
  Tag,
  Typography,
  App,
} from 'antd';
import type { AcpClient, SessionSummary } from '@trinity-harness/client-acp';
import { newId } from '@trinity-harness/shared';
import type { Persona, PersonaHistory, TopicEpisode, RecallReceipt } from '@trinity-harness/shared';

export function AssistantMemory({
  client,
  sessionId,
}: {
  client: AcpClient;
  sessionId: string | null;
}): ReactElement {
  const { message } = App.useApp();
  const [persona, setPersona] = useState<Persona>({ content: '', revision: 0, updatedAt: null });
  const [draft, setDraft] = useState('');
  const [autoSave, setAutoSave] = useState(true);
  const [history, setHistory] = useState<PersonaHistory>({ revisions: [], nextBefore: null });
  const [historyError, setHistoryError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [receipts, setReceipts] = useState<{ at: string; receipt: RecallReceipt }[]>([]);
  const refresh = useCallback(async () => {
    try {
      const snapshot = await client.getMemory();
      const current = snapshot.persona ?? {
        content: snapshot.items
          .filter((item) => item.status === 'active')
          .map((item) => `- ${item.subject} · ${item.predicate}: ${item.value}`)
          .join('\n'),
        revision: 0,
        updatedAt: null,
      };
      setPersona(current);
      setDraft(current.content);
      setAutoSave(current.autoSaveEnabled ?? true);
      setLoaded(true);
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
  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const saved = await client.savePersona({
        content: draft,
        autoSaveEnabled: autoSave,
        expectedRevision: persona.revision,
        operationId: newId(),
      });
      setPersona(saved);
      setDraft(saved.content);
      setError('');
      message.success('Persona saved.');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  const loadHistory = async (before?: number): Promise<void> => {
    try {
      const page = await client.getPersonaHistory(before);
      setHistory((current) => ({
        revisions: before ? [...current.revisions, ...page.revisions] : page.revisions,
        nextBefore: page.nextBefore,
      }));
      setHistoryError('');
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <section className="assistant-page">
      <Typography.Title level={2}>Memory</Typography.Title>
      <Typography.Paragraph type="secondary">
        Edit your personal facts and preferences as Markdown. This Persona is included in your
        personal chats; team tasks receive no personal memory.
      </Typography.Paragraph>
      {error && (
        <Alert type="error" message="Persona unavailable or not saved" description={error} />
      )}
      <Flex gap="small" align="center" style={{ marginBottom: 16 }}>
        <Switch
          aria-label="Automatic personal memory"
          checked={autoSave}
          disabled={!loaded || saving}
          onChange={setAutoSave}
        />
        <Typography.Text>
          Automatically remember stable facts and preferences from my messages
        </Typography.Text>
      </Flex>
      <Input.TextArea
        aria-label="Persona Markdown"
        value={draft}
        disabled={!loaded || saving}
        maxLength={16000}
        showCount
        autoSize={{ minRows: 12, maxRows: 28 }}
        placeholder={'## About me\nMy name is…\n\n## Preferences\n'}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Flex gap="small" style={{ marginBlock: 16 }}>
        <Button
          type="primary"
          loading={saving}
          disabled={
            !loaded ||
            (draft === persona.content && autoSave === (persona.autoSaveEnabled ?? true)) ||
            draft.length > 16000
          }
          onClick={() => void save()}
        >
          Save Persona
        </Button>
        <Button disabled={saving} onClick={() => void refresh()}>
          Reload saved Persona
        </Button>
        <Typography.Text type="secondary">Revision {persona.revision}</Typography.Text>
      </Flex>
      <Collapse
        onChange={(keys) => {
          if (keys.includes('versions')) void loadHistory();
        }}
        items={[
          {
            key: 'versions',
            label: 'Persona versions and sources',
            children: (
              <>
                {historyError && <Alert type="error" message={historyError} />}
                {history.revisions.map((revision) => (
                  <details key={revision.revision}>
                    <summary>
                      Revision {revision.revision} ·{' '}
                      {revision.updatedAt ? new Date(revision.updatedAt).toLocaleString() : ''} ·{' '}
                      {revision.source
                        ? 'Assistant update from your message'
                        : 'Manual edit or migration'}
                    </summary>
                    <pre style={{ whiteSpace: 'pre-wrap' }}>
                      {revision.content || '(Empty Persona)'}
                    </pre>
                    {revision.source && (
                      <Typography.Paragraph>
                        Source: {revision.source.excerpt} · conversation {revision.source.sessionId}{' '}
                        · event {revision.source.eventId}
                      </Typography.Paragraph>
                    )}
                  </details>
                ))}
                {history.nextBefore !== null && (
                  <Button onClick={() => void loadHistory(history.nextBefore ?? undefined)}>
                    Load older versions
                  </Button>
                )}
              </>
            ),
          },
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
        Clearing Persona removes it from future context. Original conversations and revision history
        remain retained; exclude source conversations in History to prevent historical recall.
      </Typography.Paragraph>
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
  const [timezone, setTimezone] = useState(readHistoryTimezone);
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
            saveHistoryTimezone(event.target.value);
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
              {receipt.persona && (
                <pre style={{ whiteSpace: 'pre-wrap' }}>
                  Persona · revision {receipt.persona.revision}
                  {'\n'}
                  {receipt.persona.content}
                </pre>
              )}
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
