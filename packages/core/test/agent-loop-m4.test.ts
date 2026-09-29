import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContentBlock, EventSink, LoopEvent, SessionEvent } from '@trinity-harness/contracts';

import {
  ContextManager,
  CoreAgentLoop,
  CoreToolRegistry,
  LocalBlobStore,
  MemorySessionStore,
  createReadBlobTool,
  readFileTool,
  toModelMessages,
} from '../src/index.js';
import { FakeLLM, textChunks, toolCallThenFinish } from '../src/testing/fake-llm.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';

class CollectingSink implements EventSink {
  readonly events: LoopEvent[] = [];
  emit(event: LoopEvent): void {
    this.events.push(event);
  }
}

const eventTypes = (events: SessionEvent[]) => events.map((e) => e.type);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'trinity-m4-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('CoreAgentLoop M4: compaction between steps', () => {
  it('compacts over-budget HISTORY mid-turn; the current exchange is kept', async () => {
    const store = new MemorySessionStore();
    const sandbox = new FakeSandbox();
    sandbox.files.set('a.txt', 'x'.repeat(300));
    const registry = new CoreToolRegistry(sandbox);
    registry.register(readFileTool);

    // Prior-turn history: two old exchanges. The new turn's tool output tips
    // the context over budget ⇒ compaction fires BETWEEN steps (design.md §6.1).
    const seed = (t: string) => ({
      type: 'message/user' as const,
      eventId: crypto.randomUUID(),
      at: new Date().toISOString(),
      surfaceOp: 'append' as const,
      content: [{ kind: 'text' as const, text: t }],
    });
    const seedA = (t: string) => ({ ...seed(t), type: 'message/assistant' as const });
    await store.append('s1', [
      seed('o'.repeat(200)),
      seedA('p'.repeat(200)),
      seed('q'.repeat(200)),
      seedA('r'.repeat(200)),
    ]);

    // Script order = LLM call order: (1) turn-start compaction summarizer,
    // (2) step-1 model request ⇒ tool call, (3) step-2 model request ⇒ text.
    const llm = new FakeLLM(
      () => textChunks('SUMMARY'),
      () => toolCallThenFinish('c1', 'read_file', { path: 'a.txt' }),
      () => textChunks('final answer'),
    );
    const context = new ContextManager({
      llm,
      model: 'fake/model',
      store,
      // 400: turn-start compaction fires once; the post-wave recheck stays
      // under budget (current exchange ~310 tokens is retained by design).
      maxTokens: 400,
      keepTokens: 80,
      estimate: (messages) => messages.reduce((n, m) => n + m.content.length, 0),
    });
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools: registry,
      store,
      workspaceRoot: '/ws',
      context,
    });

    const outcome = await loop.run('s1', 'start', new CollectingSink());
    expect(outcome.reason).toBe('completed');

    const log = await store.load('s1');
    expect(log.some((e) => e.type === 'compaction/summary')).toBe(true);

    // The final model request dropped the old history (in-place summary) but
    // keeps the current turn's user message and tool output.
    const lastRequest = llm.requests.at(-1)!;
    const lastText = JSON.stringify(lastRequest.messages);
    expect(lastText).not.toContain('o'.repeat(100));
    expect(lastText).not.toContain('q'.repeat(100));
    expect(lastText).toContain('SUMMARY');
    expect(lastText).toContain('x'.repeat(100)); // current exchange retained
  });

  it('emits context/compacted on the sink when a compaction lands', async () => {
    const store = new MemorySessionStore();
    const registry = new CoreToolRegistry(new FakeSandbox());
    await store.append('s1', [
      {
        type: 'message/user',
        eventId: crypto.randomUUID(),
        at: new Date().toISOString(),
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'old '.padEnd(400, 'o') }],
      },
      {
        type: 'message/assistant',
        eventId: crypto.randomUUID(),
        at: new Date().toISOString(),
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'old-a'.padEnd(400, 'a') }],
      },
    ]);
    const llm = new FakeLLM(
      () => textChunks('SUMMARY'),
      () => textChunks('done'),
    );
    const context = new ContextManager({
      llm,
      model: 'fake/model',
      store,
      maxTokens: 100,
      keepTokens: 40,
      estimate: (messages) => messages.reduce((n, m) => n + m.content.length, 0),
    });
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools: registry,
      store,
      workspaceRoot: '/ws',
      context,
    });
    const sink = new CollectingSink();
    await loop.run('s1', 'new prompt', sink);
    expect(sink.events.some((e) => e.type === 'context/compacted')).toBe(true);
  });
});

