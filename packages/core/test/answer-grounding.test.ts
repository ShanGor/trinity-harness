import { describe, expect, it } from 'vitest';
import {
  projectMessages,
  sessionEventSchema,
  type SessionEvent,
  type BlobStore,
} from '@trinity-harness/contracts';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  bashTool,
  readFileTool,
  toModelMessages,
} from '../src/index.js';
import { answerGrounding } from '../src/loop/answer-grounding.js';
import { FakeLLM, textChunks, toolCallThenFinish } from '../src/testing/fake-llm.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';

const meta = () => ({ eventId: crypto.randomUUID(), at: '2026-10-09T00:00:00.000Z' });
const user = (): SessionEvent => ({
  ...meta(),
  type: 'message/user',
  surfaceOp: 'append',
  content: [{ kind: 'text', text: 'Research this' }],
});
const page = {
  kind: 'trinity-research-page-v1',
  url: 'https://example.com/announcement',
  title: 'Primary announcement',
  publishedAt: null,
  text: 'Product A supports interactive apps.',
  truncated: false,
  links: [],
};
const pair = (id: string, name: string, value: unknown, isError = false): SessionEvent[] => [
  {
    ...meta(),
    type: 'tool/call',
    callId: id,
    name,
    args: { command: "agent-browser --json eval 'trinity-research-page-v1'" },
  },
  { ...meta(), type: 'tool/result', callId: id, value, isError },
];
const browserResult = {
  stdout: JSON.stringify({ success: true, data: { result: page } }),
  exitCode: 0,
};

