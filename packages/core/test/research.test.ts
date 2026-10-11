import { describe, expect, it } from 'vitest';
import {
  researchNotesSchema,
  researchPageSchema,
  sessionEventSchema,
  type BlobStore,
  type ResearchNotes,
  type SessionEvent,
} from '@trinity-harness/contracts';
import {
  CoreToolRegistry,
  MemorySessionStore,
  createResearchTool,
  researchPageFromOutput,
} from '../src/index.js';
import { FakeSandbox } from '../src/testing/index.js';
const meta = () => ({ eventId: crypto.randomUUID(), at: '2026-01-01T00:00:00.000Z' });
const page = {
  kind: 'trinity-research-page-v1',
  url: 'https://example.com/announcement',
  title: 'Announcement',
  publishedAt: null,
  text: 'Interactive apps are available in Product A. Agents can be distributed through Product B.',
  truncated: false,
  links: [],
};
const notes: ResearchNotes = {
  question: 'Does Product B render interactive apps?',
  findings: [
    {
      claim:
        'Product A supports the interactive experience; Product B distribution is mentioned separately.',
      relation: 'context',
      sources: [
        { callId: 'source', url: page.url, quote: 'Interactive apps are available in Product A.' },
      ],
    },
  ],
  openQuestions: ['Does Product B render the same UI?'],
  readyToAnswer: false,
};
function observation(name = 'bash', isError = false, document = page): SessionEvent[] {
  return [
    {
      ...meta(),
      type: 'tool/call',
      callId: 'source',
      name,
      args: {
        command:
          'agent-browser --session s --cdp 9222 --pin-tab --json eval "document.body.textContent"',
      },
    },
    {
      ...meta(),
      type: 'tool/result',
      callId: 'source',
      isError,
      value: {
        stdout: JSON.stringify({ success: true, data: { result: document } }),
        stderr: '',
        exitCode: isError ? 1 : 0,
      },
    },
  ];
}
async function assembly(): Promise<{ store: MemorySessionStore; registry: CoreToolRegistry }> {
  const store = new MemorySessionStore();
  await store.append('s', [
    {
      ...meta(),
      type: 'message/user',
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'research' }],
    },
    ...observation(),
  ]);
  const registry = new CoreToolRegistry(new FakeSandbox());
  registry.register(createResearchTool(store));
  return { store, registry };
}
const ctx = { sessionId: 's', workspaceRoot: '/ws' };
describe('research evidence notes', () => {
  it('parses CLI eval envelopes and rejects errors/invalid source URLs', () => {
    expect(
      researchPageFromOutput(JSON.stringify({ success: true, data: { result: page } })),
    ).toEqual(page);
    expect(researchPageFromOutput(JSON.stringify(JSON.stringify(page)))).toEqual(page);
    expect(
      researchPageFromOutput(JSON.stringify({ success: false, data: { result: page } })),
    ).toBeNull();
    expect(
      researchPageSchema.safeParse({ ...page, url: 'https://user:secret@example.com/' }).success,
    ).toBe(false);
  });
  it('records observed citations and recovers them from validated events after restart', async () => {
    const { store, registry } = await assembly();
    const result = await registry.execute(
      { id: 'notes', name: 'research', args: { action: 'record', notes } },
      ctx,
    );
    expect(result).toMatchObject({
      isError: false,
      value: { kind: 'research-notes', promptSeq: 1, notes },
    });
    await store.append('s', [
      {
        ...meta(),
        type: 'tool/call',
        callId: 'notes',
        name: 'research',
        args: { action: 'record', notes },
      },
      { ...meta(), type: 'tool/result', callId: 'notes', ...result },
    ]);
    const replay = (await store.load('s')).map((event) =>
      sessionEventSchema.parse(JSON.parse(JSON.stringify(event))),
    );
    const restored = new MemorySessionStore();
    await restored.append('s', replay);
    const registry2 = new CoreToolRegistry(new FakeSandbox());
    registry2.register(createResearchTool(restored));
    expect(
      await registry2.execute({ id: 'status', name: 'research', args: { action: 'status' } }, ctx),
    ).toEqual(result);
  });
  it.each(['unknown-call', 'wrong-url', 'invented-quote'])('rejects %s', async (issue) => {
    const { registry } = await assembly();
    const altered = structuredClone(notes);
    const source = altered.findings[0]!.sources[0]!;
    if (issue === 'unknown-call') source.callId = 'missing';
    if (issue === 'wrong-url') source.url = 'https://example.com/elsewhere';
    if (issue === 'invented-quote') source.quote = 'Product B definitely supports the same UI.';
    expect(
      await registry.execute(
        { id: 'bad', name: 'research', args: { action: 'record', notes: altered } },
        ctx,
      ),
    ).toMatchObject({
      isError: true,
      value: {
        code: 'RESEARCH_SOURCE_MISMATCH',
        reason:
          issue === 'unknown-call'
            ? 'unknown_call'
            : issue === 'wrong-url'
              ? 'url_mismatch'
              : 'quote_mismatch',
        sourceUrl: source.url,
        rejectedQuote: source.quote,
        observedTextExcerpt: page.text,
        observedSources: [{ callId: 'source', url: page.url }],
      },
    });
  });
  it('does not accept failed, unrelated, or previous-turn observations', async () => {
    for (const observations of [observation('other'), observation('bash', true)]) {
      const { store, registry } = await assembly();
      await store.append('s', [
        {
          ...meta(),
          type: 'message/user',
          surfaceOp: 'append',
          content: [{ kind: 'text', text: 'next' }],
        },
        ...observations,
      ]);
      expect(
        (
          await registry.execute(
            { id: 'n', name: 'research', args: { action: 'record', notes } },
            ctx,
          )
        ).isError,
      ).toBe(true);
    }
    const { store, registry } = await assembly();
    await store.append('s', [
      {
        ...meta(),
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'next' }],
      },
    ]);
    expect(
      (
        await registry.execute(
          { id: 'n', name: 'research', args: { action: 'record', notes } },
          ctx,
        )
      ).isError,
    ).toBe(true);
  });
  it('locates bounded verbatim recovery text after punctuation changes and accepts a corrected retry', async () => {
    const { store, registry } = await assembly();
    const document = {
      ...page,
      text:
        'Unrelated navigation. '.repeat(80) +
        '论文标题：Late-life treatment extends lifespan 查看更多 期刊：Nature “原文”',
    };
    await store.append('s', observation('bash', false, document));
    const altered = structuredClone(notes);
    const source = altered.findings[0]!.sources[0]!;
    source.quote = '论文标题:Late-life treatment extends lifespan 查看更多 期刊:Nature “原文”';
    const rejected = await registry.execute(
      { id: 'bad', name: 'research', args: { action: 'record', notes: altered } },
      ctx,
    );
    expect(rejected).toMatchObject({
      isError: true,
      value: {
        reason: 'quote_mismatch',
        observedTextExcerpt:
          '论文标题：Late-life treatment extends lifespan 查看更多 期刊：Nature “原文”',
      },
    });
    const value = rejected.value as { message: string; observedTextExcerpt: string };
    expect(value.message).toContain('notes.findings[0].sources[0]');
    expect(value.message).toContain(
      'Keep note validation and retry commentary out of the final answer',
    );
    expect(value.observedTextExcerpt.length).toBeLessThanOrEqual(600);
    source.quote = value.observedTextExcerpt.replace(' 查看更多 ', '\n查看更多\n');
    expect(
      await registry.execute(
        { id: 'retry', name: 'research', args: { action: 'record', notes: altered } },
        ctx,
      ),
    ).toMatchObject({ isError: false, value: { notes: altered } });
  });
  it.each([
    '论文标题：Example 期刊：Nature',
    '论文标题:Example 查看更多 期刊:Nature',
    '论文标题：Example 查看更多 期刊：Nature "原文"',
  ])('keeps rejecting omitted text or changed punctuation: %s', async (quote) => {
    const { store, registry } = await assembly();
    await store.append(
      's',
      observation('bash', false, {
        ...page,
        text: '论文标题：Example 查看更多 期刊：Nature “原文”',
      }),
    );
    const altered = structuredClone(notes);
    altered.findings[0]!.sources[0]!.quote = quote;
    expect(
      await registry.execute(
        { id: 'bad', name: 'research', args: { action: 'record', notes: altered } },
        ctx,
      ),
    ).toMatchObject({ isError: true, value: { reason: 'quote_mismatch' } });
  });
  it('bounds notes and rejects empty evidence without manufacturing answers', () => {
    const invalid = structuredClone(notes);
    invalid.findings[0]!.sources[0]!.quote = '   ';
    expect(researchNotesSchema.safeParse(invalid).success).toBe(false);
    expect(
      researchNotesSchema.safeParse({ ...notes, openQuestions: Array(9).fill('more') }).success,
    ).toBe(false);
    expect(
      researchNotesSchema.safeParse({ ...notes, findings: [], readyToAnswer: false }).success,
    ).toBe(true);
  });
  it('honors cancellation before accessing the store', async () => {
    const { registry } = await assembly();
    const signal = AbortSignal.abort();
    expect(
      (
        await registry.execute(
          { id: 'n', name: 'research', args: { action: 'status' } },
          { ...ctx, signal },
        )
      ).isError,
    ).toBe(true);
  });
});

