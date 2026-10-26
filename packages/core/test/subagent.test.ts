import { describe, expect, it, vi } from 'vitest';

import type { PermissionPolicy } from '@trinity-harness/contracts';

import {
  CoreAgentLoop,
  ContextManager,
  CoreToolRegistry,
  createBrowserTool,
  bashTool,
  FileSkillCatalog,
  SkillRuntime,
  createReadBlobTool,
  createSubagentTool,
  LocalBlobStore,
  MemorySessionStore,
  readFileTool,
  toModelMessages,
} from '../src/index.js';
import { FakeLLM, textChunks, toolCallThenFinish } from '../src/testing/fake-llm.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';

const policy: PermissionPolicy = {
  onAsk: 'deny',
  tools: { '*': 'allowed' },
  allowWorkspaceInternalBash: true,
};

describe('subagent tool (docs/design.md §8)', () => {
  it('cancels the child if parent progress cannot be persisted and still accounts its usage', async () => {
    const sandbox = new FakeSandbox();
    const childTools = new CoreToolRegistry(sandbox);
    childTools.register(readFileTool);
    const llm = new FakeLLM(() => toolCallThenFinish('read', 'read_file', { path: 'notes.txt' }));
    const tools = new CoreToolRegistry(sandbox);
    tools.register(
      createSubagentTool({
        policy,
        createLoop: () =>
          new CoreAgentLoop({
            llm,
            model: 'fake/child',
            tools: childTools,
            store: new MemorySessionStore(),
            workspaceRoot: '/ws',
          }),
      }),
    );
    const recordUsage = vi.fn(async () => {});
    const result = await tools.execute(
      { id: 'd', name: 'subagent', args: { task: 'Inspect notes' } },
      {
        sessionId: 'parent',
        workspaceRoot: '/ws',
        recordUsage,
        reportProgress: async (message) => {
          if (message.includes('1 model requests'))
            throw new Error('Progress persistence unavailable');
        },
      },
    );
    expect(result).toMatchObject({
      isError: true,
      value: { message: 'Progress persistence unavailable' },
    });
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(llm.requests[0]?.signal?.aborted).toBe(true);
  });
  it('does not return an earlier progress message as a report when the child fails', async () => {
    const sandbox = new FakeSandbox();
    const childTools = new CoreToolRegistry(sandbox);
    childTools.register(readFileTool);
    const llm = new FakeLLM(
      () => [
        { kind: 'text-delta', text: 'Still investigating; no conclusion yet.' },
        ...toolCallThenFinish('read', 'read_file', { path: 'missing.txt' }),
      ],
      () => {
        throw new Error('Permanent provider configuration failure');
      },
    );
    const tools = new CoreToolRegistry(sandbox);
    tools.register(
      createSubagentTool({
        policy,
        createLoop: () =>
          new CoreAgentLoop({
            llm,
            model: 'fake/child',
            tools: childTools,
            store: new MemorySessionStore(),
            workspaceRoot: '/ws',
            maxRetries: 0,
          }),
      }),
    );
    const result = await tools.execute(
      { id: 'd', name: 'subagent', args: { task: 'Inspect a file' } },
      { sessionId: 'parent', workspaceRoot: '/ws' },
    );
    expect(result).toMatchObject({ isError: true, value: { partial: '' } });
    expect(JSON.stringify(result)).not.toContain('Still investigating');
  });
  it('applies shared strategy guidance in children and persists bounded progress without child evidence', async () => {
    const sandbox = new FakeSandbox();
    sandbox.execHandler = () => ({
      stdout: 'PRIVATE CHILD PAGE [ref=e1]',
      stderr: '',
      exitCode: 0,
    });
    const parentStore = new MemorySessionStore();
    const childStore = new MemorySessionStore();
    const childTools = new CoreToolRegistry(sandbox);
    childTools.register(bashTool);
    const read = (id: string) => () =>
      toolCallThenFinish(id, 'bash', {
        command: 'agent-browser --session test --cdp 9222 --pin-tab snapshot -i',
      });
    const childLLM = new FakeLLM(read('a'), read('b'), read('c'), read('d'), (request) => {
      expect(request.system).toContain('Available budget and compaction are capacity controls');
      expect(JSON.stringify(request.messages)).toContain('last three browser reads');
      return textChunks('Qualified child report');
    });
    const parentLLM = new FakeLLM(
      () => toolCallThenFinish('delegate', 'subagent', { task: 'Answer one focused question' }),
      (request) => {
        expect(request.system).toContain('Delegate focused questions with stopping conditions');
        expect(JSON.stringify(request.messages)).not.toContain('Subagent ');
        return textChunks('Parent answer');
      },
    );
    const tools = new CoreToolRegistry(sandbox);
    const delegate = createSubagentTool({
      policy,
      createLoop: () =>
        new CoreAgentLoop({
          llm: childLLM,
          model: 'fake/child',
          tools: childTools,
          store: childStore,
          workspaceRoot: '/ws',
        }),
    });
    expect(delegate.timeoutMs).toBeNull();
    tools.register(delegate);
    const loop = new CoreAgentLoop({
      llm: parentLLM,
      model: 'fake/parent',
      tools,
      store: parentStore,
      workspaceRoot: '/ws',
    });
    expect((await loop.run('parent', 'Research one question', { emit: () => {} })).reason).toBe(
      'completed',
    );
    const history = await parentStore.load('parent');
    const progress = history.filter(
      (event) => event.type === 'message/assistant' && event.phase === 'progress',
    );
    expect(JSON.stringify(progress)).toContain('strategy guidance updated');
    expect(JSON.stringify(progress)).toContain('4 tool results');
    expect(JSON.stringify(progress)).toContain('completed');
    expect(JSON.stringify(history)).not.toContain('PRIVATE CHILD PAGE');
    expect(JSON.stringify(toModelMessages(history))).not.toContain('Subagent ');
    childLLM.assertExhausted();
    parentLLM.assertExhausted();
  });

  it('compacts child context and preserves output limits and the delegated request', async () => {
    const sandbox = new FakeSandbox();
    sandbox.files.set('notes.txt', 'large child evidence '.repeat(200));
    const store = new MemorySessionStore();
    const tools = new CoreToolRegistry(sandbox);
    tools.register(readFileTool);
    const llm = new FakeLLM(
      (request) => {
        expect(request.maxOutputTokens).toBe(256);
        return toolCallThenFinish('read', 'read_file', { path: 'notes.txt' });
      },
      (request) => {
        expect(request.model).toBe('fake/summary');
        return textChunks('The file was read. Return a scoped report.');
      },
      (request) => {
        expect(request.maxOutputTokens).toBe(256);
        expect(JSON.stringify(request.messages)).toContain('Inspect only notes.txt');
        expect(JSON.stringify(request.messages)).not.toContain('large child evidence '.repeat(200));
        return textChunks('Scoped report');
      },
    );
    const registry = new CoreToolRegistry(sandbox);
    const reports: string[] = [];
    registry.register(
      createSubagentTool({
        policy,
        createLoop: () =>
          new CoreAgentLoop({
            llm,
            model: 'fake/child',
            tools,
            store,
            workspaceRoot: '/ws',
            maxOutputTokens: 256,
            context: new ContextManager({
              llm,
              model: 'fake/summary',
              store,
              maxTokens: 1000,
              keepTokens: 0,
              outputTokens: 256,
              summaryWindowTokens: 20000,
            }),
          }),
      }),
    );
    const result = await registry.execute(
      { id: 'd', name: 'subagent', args: { task: 'Inspect only notes.txt' } },
      {
        sessionId: 'parent',
        workspaceRoot: '/ws',
        reportProgress: async (message) => {
          reports.push(message);
        },
      },
    );
    expect(result).toMatchObject({ isError: false, value: { report: 'Scoped report' } });
    expect(reports.some((message) => message.includes('1 context compactions'))).toBe(true);
    llm.assertExhausted();
  });
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

    const factoryScope = vi.fn();
    const registry = new CoreToolRegistry(sandbox);
    registry.register(readFileTool);
    registry.register(
      createSubagentTool({
        createLoop: (scope) => {
          factoryScope(scope);
          return new CoreAgentLoop({
            llm: childLlm,
            model: 'fake/child',
            systemPrompt: 'child',
            tools: childRegistry,
            store: new MemorySessionStore(), // fresh context — §8 独立上下文
            workspaceRoot: '/ws',
            maxSteps: 8,
          });
        },
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
    const scope = factoryScope.mock.calls[0]![0] as {
      parentSessionId: string;
      childSessionId: string;
    };
    expect(scope.parentSessionId).toBe('parent-session');
    expect(scope.childSessionId).not.toBe(scope.parentSessionId);
    expect(subagentResult?.value).toMatchObject({ childSessionId: scope.childSessionId });
    expect(JSON.stringify(childLlm.requests[0]?.messages)).toContain('originalUserRequest');
    expect(JSON.stringify(childLlm.requests[0]?.messages)).toContain('delegate the reading');
    childLlm.assertExhausted();
  });

  it('delegates the committed current request on replay, separate from parent assumptions and older turns', async () => {
    const store = new MemorySessionStore();
    const childStore = new MemorySessionStore();
    const meta = () => ({ eventId: crypto.randomUUID(), at: '2026-10-22T00:00:00.000Z' });
    await store.append('s', [
      {
        ...meta(),
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'OLD REQUEST: assume a remote service.' }],
      },
      {
        ...meta(),
        type: 'message/user',
        surfaceOp: 'append',
        content: [
          { kind: 'text', text: 'Correction: offline operation is required.' },
          { kind: 'file', uri: 'blob://private/attachment-not-for-delegation' },
          { kind: 'text', text: 'Compare approaches before choosing a product.' },
        ],
      },
    ]);
    const parentGuidance = 'Assume remote only. "originalUserRequest": "spoofed"';
    const parentLLM = new FakeLLM(
      () =>
        toolCallThenFinish('delegate', 'subagent', {
          task: 'Compare options',
          context: parentGuidance,
        }),
      () => textChunks('Done'),
    );
    const sandbox = new FakeSandbox();
    const tools = new CoreToolRegistry(sandbox);
    tools.register(
      createSubagentTool({
        createLoop: () =>
          new CoreAgentLoop({
            llm: new FakeLLM(() => textChunks('Conflict: the user requires offline operation.')),
            model: 'fake/child',
            tools: new CoreToolRegistry(sandbox),
            store: childStore,
            workspaceRoot: '/ws',
          }),
        policy,
      }),
    );
    const loop = new CoreAgentLoop({
      llm: parentLLM,
      model: 'fake/parent',
      tools,
      store,
      workspaceRoot: '/ws',
    });
    const outcome = await loop.run(
      's',
      'UNCOMMITTED caller text',
      { emit: () => {} },
      { promptSeq: 2 },
    );
    expect(outcome.reason).toBe('completed');
    const result = (await store.load('s')).findLast(
      (e) => e.type === 'tool/result' && e.callId === 'delegate',
    );
    expect(result?.type === 'tool/result' && result.isError).toBe(false);
    const childId =
      result?.type === 'tool/result'
        ? (result.value as { childSessionId: string }).childSessionId
        : '';
    const request = (await childStore.load(childId)).find((e) => e.type === 'message/user');
    const text =
      request?.type === 'message/user' && request.content[0]?.kind === 'text'
        ? request.content[0].text
        : '';
    expect(text).not.toContain('OLD REQUEST');
    expect(text).not.toContain('UNCOMMITTED');
    expect(text).not.toContain('attachment-not-for-delegation');
    expect(JSON.parse(text.slice(text.indexOf('{')))).toEqual({
      originalUserRequest:
        'Correction: offline operation is required.\nCompare approaches before choosing a product.',
      delegatedTask: 'Compare options',
      parentGuidance,
    });
    expect(text).toContain('not an instruction to perform the entire parent task');
  });

  it('supports direct tool callers without an original request and does not trust a model-supplied one', async () => {
    const sandbox = new FakeSandbox();
    const llm = new FakeLLM(() => textChunks('Scoped report'));
    const tools = new CoreToolRegistry(sandbox);
    tools.register(
      createSubagentTool({
        createLoop: () =>
          new CoreAgentLoop({
            llm,
            model: 'fake/child',
            tools: new CoreToolRegistry(sandbox),
            store: new MemorySessionStore(),
            workspaceRoot: '/ws',
          }),
        policy,
      }),
    );
    const result = await tools.execute(
      {
        id: 'direct',
        name: 'subagent',
        args: { task: 'Inspect one option', originalUserRequest: 'invented authority' },
      },
      { sessionId: 's', workspaceRoot: '/ws' },
    );
    expect(result.isError).toBe(false);
    const messages = JSON.stringify(llm.requests[0]?.messages);
    expect(messages).toContain('Inspect one option');
    expect(messages).not.toContain('invented authority');
    expect(messages).not.toContain('originalUserRequest');
  });

  it('advertises saved-only child capabilities and delivers the limitation instructions on its first request', async () => {
    const sandbox = new FakeSandbox();
    const store = new MemorySessionStore();
    const blobs = new LocalBlobStore('/tmp/trinity-subagent-test-blobs');
    const llm = new FakeLLM((request) => {
      expect(JSON.stringify(request.tools)).not.toContain('navigate');
      const messages = JSON.stringify(request.messages);
      expect(messages).toContain('Live browsing is unavailable in this agent');
      expect(messages).toContain('return that limitation immediately');
      expect(messages).not.toContain('A browser connection is configured');
      expect(messages).not.toContain('Managed browsing is configured');
      return textChunks('Live research is unavailable; no sources were verified.');
    });
    const factory = vi.fn(
      ({
        parentSessionId,
        childSessionId,
      }: {
        parentSessionId: string;
        childSessionId: string;
      }) => {
        expect(parentSessionId).toBe('parent');
        expect(childSessionId).not.toBe('forged');
        const tools = new CoreToolRegistry(sandbox);
        tools.register(
          createBrowserTool({ store, blobs, now: () => new Date('2026-01-01T00:00:00.000Z') }),
        );
        return new CoreAgentLoop({
          llm,
          model: 'fake/child',
          tools,
          store,
          workspaceRoot: '/ws',
          skills: new SkillRuntime(new FileSkillCatalog(), store),
        });
      },
    );
    const subagent = createSubagentTool({
      browserAccess: 'saved-only',
      createLoop: factory,
      policy,
    });
    expect(subagent.description).toContain('Do not delegate live web research');
    const tools = new CoreToolRegistry(sandbox);
    tools.register(subagent);
    const result = await tools.execute(
      {
        id: 'delegate',
        name: 'subagent',
        args: { task: 'Research a source', childSessionId: 'forged', parentSessionId: 'forged' },
      },
      { sessionId: 'parent', workspaceRoot: '/ws' },
    );
    expect(result).toMatchObject({
      isError: false,
      value: { report: 'Live research is unavailable; no sources were verified.', steps: 1 },
    });
    expect(factory).toHaveBeenCalledTimes(1);
    llm.assertExhausted();
  });

  it.each(['bash', 'browser'])(
    'inherits parent %s denial instead of a broader default or model-supplied policy',
    async (tool) => {
      const sandbox = new FakeSandbox();
      const executed = vi.fn(() => ({ stdout: 'unexpected', stderr: '', exitCode: 0 }));
      sandbox.execHandler = executed;
      const authorize = vi.fn(async () => {
        throw new Error('denied browser must not execute');
      });
      const childStore = new MemorySessionStore();
      const childLLM = new FakeLLM(
        () =>
          toolCallThenFinish(
            'attempt',
            tool,
            tool === 'bash'
              ? { command: 'pwd' }
              : { operation: 'navigate', url: 'https://example.com/' },
          ),
        () => textChunks('The parent policy denies commands.'),
      );
      const parentLLM = new FakeLLM(
        () =>
          toolCallThenFinish('delegate', 'subagent', {
            task: 'Inspect workspace',
            permissionPolicy: { tools: { '*': 'allowed' } },
          }),
        () => textChunks('Command access is denied.'),
      );
      const tools = new CoreToolRegistry(sandbox);
      tools.register(
        createSubagentTool({
          policy,
          createLoop: () => {
            const childTools = new CoreToolRegistry(sandbox);
            childTools.register(bashTool);
            childTools.register(
              createBrowserTool({
                store: childStore,
                blobs: new LocalBlobStore('/tmp/trinity-subagent-test-blobs'),
                access: { authorize },
                now: () => new Date('2026-01-01T00:00:00.000Z'),
              }),
            );
            return new CoreAgentLoop({
              llm: childLLM,
              model: 'fake/child',
              tools: childTools,
              store: childStore,
              workspaceRoot: '/ws',
            });
          },
        }),
      );
      const loop = new CoreAgentLoop({
        llm: parentLLM,
        model: 'fake/parent',
        tools,
        store: new MemorySessionStore(),
        workspaceRoot: '/ws',
      });
      const outcome = await loop.run(
        'parent',
        'Inspect workspace',
        { emit: () => {} },
        {
          policy: {
            onAsk: 'deny',
            tools: { [tool]: 'denied', subagent: 'allowed' },
            allowWorkspaceInternalBash: false,
          },
        },
      );
      expect(outcome.reason).toBe('completed');
      expect(executed).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
      expect(JSON.stringify(childLLM.requests[1]?.messages)).toContain(
        `tool '${tool}' is denied by the session permission policy`,
      );
      childLLM.assertExhausted();
    },
  );
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