describe('final answer grounding', () => {
  it('includes observed research claims and excludes mismatched claim provenance', async () => {
    const finding = {
      claim: 'Product A supports interactive apps.',
      relation: 'supports',
      sources: [{ callId: 'read', url: page.url, quote: page.text }],
    };
    const notes = {
      question: 'Which product?',
      findings: [
        finding,
        {
          ...finding,
          claim: 'Invented claim',
          sources: [{ callId: 'missing', url: page.url, quote: page.text }],
        },
      ],
      openQuestions: [],
      readyToAnswer: true,
    };
    const citations = await answerGrounding(
      [
        user(),
        ...pair('read', 'bash', browserResult),
        ...pair('notes', 'research', { kind: 'research-notes', promptSeq: 1, notes }),
      ],
      1,
      's',
    );
    expect(citations.map((citation) => citation.kind)).toEqual(['web_source', 'research_claim']);
    expect(citations[1]).toMatchObject({
      claimText: finding.claim,
      sourceUrls: [page.url],
      detail: page.text,
      callId: 'notes',
      evidenceSeq: 5,
    });
  });
  it('recovers spilled reference metadata without reading another session', async () => {
    const uri = 'blob://spill/s/read.json';
    const bytes = new TextEncoder().encode(JSON.stringify(browserResult));
    const blobs: BlobStore = {
      put: async () => {
        throw new Error('unused');
      },
      delete: async () => undefined,
      get: async (key) => (key === uri ? bytes : null),
      getMeta: async (key) =>
        key === uri
          ? { uri, key: 'spill/s/read.json', mimeType: 'application/json', size: bytes.byteLength }
          : null,
    };
    const events = [user(), ...pair('read', 'bash', { spilled: uri })];
    expect((await answerGrounding(events, 1, 's', blobs))[0]).toMatchObject({
      url: page.url,
      callId: 'read',
    });
    expect(await answerGrounding(events, 1, 'other', blobs)).toEqual([]);
  });
  it('deduplicates observed web documents and records replayable evidence locations', async () => {
    const citations = await answerGrounding(
      [user(), ...pair('one', 'bash', browserResult), ...pair('two', 'bash', browserResult)],
      1,
      's',
    );
    expect(citations).toEqual([
      {
        kind: 'web_source',
        url: page.url,
        label: page.title,
        detail: page.text,
        callId: 'two',
        evidenceSeq: 5,
      },
    ]);
  });
  it('excludes failed observations, other tools, invented links and earlier prompts', async () => {
    const old = [user(), ...pair('old', 'bash', browserResult), user()];
    const current = [
      ...old,
      ...pair('bad', 'bash', browserResult, true),
      ...pair('fake', 'other', browserResult),
    ];
    expect(await answerGrounding(current, old.length, 's')).toEqual([]);
  });
  it('includes read workspace files without duplicating file contents', async () => {
    const citations = await answerGrounding(
      [
        user(),
        ...pair('read', 'read_file', { path: 'docs/design.md', content: 'Private full contents' }),
        ...pair('escape', 'read_file', { path: '../secret', content: 'secret' }),
      ],
      1,
      's',
    );
    expect(citations).toEqual([
      {
        kind: 'workspace_reference',
        label: 'docs/design.md',
        path: 'docs/design.md',
        callId: 'read',
        evidenceSeq: 3,
      },
    ]);
  });
  it('persists grounding only on the final answer and keeps progress outside subsequent context', async () => {
    const store = new MemorySessionStore();
    const sandbox = new FakeSandbox();
    sandbox.execHandler = () => ({ ...browserResult, stderr: '' });
    sandbox.files.set('notes.md', 'notes');
    const tools = new CoreToolRegistry(sandbox);
    tools.register(bashTool);
    tools.register(readFileTool);
    const llm = new FakeLLM(
      () => [
        { kind: 'text-delta', text: 'I will inspect the announcement.' },
        ...toolCallThenFinish('browser', 'bash', {
          command: "agent-browser --json eval 'trinity-research-page-v1'",
        }),
      ],
      (request) => {
        expect(JSON.stringify(request.messages)).not.toContain('I will inspect');
        return toolCallThenFinish('file', 'read_file', { path: 'notes.md' });
      },
      () => textChunks('Product A supports apps. [Announcement](https://example.com/announcement)'),
    );
    const loop = new CoreAgentLoop({ llm, tools, store, model: 'fake', workspaceRoot: '/ws' });
    expect(await loop.run('s', 'Research this', { emit: () => {} })).toEqual({
      reason: 'completed',
      steps: 3,
    });
    const events = await store.load('s');
    const assistant = events.filter((event) => event.type === 'message/assistant');
    expect(assistant.map((event) => event.phase)).toEqual(['progress', 'final']);
    expect(assistant[1]?.citationList).toHaveLength(2);
    expect(events.map((event) => sessionEventSchema.parse(event))).toEqual(events);
    expect(projectMessages(events)).toHaveLength(2);
    const context = toModelMessages(events);
    expect(context).toHaveLength(2);
    expect(context[1]?.content).toContain('Sources:');
    expect(context[1]?.content).toContain('notes.md');
    expect(JSON.stringify(context)).not.toContain('I will inspect');
    const replay = new MemorySessionStore();
    await replay.append('s', structuredClone(events));
    expect(await replay.projectMessages('s')).toEqual(await store.projectMessages('s'));
  });
  it('does not promote progress to an answer after cancellation', () => {
    const events: SessionEvent[] = [
      user(),
      {
        ...meta(),
        type: 'message/assistant',
        surfaceOp: 'append',
        phase: 'progress',
        content: [{ kind: 'text', text: 'Still searching' }],
      },
      { ...meta(), type: 'turn/end', reason: 'aborted' },
    ];
    expect(projectMessages(events).map((message) => message.role)).toEqual(['user']);
    expect(JSON.stringify(toModelMessages(events))).not.toContain('Still searching');
  });
  it('keeps required reasoning/tool pairs during active execution while excluding progress text', () => {
    const events: SessionEvent[] = [
      user(),
      {
        ...meta(),
        type: 'message/assistant',
        surfaceOp: 'append',
        phase: 'progress',
        content: [
          { kind: 'text', text: 'Working' },
          { kind: 'reasoning', text: 'provider reasoning', signature: 'sig' },
        ],
      },
      ...pair('call', 'bash', { stdout: 'observed', exitCode: 0 }),
    ];
    expect(toModelMessages(events)[1]).toMatchObject({
      content: '',
      reasoning: [{ text: 'provider reasoning', signature: 'sig' }],
      toolCalls: [{ id: 'call' }],
    });
  });
});