it('resolves omitted extraction call IDs using observed URL and passage', async () => {
  const { registry } = await assembly();
  const withoutId = structuredClone(notes);
  delete withoutId.findings[0]!.sources[0]!.callId;
  expect(
    await registry.execute(
      { id: 'auto', name: 'research', args: { action: 'record', notes: withoutId } },
      ctx,
    ),
  ).toMatchObject({
    isError: false,
    value: { notes: { findings: [{ sources: [{ callId: 'source' }] }] } },
  });
});

it('shares a validated 64-step default across the core and app environment schemas', async () => {
  const { turnStepBudgetSchema, DEFAULT_TURN_MAX_STEPS } =
    await import('@trinity-harness/contracts');
  expect(DEFAULT_TURN_MAX_STEPS).toBe(64);
  expect(turnStepBudgetSchema.parse(undefined)).toBe(64);
  expect(turnStepBudgetSchema.parse('64')).toBe(64);
  expect(turnStepBudgetSchema.parse('128')).toBe(128);
  for (const invalid of [0, -1, 'abc', 1.5, 1025])
    expect(turnStepBudgetSchema.safeParse(invalid).success).toBe(false);
});

it('exposes an object parameter schema for provider tool compatibility and requires notes for record', async () => {
  const { registry } = await assembly();
  expect(registry.schemas()[0]?.parameters.type).toBe('object');
  expect(
    (await registry.execute({ id: 'invalid', name: 'research', args: { action: 'record' } }, ctx))
      .isError,
  ).toBe(true);
});

