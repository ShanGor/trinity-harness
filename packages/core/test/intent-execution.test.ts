import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type {
  BlobMeta,
  BlobStore,
  ConversationIndexPort,
  MemoryStorePort,
  SessionMeta,
  SessionMetaStore,
} from '@trinity-harness/contracts';
import { sessionEventSchema, taskStatusSchema } from '@trinity-harness/contracts';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  PersonalContext,
  ContextManager,
  createTaskTool,
  createRecallTool,
  createReadBlobTool,
  readFileTool,
  writeFileTool,
  toModelMessages,
} from '../src/index.js';
import { taskState, taskVerification } from '../src/loop/task-verification.js';
import { FakeLLM, textChunks, toolCallThenFinish } from '../src/testing/fake-llm.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';
import { intentRuntime } from './fixtures/intent-runtime.js';

const at = '2026-10-22T00:00:00.000Z';
const meta = () => ({ eventId: randomUUID(), at });
const sink = { emit: () => undefined };

class TestBlobs implements BlobStore {
  readonly data = new Map<string, Uint8Array>();
  async put(
    key: string | undefined,
    data: Uint8Array,
    options: { mimeType: string },
  ): Promise<BlobMeta> {
    const actual = key ?? randomUUID();
    const uri = `blob://${actual}`;
    this.data.set(uri, data.slice());
    return { key: actual, uri, mimeType: options.mimeType, size: data.byteLength };
  }
  async get(uri: string): Promise<Uint8Array | null> {
    return this.data.get(uri) ?? null;
  }
  async getMeta(uri: string): Promise<BlobMeta | null> {
    const data = this.data.get(uri);
    return data
      ? { key: uri.slice(7), uri, mimeType: 'application/json', size: data.byteLength }
      : null;
  }
  async delete(uri: string): Promise<void> {
    this.data.delete(uri);
  }
}

async function fixture() {
  const store = new MemorySessionStore();
  const owner: SessionMeta = {
    id: randomUUID(),
    tenantId: randomUUID(),
    userId: randomUUID(),
    title: 'Conversation',
    kind: 'chat',
    sessionRole: 'side',
    scope: 'personal',
    workspaceUri: '/ws',
    createdAt: at,
  };
  await store.append(owner.id, [
    { ...meta(), type: 'session/created', workspaceUri: '/ws', kind: 'chat', sessionRole: 'side' },
  ]);
  const memory: MemoryStorePort = {
    snapshot: vi.fn(async () => ({ revision: 0, items: [], hasSuppression: false })),
    change: vi.fn(),
    changeMany: vi.fn(),
  };
  const index: ConversationIndexPort = {
    history: vi.fn(async () => ({ episodes: [], nextBefore: null })),
    evidence: vi.fn(async () => null),
    revise: vi.fn(),
  };
  const metas = { get: async (id: string) => (id === owner.id ? owner : null) } as SessionMetaStore;
  const context = new PersonalContext(memory, index, store);
  const sandbox = new FakeSandbox();
  const tools = new CoreToolRegistry(sandbox);
  tools.register(readFileTool);
  tools.register(createTaskTool(store));
  tools.register(createRecallTool({ memory, index, metas, store }));
  const blobs = new TestBlobs();
  const loop = (llm: FakeLLM, compaction?: ContextManager) =>
    new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools,
      store,
      workspaceRoot: '/ws',
      verification: true,
      personalContext: context,
      sessionMetas: metas,
      spill: { store: blobs },
      context: compaction,
    });
  return { store, owner, memory, index, metas, context, sandbox, tools, blobs, loop };
}

async function completed(
  store: MemorySessionStore,
  id: string,
  request: string,
  answer: string,
): Promise<{ promptId: string; answerId: string }> {
  const promptId = randomUUID();
  const answerId = randomUUID();
  await store.append(id, [
    {
      eventId: promptId,
      at,
      type: 'message/user',
      surfaceOp: 'append',
      content: [{ kind: 'text', text: request }],
    },
    {
      eventId: answerId,
      at,
      type: 'message/assistant',
      phase: 'final',
      surfaceOp: 'append',
      content: [{ kind: 'text', text: answer }],
    },
    { ...meta(), type: 'turn/end', promptId, reason: 'completed' },
  ]);
  return { promptId, answerId };
}

