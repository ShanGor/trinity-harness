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
