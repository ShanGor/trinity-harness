import { describe, expect, it } from 'vitest';

import type { PermissionPolicy } from '@trinity-harness/contracts';

import {
  CoreAgentLoop,
  CoreToolRegistry,
  createReadBlobTool,
  createSubagentTool,
  LocalBlobStore,
  MemorySessionStore,
  readFileTool,
} from '../src/index.js';
import { FakeLLM, textChunks, toolCallThenFinish } from '../src/testing/fake-llm.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';

const policy: PermissionPolicy = {
  onAsk: 'deny',
  tools: { '*': 'allowed' },
  allowWorkspaceInternalBash: true,
};

describe('subagent tool (docs/design.md §8)', () => {
  it('runs a child loop with a fresh context and returns its final report', async () => {
    const sandbox = new FakeSandbox();
    sandbox.files.set('notes.txt', 'RAW FILE CONTENT that must not leak');
    const parentStore = new MemorySessionStore();
    const blobStore = new LocalBlobStore('/tmp/trinity-subagent-test-blobs');

    const parentLlm = new FakeLLM(
      () => [
        toolCallThenFinish('sub-1', 'subagent', { task: 'read notes.txt and report' })[0]!,
        { kind: 'finish', reason: 'stop' },
      ],
      () => textChunks('parent acknowledges the report'),
    );
    const childLlm = new FakeLLM(
      () => toolCallThenFinish('c1', 'read_file', { path: 'notes.txt' }),
      () => textChunks('REPORT: done'),
    );

    const childRegistry = new CoreToolRegistry(sandbox);
    childRegistry.register(readFileTool);
    childRegistry.register(createReadBlobTool(blobStore));

    const registry = new CoreToolRegistry(sandbox);
    registry.register(readFileTool);
    registry.register(
      createSubagentTool({
        createLoop: () =>
          new CoreAgentLoop({
            llm: childLlm,
            model: 'fake/child',
            systemPrompt: 'child',
            tools: childRegistry,
            store: new MemorySessionStore(), // fresh context — §8 独立上下文
            workspaceRoot: '/ws',
            maxSteps: 8,
          }),
        policy,
      }),
    );

    const loop = new CoreAgentLoop({
      llm: parentLlm,
      model: 'fake/parent',
      tools: registry,
      store: parentStore,
      workspaceRoot: '/ws',
    });

    const outcome = await loop.run('parent-session', 'delegate the reading', {
      emit: () => {},
    });
    expect(outcome.reason).toBe('completed');

    // The child's intermediate context never leaked into the parent's log —
    // no child tool events, no raw file content — while the final report IS
    // reclaimed by design (§8 结果回收).
    const parentLog = await parentStore.load('parent-session');
    const parentText = JSON.stringify(parentLog);
    expect(parentText).not.toContain('RAW FILE CONTENT');
    expect(parentText).toContain('REPORT: done');

    // …the tool result carries the report back to the parent model.
    const subagentResult = parentLog.find(
      (e) => e.type === 'tool/result' && e.callId === 'sub-1',
    ) as { value: { report: string; steps: number } } | undefined;
    expect(subagentResult?.value.report).toBe('REPORT: done');
    expect(subagentResult?.value.steps).toBe(2);
    childLlm.assertExhausted();
  });

  it('reports failure when the child does not complete', async () => {
    const sandbox = new FakeSandbox();
    const parentLlm = new FakeLLM(
      () => [
        toolCallThenFinish('sub-1', 'subagent', { task: 'explore' })[0]!,
        { kind: 'finish', reason: 'stop' },
      ],
      () => textChunks('parent wraps up'),
    );
    const childLlm = new FakeLLM(() => [
      toolCallThenFinish('c1', 'read_file', { path: 'missing.txt' })[0]!,
      toolCallThenFinish('c2', 'read_file', { path: 'also-missing.txt' })[0]!,
      toolCallThenFinish('c3', 'read_file', { path: 'nope.txt' })[0]!,
      { kind: 'finish', reason: 'stop' },
    ]);
    const registry = new CoreToolRegistry(sandbox);
    registry.register(
      createSubagentTool({
        createLoop: () =>
          new CoreAgentLoop({
            llm: childLlm,
            model: 'fake/child',
            tools: (() => {
              const r = new CoreToolRegistry(sandbox);
              r.register(readFileTool);
              return r;
            })(),
            store: new MemorySessionStore(),
            workspaceRoot: '/ws',
            maxSteps: 3, // child hits the step cap
          }),
        policy,
      }),
    );
    const loop = new CoreAgentLoop({
      llm: parentLlm,
      model: 'fake/parent',
      tools: registry,
      store: new MemorySessionStore(),
      workspaceRoot: '/ws',
    });
    const outcome = await loop.run('s1', 'go', { emit: () => {} });
    expect(outcome.reason).toBe('completed');
    childLlm.assertExhausted();
  });
});
