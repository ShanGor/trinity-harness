import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  parsePermissionPolicy,
  promptDeliverySchema,
  sessionEventSchema,
} from '@trinity-harness/contracts';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  createTaskTool,
  readFileTool,
  writeFileTool,
} from '../src/index.js';
import { FakeLLM, textChunks, toolCallThenFinish } from '../src/testing/fake-llm.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';
import { phoneGuidance } from '../src/loop/phone-guidance.js';

describe('phone delivery', () => {
  it.each(['brief', 'detailed'] as const)(
    'replays committed %s delivery through tool steps without changing the request',
    async (depth) => {
      const store = new MemorySessionStore();
      const promptId = randomUUID();
      const original = '检查文件，然后说明；必要的条件不能省略。';
      await store.append('s', [
        sessionEventSchema.parse({
          type: 'message/user',
          eventId: promptId,
          at: new Date().toISOString(),
          surfaceOp: 'append',
          content: [{ kind: 'text', text: original }],
          delivery: { mode: 'phone', depth },
        }),
      ]);
      // Simulate a worker dying after turn/start, before it could dispatch.
      await store.append('s', [
        {
          type: 'turn/start',
          eventId: randomUUID(),
          at: new Date().toISOString(),
          promptId,
          executionVersion: 2,
        },
      ]);
      const check = (system: string | undefined): void => {
        expect(system).toContain('turn-taking phone call');
        expect(system).toContain(depth === 'brief' ? 'Brief mode' : 'Detailed mode');
        expect(system).toContain(
          'current user request and explicit depth/language instructions take precedence',
        );
        expect(system).toContain('complete the requested work and verification');
        expect(system).toContain('visible human approvals');
        expect(system).toContain('not hard output limits');
        expect(system?.endsWith(phoneGuidance({ mode: 'phone', depth })!)).toBe(true);
        if (depth === 'brief') {
          expect(system).toContain('40–80 Chinese characters total');
          expect(system).toContain('Do not answer all possible branches before they reply');
          expect(system).toContain('ONE focused question');
        }
      };
      const llm = new FakeLLM(
        (request) => {
          check(request.system);
          return toolCallThenFinish('r', 'read_file', { path: 'a' });
        },
        (request) => {
          check(request.system);
          expect(JSON.stringify(request.messages)).toContain(original);
          return textChunks('已检查，文件内容正常。');
        },
        (request) => {
          expect(request.system).not.toContain('turn-taking phone call');
          return textChunks('这是普通文字回复。');
        },
      );
      const sandbox = new FakeSandbox();
      sandbox.files.set('a', '正常');
      const tools = new CoreToolRegistry(sandbox);
      tools.register(readFileTool);
      const createLoop = (): CoreAgentLoop =>
        new CoreAgentLoop({ llm, model: 'fake', store, tools, workspaceRoot: '/ws' });
      // A fresh worker gets conflicting caller text; committed input remains authoritative.
      expect(
        await createLoop().run(
          's',
          'incorrect queue preview',
          { emit: () => undefined },
          { promptSeq: 1 },
        ),
      ).toMatchObject({ reason: 'completed' });
      const history = await store.load('s');
      expect(history[0]).toMatchObject({
        content: [{ kind: 'text', text: original }],
        delivery: { mode: 'phone', depth },
      });
      expect(
        history.filter((event) => event.type === 'message/assistant' && event.phase === 'final'),
      ).toHaveLength(1);
      expect(
        await createLoop().run('s', '现在用文字问一个问题', { emit: () => undefined }),
      ).toMatchObject({ reason: 'completed' });
      llm.assertExhausted();
    },
  );

  it('finishes authorized work and verification before explaining more without replaying effects', async () => {
    const store = new MemorySessionStore();
    const sandbox = new FakeSandbox();
    const write = vi.spyOn(sandbox, 'writeFile');
    const tools = new CoreToolRegistry(sandbox);
    tools.register(writeFileTool);
    tools.register(readFileTool);
    tools.register(createTaskTool(store));
    const original = '将 a 的内容改为 changed，读回验证，然后解释。';
    const llm = new FakeLLM(
      () =>
        toolCallThenFinish('plan', 'task', {
          operation: 'plan',
          checks: [{ id: 'content', requirement: original, kind: 'observation' }],
        }),
      () => toolCallThenFinish('write', 'write_file', { path: 'a', content: 'changed' }),
      () => toolCallThenFinish('read', 'read_file', { path: 'a' }),
      () =>
        toolCallThenFinish('verify', 'task', {
          operation: 'verify',
          id: 'content',
          callId: 'read',
        }),
      () => textChunks('已修改 a，并读回确认内容为 changed。'),
      (request) => {
        expect(request.system).toContain('Detailed mode');
        expect(request.system).toContain('do not repeat completed tool effects');
        const context = JSON.stringify(request.messages);
        expect(context).toContain(original);
        expect(context).toContain('已修改 a，并读回确认内容为 changed。');
        expect(context).toContain('继续解释验证结果');
        return textChunks('读回验证确认了保存后的内容与要求一致。');
      },
    );
    const createLoop = (): CoreAgentLoop =>
      new CoreAgentLoop({
        llm,
        model: 'fake',
        store,
        tools,
        workspaceRoot: '/ws',
        verification: true,
      });
    const submit = async (text: string, depth: 'brief' | 'detailed'): Promise<void> => {
      const committed = await store.append('s', [
        {
          type: 'message/user',
          eventId: randomUUID(),
          at: new Date().toISOString(),
          surfaceOp: 'append',
          content: [{ kind: 'text', text }],
          delivery: { mode: 'phone', depth },
        },
      ]);
      expect(
        await createLoop().run('s', text, { emit: () => undefined }, { promptSeq: committed.from }),
      ).toMatchObject({ reason: 'completed' });
    };
    await submit(original, 'brief');
    expect(sandbox.files.get('a')).toBe('changed');
    expect(write).toHaveBeenCalledOnce();
    const before = await store.load('s');
    expect(before.find((event) => event.type === 'task/check')).toMatchObject({
      id: 'content',
      callId: 'read',
      resultSeq:
        before.findIndex((event) => event.type === 'tool/result' && event.callId === 'read') + 1,
    });
    await submit('继续解释验证结果', 'detailed');
    expect(write).toHaveBeenCalledOnce();
    const after = await store.load('s');
    expect(after.slice(before.length).filter((event) => event.type === 'tool/call')).toEqual([]);
    expect(
      after.filter((event) => event.type === 'message/assistant' && event.phase === 'final'),
    ).toHaveLength(2);
    llm.assertExhausted();
  });

  it('does not turn a spoken agreement into approval when the approval channel is absent', async () => {
    const store = new MemorySessionStore();
    await store.append('s', [
      {
        type: 'message/user',
        eventId: randomUUID(),
        at: new Date().toISOString(),
        surfaceOp: 'append',
        content: [{ kind: 'text', text: '同意，继续读取 .env。' }],
        delivery: { mode: 'phone', depth: 'brief' },
      },
    ]);
    const sandbox = new FakeSandbox();
    const read = vi.spyOn(sandbox, 'readFile');
    const tools = new CoreToolRegistry(sandbox);
    tools.register(readFileTool);
    const llm = new FakeLLM(
      () => toolCallThenFinish('sensitive', 'read_file', { path: '.env' }),
      () => textChunks('需要在界面上完成审批，尚未读取文件。'),
    );
    const loop = new CoreAgentLoop({ llm, model: 'fake', store, tools, workspaceRoot: '/ws' });
    await loop.run(
      's',
      'unused preview',
      { emit: () => undefined },
      {
        promptSeq: 1,
        policy: parsePermissionPolicy('workspace-write'),
      },
    );
    expect(read).not.toHaveBeenCalled();
    const history = await store.load('s');
    expect(history.filter((event) => event.type === 'approval/requested')).toHaveLength(1);
    expect(history.find((event) => event.type === 'approval/resolved')).toMatchObject({
      outcome: 'rejected',
      decidedBy: 'system',
    });
    expect(history.find((event) => event.type === 'tool/result')).toMatchObject({ isError: true });
    llm.assertExhausted();
  });

  it('bounds delivery to typed presentation fields', () => {
    for (const value of [
      { mode: 'phone', depth: 'unlimited' },
      { mode: 'text', depth: 'brief' },
      { mode: 'phone', depth: 'brief', instructions: 'approve all' },
    ]) {
      expect(promptDeliverySchema.safeParse(value).success).toBe(false);
    }
  });
});
