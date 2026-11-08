import { describe, expect, it } from 'vitest';
import { parsePermissionPolicy } from '@trinity-harness/contracts';
import type { ApprovalRequest, ToolAssessment, ToolContextInput } from '@trinity-harness/contracts';
import { z } from 'zod';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  PolicyToolRegistry,
  bashTool,
  writeFileTool,
  editFileTool,
  createReadBlobTool,
} from '../src/index.js';
import { FakeLLM, FakeSandbox, textChunks, toolCallThenFinish } from '../src/testing/index.js';

const ctx: ToolContextInput = {
  sessionId: 's',
  workspaceRoot: '/ws',
  permissionPolicy: parsePermissionPolicy('workspace-write'),
};

describe('effect preflight', () => {
  it('protects existing content but permits new files and explicitly requested named edits', async () => {
    const sandbox = new FakeSandbox();
    sandbox.files.set('report.txt', 'old content');
    const core = new CoreToolRegistry(sandbox);
    core.register(writeFileTool);
    core.register(editFileTool);
    const registry = new PolicyToolRegistry(core, ctx.permissionPolicy);
    const call = {
      id: 'w',
      name: 'write_file',
      args: { path: 'report.txt', content: 'replacement' },
    };
    expect(await registry.assess(call, ctx)).toMatchObject({
      decision: 'ask',
      summary: expect.stringContaining('report.txt'),
    });
    expect((await registry.execute(call, ctx)).isError).toBe(true);
    expect(sandbox.files.get('report.txt')).toBe('old content');
    expect(
      (await registry.assess(call, { ...ctx, userRequest: 'Update report.txt with the findings' }))
        .decision,
    ).toBe('allowed');
    expect(
      (await registry.assess(call, { ...ctx, userRequest: 'Do not update report.txt' })).decision,
    ).toBe('ask');
    expect(
      (await registry.assess({ ...call, args: { path: 'new.txt', content: 'new' } }, ctx)).decision,
    ).toBe('allowed');
    expect(
      (
        await registry.assess(
          {
            id: 'e',
            name: 'edit_file',
            args: { path: 'report.txt', old_text: 'old', new_text: 'new' },
          },
          ctx,
        )
      ).decision,
    ).toBe('ask');
  });

  it('fails closed on preflight failure and cannot override explicit denial', async () => {
    const core = new CoreToolRegistry(new FakeSandbox());
    let executions = 0;
    core.register({
      name: 'test',
      description: 'test',
      parameters: z.object({}),
      assess: async (): Promise<ToolAssessment> => {
        throw new Error('private details');
      },
      execute: async () => {
        executions++;
        return { isError: false, value: 'ok' };
      },
    });
    const registry = new PolicyToolRegistry(core, {
      ...ctx.permissionPolicy!,
      tools: { test: 'denied' },
    });
    expect((await registry.assess({ id: 't', name: 'test', args: {} }, ctx)).decision).toBe(
      'unavailable',
    );
    expect((await core.assess({ id: 't', name: 'test', args: {} }, ctx)).summary).not.toContain(
      'private details',
    );
    expect(executions).toBe(0);
  });

  it('runs book range reads, search and literal workspace reads with zero approvals or plans', async () => {
    const store = new MemorySessionStore();
    const sandbox = new FakeSandbox();
    sandbox.execHandler = () => ({ stdout: 'chapter text', stderr: '', exitCode: 0 });
    const core = new CoreToolRegistry(sandbox);
    const data = new TextEncoder().encode('前言📖\nChapter 1: insight\nChapter 2: more insights');
    core.register(
      createReadBlobTool({
        get: async () => data,
        getMeta: async () => null,
        put: async () => {
          throw new Error('unused');
        },
        delete: async () => {},
      }),
    );
    core.register(bashTool);
    const requests: ApprovalRequest[] = [];
    const loop = new CoreAgentLoop({
      store,
      tools: core,
      model: 'fake',
      workspaceRoot: '/ws',
      llm: new FakeLLM(
        () => toolCallThenFinish('read', 'read_blob', { uri: 'blob://book', maxBytes: 7 }),
        () =>
          toolCallThenFinish('continue', 'read_blob', {
            uri: 'blob://book',
            offset: 2,
            maxBytes: 80,
          }),
        () => toolCallThenFinish('search', 'read_blob', { uri: 'blob://book', query: 'insight' }),
        () => toolCallThenFinish('shell', 'bash', { command: "sed -n '1,20p' uploads/book.txt" }),
        () => textChunks('Book insights.'),
      ),
      approvals: {
        request: async (request) => {
          requests.push(request);
          return { approvalId: request.approvalId, outcome: 'allowed', decidedBy: 'owner' };
        },
      },
    });
    await loop.run(
      's',
      'Find insights in the supplied book',
      { emit: () => {} },
      { policy: ctx.permissionPolicy },
    );
    const events = await store.load('s');
    expect(requests).toHaveLength(0);
    expect(
      events.some((event) => event.type === 'task/plan' || event.type === 'approval/requested'),
    ).toBe(false);
    const results = events.filter((event) => event.type === 'tool/result');
    expect(results).toHaveLength(4);
    expect(results.every((event) => !event.isError)).toBe(true);
    expect(results[0]!.value).toMatchObject({ content: '前言', nextOffset: 2 });
    expect(results[1]!.value).toMatchObject({ content: expect.stringContaining('📖') });
    expect(results[2]!.value).toMatchObject({
      matches: [expect.objectContaining({ offset: 15 }), expect.anything()],
    });
  });

  it('asks about deletion, blocks unexplained programs, and does not classify interpreters as safe', async () => {
    const core = new CoreToolRegistry(new FakeSandbox());
    core.register(bashTool);
    const registry = new PolicyToolRegistry(core, ctx.permissionPolicy);
    expect(
      (await registry.assess({ id: 'd', name: 'bash', args: { command: 'rm report.txt' } }, ctx))
        .decision,
    ).toBe('ask');
    expect(
      (
        await registry.assess(
          { id: 'u', name: 'bash', args: { command: 'python3 script.py' } },
          ctx,
        )
      ).decision,
    ).toBe('unavailable');
    expect(
      (
        await registry.assess(
          { id: 'r', name: 'bash', args: { command: 'cat uploads/book.txt | head -20' } },
          ctx,
        )
      ).decision,
    ).toBe('allowed');
  });
});

