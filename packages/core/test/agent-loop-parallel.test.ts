import { describe, expect, it } from 'vitest';

import type { StreamChunk, ToolDefinition, ToolResult } from '@trinity-harness/contracts';
import { z } from 'zod';

import { CoreAgentLoop, CoreToolRegistry } from '../src/index.js';
import { MemorySessionStore } from '../src/session/index.js';
import { FakeLLM, FakeSandbox, toolCallChunk } from '../src/testing/index.js';

/**
 * M2 tool concurrency (design.md §6.3): parallel-class calls run in a rolling
 * pool, exclusive calls never overlap, and the event log stays in strict
 * model-output order regardless of completion order.
 */

const finish: StreamChunk = { kind: 'finish', reason: 'stop' };

/** Shared in-flight gauge; tests assert the max observed concurrency. */
function gauge() {
  const state = { inFlight: 0, maxInFlight: 0 };
  return {
    state,
    wrap(def: ToolDefinition): ToolDefinition {
      return {
        ...def,
        execute: async (args, ctx) => {
          state.inFlight += 1;
          state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
          try {
            return await def.execute(args, ctx);
          } finally {
            state.inFlight -= 1;
          }
        },
      };
    },
  };
}

function sleepTool(name: string, ms: number, opts?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name,
    description: name,
    parameters: z.looseObject({}),
    execute: async (): Promise<ToolResult> => {
      await new Promise((r) => setTimeout(r, ms));
      return { value: `${name}-done`, isError: false };
    },
    ...opts,
  } as ToolDefinition;
}

function makeLoop(
  scripts: (() => StreamChunk[])[],
  store: MemorySessionStore,
  registry: CoreToolRegistry,
) {
  return new CoreAgentLoop({
    llm: new FakeLLM(...scripts),
    model: 'fake/model',
    tools: registry,
    store,
    workspaceRoot: '/ws',
    maxParallelTools: 3,
  });
}

describe('CoreAgentLoop tool concurrency (M2)', () => {
  it('runs parallel-class tools concurrently and logs results in model order', async () => {
    const store = new MemorySessionStore();
    const registry = new CoreToolRegistry(new FakeSandbox());
    const g = gauge();
    // slow completes after fast — completion order ≠ call order on purpose.
    registry.register(g.wrap(sleepTool('slow', 40)));
    registry.register(g.wrap(sleepTool('fast', 0)));

    const script = () => [toolCallChunk('c1', 'slow', {}), toolCallChunk('c2', 'fast', {}), finish];
    const loop = makeLoop(
      [script, () => [{ kind: 'text-delta', text: 'done' }, finish]],
      store,
      registry,
    );

    const outcome = await loop.run('s1', 'go', { emit: () => {} });
    expect(outcome.reason).toBe('completed');
    expect(g.state.maxInFlight).toBe(2);

    // Log order: call c1, call c2, result c1, result c2 (strict model order).
    const toolEvents = (await store.load('s1')).filter(
      (e) => e.type === 'tool/call' || e.type === 'tool/result',
    );
    expect(
      toolEvents.map((e) => (e.type === 'tool/call' ? `call:${e.callId}` : `result:${e.callId}`)),
    ).toEqual(['call:c1', 'call:c2', 'result:c1', 'result:c2']);
  });

  it('never runs an exclusive tool concurrently with another call', async () => {
    const store = new MemorySessionStore();
    const registry = new CoreToolRegistry(new FakeSandbox());
    const g = gauge();
    registry.register(g.wrap(sleepTool('par', 30)));
    registry.register(g.wrap(sleepTool('excl', 30, { concurrency: 'exclusive' })));

    // par, exclusive, par → waves [par], [excl], [par] — never overlapping.
    const script = () => [
      toolCallChunk('c1', 'par', {}),
      toolCallChunk('c2', 'excl', {}),
      toolCallChunk('c3', 'par', {}),
      finish,
    ];
    const loop = makeLoop(
      [script, () => [{ kind: 'text-delta', text: 'ok' }, finish]],
      store,
      registry,
    );
    await loop.run('s1', 'go', { emit: () => {} });

    expect(g.state.maxInFlight).toBe(1);
    const calls = (await store.load('s1'))
      .filter((e) => e.type === 'tool/call')
      .map((e) => (e.type === 'tool/call' ? e.callId : ''));
    expect(calls).toEqual(['c1', 'c2', 'c3']);
  });

  it('caps the pool at maxParallelTools', async () => {
    const store = new MemorySessionStore();
    const registry = new CoreToolRegistry(new FakeSandbox());
    const g = gauge();
    for (const name of ['t1', 't2', 't3', 't4', 't5']) {
      registry.register(g.wrap(sleepTool(name, 25)));
    }

    const script = () => [
      toolCallChunk('c1', 't1', {}),
      toolCallChunk('c2', 't2', {}),
      toolCallChunk('c3', 't3', {}),
      toolCallChunk('c4', 't4', {}),
      toolCallChunk('c5', 't5', {}),
      finish,
    ];
    const loop = makeLoop(
      [script, () => [{ kind: 'text-delta', text: 'ok' }, finish]],
      store,
      registry,
    );
    await loop.run('s1', 'go', { emit: () => {} });

    expect(g.state.maxInFlight).toBeLessThanOrEqual(3);
    expect(g.state.maxInFlight).toBeGreaterThan(1);
  });
});

