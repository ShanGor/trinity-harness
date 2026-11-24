import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, Collapse, Flex, Input, List, Popconfirm, Tag, Typography } from 'antd';
import type { AcpClient } from '@trinity-harness/client-acp';
import { newId, type MemoryEvolutionResponse } from '@trinity-harness/shared';

type View = 'facts' | 'candidates' | 'playbooks';
/** Independent component state keeps adjudication/search from replacing an unsaved Persona draft. */
export function MemoryEvolution({ client }: { client: AcpClient }): ReactElement | null {
  const [response, setResponse] = useState<MemoryEvolutionResponse>({ available: false });
  const [view, setView] = useState<View>('candidates');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [before, setBefore] = useState<number>();
  const generation = useRef(0);
  const operation = useRef<{ key: string; id: string } | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    const epoch = ++generation.current;
    try {
      const value = await client.getMemoryEvolution(view, { query: search || undefined, before });
      if (epoch !== generation.current) return;
      setResponse(value);
      setError('');
    } catch {
      if (epoch === generation.current)
        setError('Memory suggestions are unavailable. Your Persona draft is preserved.');
    }
  }, [client, view, search, before]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  const act = async (
    key: string,
    mutate: (operationId: string) => Promise<void>,
  ): Promise<void> => {
    if (busy) return;
    setBusy(true);
    if (operation.current?.key !== key) operation.current = { key, id: newId() };
    try {
      await mutate(operation.current.id);
      operation.current = null;
      await refresh();
    } catch {
      setError(
        'The change could not be confirmed. Refresh to check the current source and revision.',
      );
    } finally {
      setBusy(false);
    }
  };
  if (!response.available) return error ? <Alert type="warning" message={error} /> : null;
  const { page, policyRevision } = response;
  const fence = { expectedRevision: page.revision, expectedPolicyRevision: policyRevision };
  return (
    <section aria-label="Archival memory" style={{ marginBlockStart: 24 }}>
      <Typography.Title level={3}>Archival memory</Typography.Title>
      <Typography.Paragraph>
        Suggestions require your acceptance. Facts and playbooks enter conversations only when
        recalled. Historical content is reference data and grants no permission to act.
      </Typography.Paragraph>
      {error && <Alert type="warning" message={error} />}
      <Flex gap={8} wrap style={{ marginBlockEnd: 12 }}>
        {(['candidates', 'facts', 'playbooks'] as const).map((v) => (
          <Button
            key={v}
            type={view === v ? 'primary' : 'default'}
            disabled={busy}
            onClick={() => {
              setView(v);
              setBefore(undefined);
            }}
          >
            {v === 'candidates' ? 'Suggestions' : v === 'facts' ? 'Fact timeline' : 'Playbooks'}
          </Button>
        ))}
        <Button
          disabled={busy}
          onClick={() => {
            operation.current = null;
            void refresh();
          }}
        >
          Refresh memory
        </Button>
      </Flex>
      <Input.Search
        aria-label="Search archival memory"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onSearch={(value) => {
          setSearch(value);
          setBefore(undefined);
        }}
        allowClear
      />
      {view === 'candidates' && (
        <List
          locale={{ emptyText: 'No pending suggestions' }}
          dataSource={page.candidates}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Button
                  key="accept"
                  disabled={
                    busy ||
                    (item.draft.type === 'fact' &&
                      !!item.draft.replacesFactId &&
                      !page.facts.some(
                        (fact) =>
                          fact.factId ===
                            (item.draft.type === 'fact' ? item.draft.replacesFactId : undefined) &&
                          fact.validTo === null,
                      ))
                  }
                  onClick={() =>
                    void act(`accept:${item.candidateId}`, (operationId) =>
                      client.decideMemoryCandidate({
                        ...fence,
                        operationId,
                        candidateId: item.candidateId,
                        decision: 'accept',
                      }),
                    )
                  }
                >
                  Accept
                </Button>,
                <Button
                  key="reject"
                  disabled={busy}
                  onClick={() =>
                    void act(`reject:${item.candidateId}`, (operationId) =>
                      client.decideMemoryCandidate({
                        ...fence,
                        operationId,
                        candidateId: item.candidateId,
                        decision: 'reject',
                      }),
                    )
                  }
                >
                  Reject
                </Button>,
              ]}
            >
              <Flex vertical>
                <Tag>{item.draft.type}</Tag>
                <Typography.Text>
                  {item.draft.type === 'fact' ? item.draft.fact.text : item.draft.playbook.taskType}
                </Typography.Text>
                {item.draft.type === 'fact' && item.draft.replacesFactId && (
                  <Typography.Paragraph>
                    Current:{' '}
                    <del>
                      {page.facts.find(
                        (fact) =>
                          fact.factId ===
                          (item.draft.type === 'fact' ? item.draft.replacesFactId : undefined),
                      )?.text ?? 'Original fact unavailable; refresh before accepting.'}
                    </del>
                    <br />
                    Proposed: <ins>{item.draft.fact.text}</ins>
                  </Typography.Paragraph>
                )}
                {item.draft.type === 'playbook' && (
                  <Typography.Paragraph>{item.draft.playbook.approach}</Typography.Paragraph>
                )}
                <Collapse
                  items={[
                    {
                      key: 'source',
                      label: 'Original sources',
                      children: (item.draft.type === 'fact'
                        ? [item.draft.fact.source]
                        : item.draft.playbook.sources
                      ).map((source, i) => (
                        <Typography.Paragraph key={i}>
                          {source.sourceQuote}
                          <br />
                          <Typography.Text type="secondary">
                            {source.sourceSessionId} · {source.sourceEventId}
                          </Typography.Text>
                        </Typography.Paragraph>
                      )),
                    },
                  ]}
                />
              </Flex>
            </List.Item>
          )}
        />
      )}
      {view === 'facts' && (
        <List
          locale={{ emptyText: 'No archival facts' }}
          dataSource={page.facts}
          renderItem={(fact) => (
            <List.Item
              actions={
                fact.validTo
                  ? []
                  : [
                      <Popconfirm
                        key="invalidate"
                        title="Stop recalling this fact?"
                        description="Its original conversation and audit history remain available."
                        onConfirm={() =>
                          act(`invalidate:${fact.factId}`, (operationId) =>
                            client.invalidateMemoryFact({
                              ...fence,
                              operationId,
                              factId: fact.factId,
                            }),
                          )
                        }
                      >
                        <Button disabled={busy}>Invalidate</Button>
                      </Popconfirm>,
                    ]
              }
            >
              <Flex vertical>
                <Typography.Text>{fact.text}</Typography.Text>
                <Tag>
                  {fact.kind} · {fact.validTo ? 'inactive' : 'active'}
                </Tag>
                <Typography.Text type="secondary">
                  {new Date(fact.validFrom).toLocaleString()}
                  {fact.validTo ? ` → ${new Date(fact.validTo).toLocaleString()}` : ''}
                </Typography.Text>
                <Typography.Paragraph>Source: {fact.source.sourceQuote}</Typography.Paragraph>
                {fact.invalidatedBy && (
                  <Flex vertical>
                    <Typography.Text type="secondary">
                      Replaced by {fact.invalidatedBy}
                    </Typography.Text>
                    <Typography.Paragraph>
                      <del>{fact.text}</del>
                      <br />
                      <ins>
                        {page.facts.find((item) => item.factId === fact.invalidatedBy)?.text ??
                          'Load the replacement to compare.'}
                      </ins>
                    </Typography.Paragraph>
                    <Button
                      onClick={() => {
                        setQuery(fact.invalidatedBy!);
                        setSearch(fact.invalidatedBy!);
                        setBefore(undefined);
                      }}
                    >
                      Compare replacement
                    </Button>
                  </Flex>
                )}
              </Flex>
            </List.Item>
          )}
        />
      )}
      {view === 'playbooks' && (
        <List
          locale={{ emptyText: 'No reviewed playbooks' }}
          dataSource={page.playbooks}
          renderItem={(book) => (
            <List.Item>
              <Flex vertical>
                <Typography.Text strong>{book.taskType}</Typography.Text>
                <Tag>Reference only</Tag>
                <Typography.Paragraph>{book.approach}</Typography.Paragraph>
                {book.pitfalls.map((p, i) => (
                  <Typography.Paragraph key={i}>{p}</Typography.Paragraph>
                ))}
              </Flex>
            </List.Item>
          )}
        />
      )}
      {page.nextBefore && (
        <Button disabled={busy} onClick={() => setBefore(page.nextBefore ?? undefined)}>
          Next page
        </Button>
      )}
      {before && (
        <Button disabled={busy} onClick={() => setBefore(undefined)}>
          First page
        </Button>
      )}
    </section>
  );
}