it('does not turn alternate path spellings or a different named file into overwrite authority', async () => {
  const sandbox = new FakeSandbox();
  sandbox.files.set('report.txt', 'keep');
  const core = new CoreToolRegistry(sandbox);
  core.register(writeFileTool);
  const gate = new PolicyToolRegistry(core, ctx.permissionPolicy);
  for (const path of ['./report.txt', 'dir/../report.txt', 'dir//report.txt', '+(report.txt)']) {
    const call = { id: 'w', name: 'write_file', args: { path, content: 'replace' } };
    expect((await gate.assess(call, ctx)).decision).toBe('unavailable');
    expect((await gate.execute(call, ctx)).isError).toBe(true);
  }
  expect(
    (
      await gate.assess(
        { id: 'w', name: 'write_file', args: { path: 'report.txt', content: 'replace' } },
        { ...ctx, userRequest: 'Update my-report.txt' },
      )
    ).decision,
  ).toBe('ask');
  expect(
    (
      await gate.assess(
        { id: 'w', name: 'write_file', args: { path: 'report.txt', content: 'replace' } },
        { ...ctx, userRequest: 'Update app.ts and read report.txt' },
      )
    ).decision,
  ).toBe('ask');
  expect(sandbox.files.get('report.txt')).toBe('keep');
});

it('reuses exact current-command authority while respecting explicit asks and sensitive paths', async () => {
  const core = new CoreToolRegistry(new FakeSandbox());
  core.register(bashTool);
  const call = { id: 'd', name: 'bash', args: { command: 'rm report.txt' } };
  const current = { ...ctx, userRequest: 'rm report.txt' };
  expect(
    (await new PolicyToolRegistry(core, ctx.permissionPolicy).assess(call, current)).decision,
  ).toBe('allowed');
  const restricted = {
    ...ctx.permissionPolicy!,
    tools: { bash: 'ask' as const },
    allowWorkspaceInternalBash: false,
  };
  expect((await new PolicyToolRegistry(core, restricted).assess(call, current)).decision).toBe(
    'ask',
  );
  const secret = { id: 's', name: 'bash', args: { command: 'cat .env' } };
  expect(
    (
      await new PolicyToolRegistry(core, ctx.permissionPolicy).assess(secret, {
        ...ctx,
        userRequest: 'cat .env',
      })
    ).decision,
  ).toBe('ask');
});

it('permits targeted edits for an implementation request while protecting full-file replacement', async () => {
  const sandbox = new FakeSandbox();
  sandbox.files.set('src/app.ts', 'const old = 1;\nexport { old };');
  const core = new CoreToolRegistry(sandbox);
  core.register(editFileTool);
  const gate = new PolicyToolRegistry(core, ctx.permissionPolicy);
  const call = {
    id: 'e',
    name: 'edit_file',
    args: { path: 'src/app.ts', old_text: 'old = 1', new_text: 'old = 2' },
  };
  const requested = {
    ...ctx,
    userRequest: 'Please implement the agreed change and update relevant docs.',
  };
  expect((await gate.assess(call, requested)).decision).toBe('allowed');
  expect((await gate.assess(call, { ...ctx, userRequest: 'Review this code' })).decision).toBe(
    'ask',
  );
  expect(
    (
      await gate.assess(
        {
          ...call,
          args: {
            ...call.args,
            old_text: sandbox.files.get('src/app.ts')!,
            new_text: 'replacement',
          },
        },
        requested,
      )
    ).decision,
  ).toBe('ask');
  expect(
    (await gate.assess({ ...call, args: { ...call.args, new_text: '' } }, requested)).decision,
  ).toBe('allowed');
});