it('recovers spilled browser evidence and notes through session-scoped blobs', async () => {
  const store = new MemorySessionStore();
  const data = new Map<string, Uint8Array>();
  const blobs: BlobStore = {
    put: async () => {
      throw new Error('not used');
    },
    delete: async () => undefined,
    get: async (uri) => data.get(uri) ?? null,
    getMeta: async (uri) =>
      data.has(uri)
        ? { key: uri.slice(7), uri, mimeType: 'application/json', size: data.get(uri)!.byteLength }
        : null,
  };
  const events = observation();
  const sourceResult = events[1] as Extract<SessionEvent, { type: 'tool/result' }>;
  const uri = 'blob://spill/s/source.json';
  data.set(uri, new TextEncoder().encode(JSON.stringify(sourceResult.value)));
  sourceResult.value = { spilled: uri, bytes: data.get(uri)!.byteLength, preview: '' };
  await store.append('s', [
    {
      ...meta(),
      type: 'message/user',
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'research' }],
    },
    ...events,
  ]);
  const registry = new CoreToolRegistry(new FakeSandbox());
  registry.register(createResearchTool(store, blobs));
  const recorded = await registry.execute(
    { id: 'notes', name: 'research', args: { action: 'record', notes } },
    ctx,
  );
  expect(recorded.isError).toBe(false);
  const notesUri = 'blob://spill/s/notes.json';
  data.set(notesUri, new TextEncoder().encode(JSON.stringify(recorded.value)));
  await store.append('s', [
    {
      ...meta(),
      type: 'tool/call',
      callId: 'notes',
      name: 'research',
      args: { action: 'record', notes },
    },
    {
      ...meta(),
      type: 'tool/result',
      callId: 'notes',
      isError: false,
      value: { spilled: notesUri, bytes: data.get(notesUri)!.byteLength, preview: '' },
    },
  ]);
  expect(
    await registry.execute({ id: 'status', name: 'research', args: { action: 'status' } }, ctx),
  ).toEqual(recorded);
});