it.each(['execution', 'denied', 'rejected'])(
  'skips later browser calls after %s failure, keeps pairs and unrelated tools',
  async (mode) => {
    const store = new MemorySessionStore();
    const registry = new CoreToolRegistry(new FakeSandbox());
    const effects: string[] = [];
    let approvals = 0;
    registry.register({
      name: 'browser',
      description: 'browser',
      parameters: z.object({}),
      concurrency: 'exclusive',
      execute: async (_args, ctx) => {
        effects.push(ctx.callId!);
        return { isError: true, value: { code: 'failed' } };
      },
    });
    registry.register({
      name: 'other',
      description: 'other',
      parameters: z.object({}),
      execute: async () => {
        effects.push('other');
        return { isError: false, value: 'ok' };
      },
    });
    const loop = new CoreAgentLoop({
      store,
      tools: registry,
      workspaceRoot: '/ws',
      model: 'fake/model',
      approvals: {
        request: async (req) => {
          approvals++;
          return { approvalId: req.approvalId, outcome: 'rejected', decidedBy: 'u' };
        },
      },
      llm: new FakeLLM(
        () => [
          toolCallChunk('b1', 'browser', {}),
          toolCallChunk('other', 'other', {}),
          toolCallChunk('b2', 'browser', {}),
          finish,
        ],
        () => [{ kind: 'text-delta', text: 'done' }, finish],
      ),
    });
    await loop.run(
      's',
      'go',
      { emit: () => {} },
      mode === 'execution'
        ? undefined
        : {
            policy: {
              onAsk: 'ask',
              allowWorkspaceInternalBash: false,
              tools: { browser: mode === 'denied' ? 'denied' : 'ask' },
            },
          },
    );
    expect(effects).toEqual(mode === 'execution' ? ['b1', 'other'] : ['other']);
    expect(approvals).toBe(mode === 'rejected' ? 1 : 0);
    const results = (await store.load('s')).filter((e) => e.type === 'tool/result');
    expect(results.map((e) => e.callId)).toEqual(['b1', 'other', 'b2']);
    expect(results[2]).toMatchObject({
      isError: true,
      value: { code: 'NOT_EXECUTED', effect: 'none' },
    });
  },
);

it('resets browser failure ordering between model steps and avoids browser spill', async () => {
  const store = new MemorySessionStore();
  const registry = new CoreToolRegistry(new FakeSandbox());
  let count = 0;
  registry.register({
    name: 'browser',
    description: 'browser',
    parameters: z.object({}),
    concurrency: 'exclusive',
    execute: async () => ({ isError: ++count === 1, value: { count } }),
  });
  const loop = new CoreAgentLoop({
    store,
    tools: registry,
    workspaceRoot: '/ws',
    model: 'fake/model',
    spill: {
      store: {
        put: async () => {
          throw new Error('browser must not spill');
        },
        get: async () => null,
        getMeta: async () => null,
        delete: async () => {},
      },
      thresholdBytes: 1,
    },
    llm: new FakeLLM(
      () => [toolCallChunk('b1', 'browser', {}), finish],
      () => [toolCallChunk('b2', 'browser', {}), finish],
      () => [{ kind: 'text-delta', text: 'done' }, finish],
    ),
  });
  await loop.run('s', 'go', { emit: () => {} });
  expect(count).toBe(2);
  expect(
    (await store.load('s')).filter((e) => e.type === 'tool/result').map((e) => e.value),
  ).toEqual([{ count: 1 }, { count: 2 }]);
});

it('uses the conclusion path after the browser hard delivery ceiling', async () => {
  const store = new MemorySessionStore();
  const registry = new CoreToolRegistry(new FakeSandbox());
  registry.register({
    name: 'browser',
    description: 'browser',
    parameters: z.object({}),
    execute: async () => ({
      isError: true,
      value: {
        kind: 'browser-error-v1',
        code: 'LIMIT_REACHED',
        operation: 'read_observation',
        effect: 'none',
        message: 'limit',
        recovery: 'conclude',
      },
    }),
  });
  const llm = new FakeLLM(
    () => [toolCallChunk('b', 'browser', {}), finish],
    () => [{ kind: 'text-delta', text: 'Collected evidence is limited.' }, finish],
  );
  const loop = new CoreAgentLoop({
    store,
    tools: registry,
    workspaceRoot: '/ws',
    model: 'fake/model',
    llm,
  });
  expect((await loop.run('s', 'go', { emit: () => {} })).reason).toBe('completed');
  expect(llm.requests[1]!.tools).toEqual([]);
});

it.each(['missing', 'allowed', 'rejected'] as const)(
  'gates typed browser actions with a %s approval channel before exposing execution authority',
  async (mode) => {
    const store = new MemorySessionStore();
    const tools = new CoreToolRegistry(new FakeSandbox());
    let executed = false;
    tools.register({
      name: 'browser',
      description: 'browser',
      parameters: z.object({ operation: z.literal('click') }),
      execute: async (_args, ctx) => {
        expect(ctx.permissionGranted).toBe(true);
        expect(
          (await store.load('s')).some(
            (e) => e.type === 'approval/resolved' && e.outcome === 'allowed',
          ),
        ).toBe(true);
        executed = true;
        return { value: 'applied', isError: false };
      },
    });
    const loop = new CoreAgentLoop({
      store,
      tools,
      workspaceRoot: '/ws',
      model: 'fake/model',
      ...(mode === 'missing'
        ? {}
        : {
            approvals: {
              request: async (req) => ({
                approvalId: req.approvalId,
                outcome: mode,
                decidedBy: 'owner',
              }),
            },
          }),
      llm: new FakeLLM(
        () => [toolCallChunk('action', 'browser', { operation: 'click' }), finish],
        () => [{ kind: 'text-delta', text: 'done' }, finish],
      ),
    });
    await loop.run('s', 'go', { emit: () => {} });
    expect(executed).toBe(mode === 'allowed');
    expect((await store.load('s')).find((e) => e.type === 'tool/result')).toMatchObject({
      isError: mode !== 'allowed',
    });
  },
);