describe('CoreAgentLoop M4: tool-result spill', () => {
  it('stores oversized results in the BlobStore and logs a reference', async () => {
    const store = new MemorySessionStore();
    const sandbox = new FakeSandbox();
    sandbox.files.set('big.txt', 'y'.repeat(10_000));
    const blobStore = new LocalBlobStore(path.join(dir, 'blobs'));
    const registry = new CoreToolRegistry(sandbox);
    registry.register(readFileTool);
    registry.register(createReadBlobTool(blobStore));

    const llm = new FakeLLM(
      () => toolCallThenFinish('c1', 'read_file', { path: 'big.txt' }),
      () => textChunks('ok'),
    );
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools: registry,
      store,
      workspaceRoot: '/ws',
      spill: { store: blobStore, thresholdBytes: 1_000 },
      resolveBlob: async (uri) => {
        const bytes = await blobStore.get(uri);
        if (bytes === null) throw new Error(`blob not found: ${uri}`);
        return bytes;
      },
    });
    await loop.run('s1', 'read the file', new CollectingSink());

    const result = (await store.load('s1')).find((e) => e.type === 'tool/result') as Extract<
      SessionEvent,
      { type: 'tool/result' }
    >;
    const value = result.value as { spilled: string; bytes: number; preview: string };
    expect(value.spilled).toMatch(/^blob:\/\/spill\/s1\/c1\.json$/);
    expect(value.bytes).toBeGreaterThan(1_000);
    // Full content never hits the append-only log (docs/design.md §7).
    expect(JSON.stringify(result)).not.toContain('y'.repeat(500));

    // The model-visible fold shows the reference, and read_blob retrieves it.
    const fold = JSON.stringify(toModelMessages(await store.load('s1')));
    expect(fold).toContain('spill/s1/c1.json');
    const fetched = await blobStore.get(value.spilled);
    expect(fetched).not.toBeNull();
    expect(Buffer.from(fetched!).toString('utf8')).toContain('y'.repeat(500));
  });

  it('small results pass through unspilled', async () => {
    const store = new MemorySessionStore();
    const sandbox = new FakeSandbox();
    sandbox.files.set('small.txt', 'tiny');
    const blobStore = new LocalBlobStore(path.join(dir, 'blobs'));
    const registry = new CoreToolRegistry(sandbox);
    registry.register(readFileTool);
    const llm = new FakeLLM(
      () => toolCallThenFinish('c1', 'read_file', { path: 'small.txt' }),
      () => textChunks('ok'),
    );
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools: registry,
      store,
      workspaceRoot: '/ws',
      spill: { store: blobStore, thresholdBytes: 1_000 },
    });
    await loop.run('s1', 'read', new CollectingSink());
    const result = (await store.load('s1')).find((e) => e.type === 'tool/result') as Extract<
      SessionEvent,
      { type: 'tool/result' }
    >;
    expect(result.value).toMatchObject({ content: 'tiny' });
  });
});

describe('CoreAgentLoop M4: multimodal prompts', () => {
  it('commits content blocks and feeds them to the gateway', async () => {
    const store = new MemorySessionStore();
    const registry = new CoreToolRegistry(new FakeSandbox());
    const llm = new FakeLLM(() => textChunks('nice picture'));
    const blocks: ContentBlock[] = [
      { kind: 'text', text: 'what is this?' },
      { kind: 'image', uri: 'blob://abc', mimeType: 'image/png' },
    ];
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools: registry,
      store,
      workspaceRoot: '/ws',
    });
    await loop.run('s1', 'what is this?', new CollectingSink(), { content: blocks });

    const userEvent = (await store.load('s1')).find((e) => e.type === 'message/user') as Extract<
      SessionEvent,
      { type: 'message/user' }
    >;
    expect(userEvent.content).toEqual(blocks);

    const [request] = llm.requests;
    expect(request!.messages[0]!.blocks).toEqual([
      { kind: 'image', uri: 'blob://abc', mimeType: 'image/png' },
    ]);
    expect(request!.messages[0]!.content).toBe('what is this?');
    expect(eventTypes(await store.load('s1'))).toEqual([
      'message/user',
      'message/assistant',
      'turn/end',
    ]);
  });

  it('falls back to plain text when no content blocks are given', async () => {
    const store = new MemorySessionStore();
    const registry = new CoreToolRegistry(new FakeSandbox());
    const llm = new FakeLLM(() => textChunks('hello'));
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools: registry,
      store,
      workspaceRoot: '/ws',
    });
    await loop.run('s1', 'plain', new CollectingSink());
    const userEvent = (await store.load('s1')).find((e) => e.type === 'message/user') as Extract<
      SessionEvent,
      { type: 'message/user' }
    >;
    expect(userEvent.content).toEqual([{ kind: 'text', text: 'plain' }]);
  });
});

describe('CoreAgentLoop M4: system augmentation', () => {
  it('appends the augmenter output to the system prompt each step', async () => {
    const store = new MemorySessionStore();
    const registry = new CoreToolRegistry(new FakeSandbox());
    const llm = new FakeLLM(() => textChunks('ok'));
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      systemPrompt: 'base',
      tools: registry,
      store,
      workspaceRoot: '/ws',
      augmentSystem: async (sessionId) =>
        sessionId === 's1' ? '[language-server diagnostics]\n- [error] a.py:1 bad' : undefined,
    });
    await loop.run('s1', 'hi', new CollectingSink());
    const [request] = llm.requests;
    expect(request!.system).toBe('base\n\n[language-server diagnostics]\n- [error] a.py:1 bad');
  });
});