describe('intent context and recovery', () => {
  it('keeps local dialogue and current wording without adding unrelated account history', async () => {
    const f = await fixture();
    await completed(
      f.store,
      f.owner.id,
      'How should I build a coding agent?',
      'Use a small tool loop and preserve context.',
    );
    vi.mocked(f.index.history).mockResolvedValue({
      episodes: [
        {
          episodeId: randomUUID(),
          promptId: randomUUID(),
          sessionId: randomUUID(),
          fromSeq: 1,
          toSeq: 3,
          at,
          topic: 'Hardware',
          request: 'Choose a local model',
          outcome: 'UNRELATED HARDWARE RECOMMENDATION',
          excluded: false,
          policyRevision: 0,
        },
      ],
      nextBefore: null,
    });
    const llm = new FakeLLM((request) => {
      expect(
        request.messages.some(
          (m) => m.role === 'assistant' && m.content.startsWith('Use a small tool loop'),
        ),
      ).toBe(true);
      expect(request.messages.at(-1)?.content).toBe('translate into Chinese');
      expect(JSON.stringify(request.messages)).not.toContain('UNRELATED HARDWARE');
      return textChunks('使用一个小型工具循环，并保留上下文。');
    });
    expect((await f.loop(llm).run(f.owner.id, 'translate into Chinese', sink)).reason).toBe(
      'completed',
    );
    expect(f.index.history).not.toHaveBeenCalled();
    expect(
      (await f.store.load(f.owner.id)).filter((e) => e.type === 'memory/selection'),
    ).toHaveLength(1);
    expect((await f.store.load(f.owner.id)).some((e) => e.type === 'task/recovery')).toBe(false);
  });

  it('retains older and multiple referents instead of binding every followup to the latest answer', async () => {
    const f = await fixture();
    await completed(f.store, f.owner.id, 'First approach?', 'Approach A uses a queue.');
    await completed(f.store, f.owner.id, 'Alternative?', 'Approach B uses direct calls.');
    await completed(f.store, f.owner.id, 'What time is the meeting?', 'The meeting is at noon.');
    const llm = new FakeLLM((request) => {
      expect(JSON.stringify(request.messages)).toContain('Approach A');
      expect(JSON.stringify(request.messages)).toContain('Approach B');
      expect(request.messages.at(-1)?.content).toBe(
        'Compare the first two approaches, ignoring the meeting.',
      );
      return textChunks('A decouples delivery; B is simpler for synchronous work.');
    });
    expect(
      (
        await f
          .loop(llm)
          .run(f.owner.id, 'Compare the first two approaches, ignoring the meeting.', sink)
      ).reason,
    ).toBe('completed');
  });

  it('expands a truncated original source and fences exclusion after selection', async () => {
    const f = await fixture();
    const source = await completed(
      f.store,
      f.owner.id,
      'Explain the design',
      'Original body. '.repeat(500),
    );
    const promptId = randomUUID();
    await f.store.append(f.owner.id, [
      {
        eventId: promptId,
        at,
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'Explain the last section' }],
      },
    ]);
    const receipt = await f.context.select(
      f.owner,
      promptId,
      'Explain the last section',
      undefined,
      at,
      1000,
    );
    expect(receipt.dialogue?.[0]?.answer.totalCharacters).toBeGreaterThan(
      receipt.dialogue![0]!.answer.to,
    );
    const recalled = await f.tools.execute(
      { id: 'source', name: 'recall', args: { eventId: source.answerId, offset: 1000 } },
      { sessionId: f.owner.id, workspaceRoot: '/ws' },
    );
    expect(recalled).toMatchObject({
      isError: false,
      value: { sources: [{ from: 1000, text: 'Original body. '.repeat(500).slice(1000, 5000) }] },
    });
    const pastEnd = await f.tools.execute(
      { id: 'past-end', name: 'recall', args: { eventId: source.answerId, offset: 200001 } },
      { sessionId: f.owner.id, workspaceRoot: '/ws' },
    );
    expect(pastEnd).toMatchObject({
      isError: false,
      value: {
        sources: [
          {
            from: 'Original body. '.repeat(500).length,
            to: 'Original body. '.repeat(500).length,
            text: '',
          },
        ],
      },
    });
    vi.mocked(f.index.evidence!).mockResolvedValue({
      episodeId: source.promptId,
      promptId: source.promptId,
      sessionId: f.owner.id,
      fromSeq: 2,
      toSeq: 4,
      at,
      request: 'Explain the design',
      outcome: '',
      topic: 'Design',
      excluded: true,
      policyRevision: 0,
    });
    await expect(f.context.validate(f.owner, receipt)).rejects.toMatchObject({
      code: 'MEMORY_CONTEXT_CHANGED',
    });
    expect(
      (
        await f.tools.execute(
          { id: 'excluded', name: 'recall', args: { eventId: source.answerId } },
          { sessionId: f.owner.id, workspaceRoot: '/ws' },
        )
      ).isError,
    ).toBe(true);
  });

  it('uses every committed text block despite a mismatched retry caller', async () => {
    const f = await fixture();
    await f.store.append(f.owner.id, [
      {
        ...meta(),
        type: 'message/user',
        surfaceOp: 'append',
        content: [
          { kind: 'text', text: 'Compare both designs.' },
          { kind: 'text', text: 'Keep the budget below 50.' },
        ],
      },
    ]);
    const promptSeq = (await f.store.load(f.owner.id)).length;
    const select = vi.spyOn(f.context, 'select');
    const llm = new FakeLLM((request) => {
      expect(request.messages.at(-1)?.content).toBe(
        'Compare both designs.\nKeep the budget below 50.',
      );
      return textChunks('Comparison within the stated budget.');
    });
    await f.loop(llm).run(f.owner.id, 'UNRELATED RETRY TEXT', sink, { promptSeq });
    expect(select.mock.calls[0]?.[2]).toBe('Compare both designs.\nKeep the budget below 50.');
  });

  it('retains attachment references and delivers original media only after authorized recall', async () => {
    const f = await fixture();
    const promptId = randomUUID();
    const uri = 'blob://uploads/source.png';
    await f.store.append(f.owner.id, [
      {
        ...meta(),
        type: 'session/attachment',
        uri,
        workspacePath: 'uploads/source.png',
        mimeType: 'image/png',
        size: 10,
      },
      {
        eventId: promptId,
        at,
        type: 'message/user',
        surfaceOp: 'append',
        content: [
          { kind: 'text', text: 'Describe this image.' },
          { kind: 'image', uri, mimeType: 'image/png' },
        ],
      },
      {
        ...meta(),
        type: 'message/assistant',
        surfaceOp: 'append',
        phase: 'final',
        content: [{ kind: 'text', text: 'It shows a diagram.' }],
      },
      { ...meta(), type: 'turn/end', promptId, reason: 'completed' },
    ]);
    const llm = new FakeLLM(
      (request) => {
        const prior = request.messages.find((message) =>
          message.content.startsWith('Describe this image.'),
        );
        expect(prior?.content).toContain('uploads/source.png');
        expect(prior?.blocks).toBeUndefined();
        return toolCallThenFinish('image', 'recall', { eventId: promptId });
      },
      (request) => {
        expect(request.messages.find((message) => message.toolCallId === 'image')?.blocks).toEqual([
          { kind: 'image', uri, mimeType: 'image/png' },
        ]);
        return textChunks('A further explanation grounded in the retrieved original image.');
      },
    );
    expect(
      (await f.loop(llm).run(f.owner.id, 'Explain the arrows in that diagram.', sink)).reason,
    ).toBe('completed');
    llm.assertExhausted();
  });

  it('does not turn an incidental failed read into mandatory checklist repair', async () => {
    const f = await fixture();
    const llm = new FakeLLM(
      () => toolCallThenFinish('missing', 'read_file', { path: '.' }),
      () => textChunks('Which document should I inspect?'),
    );
    expect((await f.loop(llm).run(f.owner.id, 'Explain the document', sink)).reason).toBe(
      'completed',
    );
    expect(llm.requests).toHaveLength(2);
    const events = await f.store.load(f.owner.id);
    expect(events.filter((e) => e.type === 'memory/selection')).toHaveLength(1);
    expect(events.some((e) => e.type === 'task/recovery')).toBe(false);
  });

  it('repairs the actual candidate and can retire a wrong method without discarding an outcome requirement', async () => {
    const f = await fixture();
    f.sandbox.files.set('notes.txt', 'Available evidence');
    const llm = new FakeLLM(
      () =>
        toolCallThenFinish('plan', 'task', {
          operation: 'plan',
          checks: [
            {
              id: 'lookup',
              kind: 'observation',
              purpose: 'method',
              requirement: 'Unnecessary background lookup',
            },
          ],
        }),
      () => toolCallThenFinish('read', 'read_file', { path: 'notes.txt' }),
      () => textChunks('Draft that incorrectly included unrelated background.'),
      (request) => {
        expect(JSON.stringify(request.messages)).toContain(
          'Draft that incorrectly included unrelated background.',
        );
        expect(JSON.stringify(request.messages)).toContain(
          'Repair this draft against the original user request',
        );
        return toolCallThenFinish('revise', 'task', {
          operation: 'plan',
          checks: [],
          revisionReason:
            'The background lookup was my mistaken method. The user only requested an explanation of the supplied text.',
        });
      },
      () => textChunks('Explanation of the supplied text.'),
    );
    expect((await f.loop(llm).run(f.owner.id, 'Explain the supplied text.', sink)).reason).toBe(
      'completed',
    );
    const events = await f.store.load(f.owner.id);
    expect(events.filter((e) => e.type === 'response/candidate')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'task/plan')).toHaveLength(2);
    const replay = new MemorySessionStore();
    await replay.append(
      f.owner.id,
      events.map((e) => sessionEventSchema.parse(JSON.parse(JSON.stringify(e)))),
    );
    expect(
      toModelMessages(await replay.load(f.owner.id)).some((m) =>
        m.content.startsWith('[Rejected answer candidate'),
      ),
    ).toBe(false);
    expect(
      taskVerification(events, events.findLast((e) => e.type === 'message/user')!.eventId).status,
    ).toBe('verified');
  });

  it('records exact private request snapshots and denies generic blob reads', async () => {
    const f = await fixture();
    const llm = new FakeLLM(() => textChunks('Answer'));
    await f.loop(llm).run(f.owner.id, 'Question', sink);
    const context = (await f.store.load(f.owner.id)).find((e) => e.type === 'model/context');
    expect(context?.type).toBe('model/context');
    if (context?.type !== 'model/context') throw new Error('No manifest');
    const bytes = (await f.blobs.get(context.snapshotUri!))!;
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(context.digest);
    expect(JSON.parse(new TextDecoder().decode(bytes)).messages).toEqual(llm.requests[0]!.messages);
    const reader = createReadBlobTool(f.blobs);
    f.tools.register(reader);
    for (const uri of [
      context.snapshotUri!,
      context.snapshotUri!.replace('model-context', '%6dodel-context'),
    ])
      expect(
        (
          await f.tools.execute(
            { id: randomUUID(), name: 'read_blob', args: { uri } },
            { sessionId: f.owner.id, workspaceRoot: '/ws' },
          )
        ).isError,
      ).toBe(true);
  });

  it('stops before model dispatch when private context persistence fails', async () => {
    const f = await fixture();
    vi.spyOn(f.blobs, 'put').mockRejectedValue(new Error('Private storage path failed'));
    const llm = new FakeLLM();
    expect((await f.loop(llm).run(f.owner.id, 'Question', sink)).reason).toBe('error');
    expect(llm.requests).toHaveLength(0);
    expect((await f.store.load(f.owner.id)).at(-1)).toMatchObject({
      detail: 'Model input snapshot could not be persisted.',
    });
  });

  it('keeps compaction input separate from personal assistant input', async () => {
    const f = await fixture();
    const llm = new FakeLLM(
      () => toolCallThenFinish('read', 'read_file', { path: 'large.txt' }),
      (request) => {
        expect(request.system).toContain('compact conversation histories');
        expect(request.messages).toHaveLength(1);
        expect(request.messages[0]!.content).toContain('Conversation excerpt (part');
        return textChunks(
          'The source provides a long design explanation; preserve the current question.',
        );
      },
      () => textChunks('Explanation grounded in the retained source.'),
    );
    f.sandbox.files.set('large.txt', 'SOURCE BODY '.repeat(1000));
    const context = new ContextManager({
      llm,
      model: 'fake/model',
      store: f.store,
      maxTokens: 4000,
      estimate: (messages) => messages.reduce((sum, message) => sum + message.content.length, 0),
      keepTokens: 100,
      summaryWindowTokens: 20_000,
    });
    expect(await f.loop(llm, context).run(f.owner.id, 'Explain the source', sink)).toMatchObject({
      reason: 'completed',
    });
    expect(
      (await f.store.load(f.owner.id)).filter(
        (e) => e.type === 'model/context' && e.purpose === 'compaction',
      ),
    ).toHaveLength(1);
    const manifest = (await f.store.load(f.owner.id)).find(
      (event) => event.type === 'model/context' && event.purpose === 'compaction',
    );
    expect(manifest?.type === 'model/context' && manifest.selectionEventId).toBeUndefined();
    llm.assertExhausted();
  });

  it('replays a rejected candidate through a checkpoint and expands its bounded tail', async () => {
    const f = await fixture();
    const promptId = randomUUID();
    await f.store.append(f.owner.id, [
      {
        eventId: promptId,
        at,
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'Explain the source and preserve its limits.' }],
      },
      { ...meta(), type: 'turn/start', promptId, executionVersion: 2 },
      {
        ...meta(),
        type: 'response/candidate',
        promptId,
        text: 'Draft '.repeat(2500) + 'Original limitation.',
        failedConditions: ['Incorrect source selection'],
      },
      {
        ...meta(),
        type: 'task/recovery',
        promptId,
        kind: 'verification',
        advice: 'Reconsider the source against the original request.',
      },
    ]);
    await f.store.append(f.owner.id, [
      {
        ...meta(),
        type: 'compaction/summary',
        fromSeq: 2,
        toSeq: 5,
        checkpoint: true,
        memoryPromptId: promptId,
        memoryPolicyRevision: 0,
        summary: 'The draft used the wrong source; preserve the original user request.',
      },
    ]);
    const replay = new MemorySessionStore();
    await replay.append(
      f.owner.id,
      (await f.store.load(f.owner.id)).map((event) =>
        sessionEventSchema.parse(JSON.parse(JSON.stringify(event))),
      ),
    );
    const tools = new CoreToolRegistry(f.sandbox);
    tools.register(createTaskTool(replay));
    const llm = new FakeLLM(
      (request) => {
        expect(JSON.stringify(request.messages)).toContain(
          'Explain the source and preserve its limits.',
        );
        expect(JSON.stringify(request.messages)).toContain('Rejected answer candidate');
        expect(JSON.stringify(request.messages)).toContain('offset 12000');
        return toolCallThenFinish('tail', 'task', { operation: 'candidate', offset: 12000 });
      },
      (request) => {
        expect(
          request.messages.find((message) => message.toolCallId === 'tail')?.content,
        ).toContain('Original limitation.');
        return textChunks('A corrected explanation with the source limitation.');
      },
    );
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      store: replay,
      tools,
      workspaceRoot: '/ws',
      verification: true,
      personalContext: new PersonalContext(f.memory, f.index, replay),
      sessionMetas: f.metas,
    });
    expect(
      (await loop.run(f.owner.id, 'mismatched retry text', sink, { promptSeq: 2 })).reason,
    ).toBe('completed');
    llm.assertExhausted();
  });

  it('fences a cross-session recalled source excluded after delivery', async () => {
    const f = await fixture();
    const episode = {
      episodeId: randomUUID(),
      promptId: randomUUID(),
      sessionId: randomUUID(),
      fromSeq: 1,
      toSeq: 3,
      at,
      topic: 'Decision',
      request: 'Earlier decision',
      outcome: 'Use the local option.',
      excluded: false,
      policyRevision: 0,
    };
    vi.mocked(f.index.history).mockResolvedValue({ episodes: [episode], nextBefore: null });
    vi.mocked(f.index.evidence!).mockResolvedValue({ ...episode, excluded: true });
    const llm = new FakeLLM(() =>
      toolCallThenFinish('recall', 'recall', { query: 'Earlier decision' }),
    );
    expect((await f.loop(llm).run(f.owner.id, 'Recall the earlier decision.', sink)).reason).toBe(
      'error',
    );
    expect(llm.requests).toHaveLength(1);
    expect((await f.store.load(f.owner.id)).at(-1)).toMatchObject({
      detail: expect.stringContaining('Memory or recall permissions changed'),
    });
  });

  it('shrinks optional dialogue when later system augmentation needs context space', async () => {
    const f = await fixture();
    await completed(
      f.store,
      f.owner.id,
      'Explain the design',
      'Source body and its constraints. '.repeat(2000),
    );
    const llm = new FakeLLM((request) => {
      expect(request.messages.at(-1)?.content).toBe('Critique that design.');
      expect(JSON.stringify(request.messages)).toContain('excerpt truncated');
      return textChunks('A critique qualified by the delivered source excerpt.');
    });
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      store: f.store,
      tools: f.tools,
      workspaceRoot: '/ws',
      personalContext: f.context,
      sessionMetas: f.metas,
      maxContextTokens: 12_000,
      maxOutputTokens: 512,
      augmentSystem: async () => 'R'.repeat(20_000),
    });
    expect((await loop.run(f.owner.id, 'Critique that design.', sink)).reason).toBe('completed');
    const selections = (await f.store.load(f.owner.id)).filter(
      (event) => event.type === 'memory/selection',
    );
    expect(selections.length).toBeGreaterThan(1);
    expect(selections.at(-1)!.receipt.dialogue![0]!.answer.to).toBeLessThan(
      selections[0]!.receipt.dialogue![0]!.answer.to,
    );
  });

  it('keeps model outcome claims separate from checks and marks a claim stale after effects', async () => {
    const f = await fixture();
    f.tools.register(writeFileTool);
    const llm = new FakeLLM(
      () =>
        toolCallThenFinish('claim', 'task', {
          operation: 'assess',
          outcome: 'fulfilled',
          unresolved: [],
        }),
      () => toolCallThenFinish('write', 'write_file', { path: 'result.txt', content: 'changed' }),
      (request) => {
        expect(
          request.messages.find((message) =>
            message.content.startsWith('[Model-authored outcome assessment'),
          )?.content,
        ).toContain('"stale":true');
        return textChunks('The file changed; no test result has been established.');
      },
    );
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools: f.tools,
      store: f.store,
      workspaceRoot: '/ws',
    });
    await loop.run(f.owner.id, 'Update the result file.', sink);
    const completion = (await f.store.load(f.owner.id)).find(
      (event) => event.type === 'task/completion',
    );
    expect(completion).toMatchObject({ checksStatus: 'unverified' });
    expect(completion?.type === 'task/completion' && completion.outcomeId).toBeUndefined();
  });
});

describe('dependency-aware evidence', () => {
  it('round-trips the model-visible result sequence through personal context without renumbering evidence', async () => {
    const f = await intentRuntime({
      files: { 'report.txt': 'Observed result' },
      localHistory: [{ request: 'An earlier request', answer: 'An earlier final answer' }],
    });
    let selectedSeq = 0;
    const llm = new FakeLLM(
      () =>
        toolCallThenFinish('plan', 'task', {
          operation: 'plan',
          checks: [{ id: 'read', requirement: 'Read report', kind: 'observation' }],
        }),
      () => toolCallThenFinish('opaque-runtime-id', 'read_file', { path: 'report.txt' }),
      (request) => {
        const control = request.messages.find((message) =>
          message.content.startsWith('[Agent working plan and verification.'),
        );
        expect(control).toBeDefined();
        const state = taskStatusSchema.parse(
          JSON.parse(control!.content.slice(control!.content.indexOf('\n') + 1)),
        );
        selectedSeq = state.evidence.find((item) => item.callId === 'opaque-runtime-id')!.resultSeq;
        expect(
          request.messages.find((message) => message.toolCallId === 'opaque-runtime-id')?.content,
        ).toContain(`Runtime verification reference: resultSeq=${selectedSeq}`);
        return toolCallThenFinish('verify', 'task', {
          operation: 'verify',
          id: 'read',
          resultSeq: selectedSeq,
        });
      },
      () => textChunks('Report inspected.'),
    );
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools: f.tools,
      store: f.store,
      workspaceRoot: '/fixture',
      personalContext: f.personalContext,
      sessionMetas: f.metas,
      verification: true,
    });
    expect((await loop.run(f.owner.id, 'Read report.txt', sink)).reason).toBe('completed');
    const events = await f.store.load(f.owner.id);
    expect(events[selectedSeq - 1]).toMatchObject({
      type: 'tool/result',
      callId: 'opaque-runtime-id',
    });
    expect(events.findLast((event) => event.type === 'task/check')).toMatchObject({
      callId: 'opaque-runtime-id',
      resultSeq: selectedSeq,
    });
    llm.assertExhausted();
  });

  it('runs the evaluation browser fixture through real capture, artifacts, initial planning and verification', async () => {
    const f = await intentRuntime({
      files: {},
      pages: {
        'https://fixtures.invalid/options': 'A is local and measured at 80 ms; B is remote.',
      },
    });
    const llm = new FakeLLM(
      () =>
        toolCallThenFinish('source', 'browser', {
          operation: 'navigate',
          url: 'https://fixtures.invalid/options',
        }),
      (request) => {
        expect(
          request.messages.find((m) => m.role === 'tool' && m.toolCallId === 'source')?.content,
        ).toContain('browser-result-v1');
        return toolCallThenFinish('plan', 'task', {
          operation: 'plan',
          checks: [
            {
              id: 'source',
              kind: 'observation',
              dependency: 'reference',
              requirement: 'Read the source',
            },
          ],
        });
      },
      () =>
        toolCallThenFinish('verify', 'task', {
          operation: 'verify',
          id: 'source',
          callId: 'source',
        }),
      () =>
        textChunks(
          'A meets the stated local-data condition under the measured fixture conditions.',
        ),
    );
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      store: f.store,
      tools: f.tools,
      workspaceRoot: '/fixture',
      personalContext: f.personalContext,
      sessionMetas: f.metas,
      spill: { store: f.blobs },
      verification: true,
    });
    const outcome = await loop.run(
      f.owner.id,
      'Compare the options using the fixture source',
      sink,
    );
    expect(
      outcome.reason,
      JSON.stringify(
        (await f.store.load(f.owner.id)).filter((event) =>
          ['tool/result', 'turn/end'].includes(event.type),
        ),
      ),
    ).toBe('completed');
    llm.assertExhausted();
  });
  it('retains an immutable source across navigation while invalidating current browser state', async () => {
    const f = await fixture();
    await f.store.append(f.owner.id, [
      {
        ...meta(),
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'Compare source and current view' }],
      },
    ]);
    const prompt = (await f.store.load(f.owner.id)).at(-1)!;
    const checks = [
      {
        id: 'source',
        requirement: 'Read the saved source',
        kind: 'observation' as const,
        dependency: 'reference' as const,
      },
      {
        id: 'live',
        requirement: 'Inspect current browser state',
        kind: 'observation' as const,
        dependency: 'browser' as const,
      },
    ];
    await f.store.append(f.owner.id, [
      { ...meta(), type: 'task/plan', promptId: prompt.eventId, evidenceVersion: 2, checks },
    ]);
    const append = async (
      id: string,
      effect: {
        kind: 'read' | 'navigation';
        scope: 'reference' | 'browser';
        evidence?: 'observation' | 'immutable-observation';
      },
    ) =>
      f.store.append(f.owner.id, [
        { ...meta(), type: 'tool/call', name: 'browser', callId: id, args: {}, effect },
        { ...meta(), type: 'tool/result', callId: id, value: {}, isError: false },
      ]);
    await append('saved', { kind: 'read', scope: 'reference', evidence: 'immutable-observation' });
    await append('current', { kind: 'read', scope: 'browser', evidence: 'observation' });
    await append('navigate', { kind: 'navigation', scope: 'browser' });
    expect(
      taskState(await f.store.load(f.owner.id), prompt.eventId).evidence.map((e) => e.callId),
    ).toEqual(['saved']);
  });

  it('accepts earlier reads for an initial plan and preserves unchanged checks across additions', async () => {
    const f = await fixture();
    await f.store.append(f.owner.id, [
      {
        ...meta(),
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'Inspect both files' }],
      },
    ]);
    const prompt = (await f.store.load(f.owner.id)).at(-1)!;
    await f.store.append(f.owner.id, [
      { ...meta(), type: 'tool/call', name: 'read_file', callId: 'read', args: {} },
      {
        ...meta(),
        type: 'tool/result',
        callId: 'read',
        isError: false,
        value: { content: 'read before planning' },
      },
    ]);
    const execute = (args: unknown) =>
      f.tools.execute(
        { id: randomUUID(), name: 'task', args },
        { sessionId: f.owner.id, workspaceRoot: '/ws' },
      );
    const check = { id: 'first', kind: 'observation', requirement: 'Inspect first source' };
    await execute({ operation: 'plan', checks: [check] });
    expect((await execute({ operation: 'verify', id: 'first', callId: 'read' })).isError).toBe(
      false,
    );
    await execute({
      operation: 'plan',
      checks: [check, { ...check, id: 'second', requirement: 'Inspect second source' }],
    });
    expect(taskVerification(await f.store.load(f.owner.id), prompt.eventId).pending).toEqual([
      'second: Inspect second source',
    ]);
    expect(
      (
        await execute({
          operation: 'plan',
          checks: [],
          revisionReason: 'Skip the user requirements',
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await execute({
          operation: 'plan',
          intent: {
            outcome: 'Different task',
            sourceEventIds: [randomUUID()],
            deliverables: [],
            constraints: [],
          },
          checks: [check],
          revisionReason: 'Wrong source',
        })
      ).isError,
    ).toBe(true);
  });

  it('treats undeclared custom tools conservatively even if the model calls them a read', () => {
    const tools = new CoreToolRegistry(new FakeSandbox());
    tools.register({
      name: 'custom',
      description: 'Custom tool',
      parameters: z.object({}),
      execute: async () => ({ isError: false, value: {} }),
    });
    expect(tools.effectOf({ id: 'x', name: 'custom', args: { effect: 'read' } })).toEqual({
      kind: 'unknown',
      scope: 'unknown',
    });
  });
});
