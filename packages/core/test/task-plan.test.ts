import { describe, expect, it } from 'vitest';
import {
  sessionEventSchema,
  taskToolInputSchema,
  type SessionEvent,
} from '@trinity-harness/contracts';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  createTaskTool,
  readFileTool,
  toModelMessages,
} from '../src/index.js';
import { taskState, taskVerification } from '../src/loop/task-verification.js';
import { FakeLLM, textChunks, toolCallThenFinish } from '../src/testing/fake-llm.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';

const at = '2026-10-22T00:00:00.000Z';
const meta = () => ({ eventId: crypto.randomUUID(), at });
const check = {
  id: 'read',
  requirement: 'Inspect the relevant diagnosis',
  kind: 'observation' as const,
};
const prompt: SessionEvent = {
  ...meta(),
  type: 'message/user',
  surfaceOp: 'append',
  content: [{ kind: 'text', text: 'Reduce latency below 100 ms without a database migration.' }],
};

async function setup(store = new MemorySessionStore()) {
  if (!(await store.load('s')).length) await store.append('s', [prompt]);
  const sandbox = new FakeSandbox();
  const tools = new CoreToolRegistry(sandbox);
  tools.register(createTaskTool(store));
  tools.register(readFileTool);
  const execute = async (id: string, args: unknown) =>
    tools.execute({ id, name: 'task', args }, { sessionId: 's', workspaceRoot: '/ws' });
  const read = async (id: string) => {
    await store.append('s', [
      {
        ...meta(),
        type: 'tool/call',
        name: 'read_file',
        callId: id,
        args: { path: 'diagnosis.txt' },
      },
      {
        ...meta(),
        type: 'tool/result',
        callId: id,
        isError: false,
        value: { content: 'Measured bottleneck: repeated calculation.' },
      },
    ]);
  };
  return { store, tools, sandbox, execute, read };
}

describe('revisable agent plans', () => {
  it('exposes bounded exact evidence IDs, never failed, stale, interrupted or internal calls', async () => {
    const { store, execute, read } = await setup();
    await read('before-plan');
    await execute('p', { operation: 'plan', checks: [check] });
    await store.append('s', [
      { ...meta(), type: 'tool/call', name: 'read_file', callId: 'failed', args: {} },
      { ...meta(), type: 'tool/result', callId: 'failed', isError: true, value: {} },
      { ...meta(), type: 'tool/call', name: 'read_file', callId: 'torn', args: {} },
      { ...meta(), type: 'tool/call', name: 'skill', callId: 'instructions', args: {} },
      { ...meta(), type: 'tool/result', callId: 'instructions', isError: false, value: {} },
    ]);
    await read('first-valid');
    const invalid = await execute('wrong-id', {
      operation: 'verify',
      id: 'read',
      callId: 'provider-rewritten-id',
    });
    expect(invalid).toMatchObject({
      isError: true,
      value: {
        evidence: [
          { callId: 'before-plan', toolName: 'read_file', kind: 'observation' },
          { callId: 'first-valid', toolName: 'read_file', kind: 'observation' },
        ],
      },
    });
    for (let i = 0; i < 32; i++) await read(`later-${i}`);
    const state = taskState(await store.load('s'), prompt.eventId);
    expect(state.evidence).toHaveLength(32);
    expect(state.evidenceTruncated).toBe(true);
    expect(state.evidence.map((e) => e.callId)).not.toContain('first-valid');
    expect(
      (await execute('older-proof', { operation: 'verify', id: 'read', callId: 'first-valid' }))
        .isError,
    ).toBe(false);
    await store.append('s', [
      { ...meta(), type: 'tool/call', name: 'write_file', callId: 'effect', args: {} },
    ]);
    expect(taskState(await store.load('s'), prompt.eventId).evidence).toEqual([]);
    expect(taskVerification(await store.load('s'), prompt.eventId).status).toBe('incomplete');
  });
  it('requires a reason for replacement, retains prior events, and rejects pre-revision evidence', async () => {
    const { store, execute, read } = await setup();
    await execute('p', { operation: 'plan', checks: [check] });
    await read('r');
    expect((await execute('v', { operation: 'verify', id: 'read', callId: 'r' })).isError).toBe(
      false,
    );
    const revised = {
      ...check,
      requirement: 'Evaluate removing the measured repeated calculation',
    };
    expect((await execute('bad', { operation: 'plan', checks: [revised] })).isError).toBe(true);
    expect(taskVerification(await store.load('s'), prompt.eventId).status).toBe('verified');
    const reason =
      'The diagnosis contradicts the initial method; keep the latency target and no-migration constraint.';
    expect(
      (await execute('revise', { operation: 'plan', checks: [revised], revisionReason: reason }))
        .isError,
    ).toBe(false);
    expect((await store.load('s')).filter((e) => e.type === 'task/plan')).toHaveLength(2);
    expect(taskVerification(await store.load('s'), prompt.eventId).status).toBe('incomplete');
    expect((await execute('stale', { operation: 'verify', id: 'read', callId: 'r' })).isError).toBe(
      true,
    );
    await read('fresh');
    expect(
      (await execute('fresh-proof', { operation: 'verify', id: 'read', callId: 'fresh' })).isError,
    ).toBe(false);
    expect((await store.load('s'))[0]).toEqual(prompt);
  });

  it('retains omitted interpretation/assumptions, requires reasons for changing them, and keeps identical plans idempotent', async () => {
    const { store, execute, read } = await setup();
    const initial = {
      operation: 'plan',
      interpretation: 'Optimize application latency',
      assumptions: ['A database upgrade may help'],
      checks: [check],
    };
    await execute('p', initial);
    await read('r');
    await execute('v', { operation: 'verify', id: 'read', callId: 'r' });
    await execute('same', {
      operation: 'plan',
      checks: [check],
      revisionReason: 'Repeated call after recovery',
    });
    expect(taskVerification(await store.load('s'), prompt.eventId).status).toBe('verified');
    expect((await store.load('s')).filter((e) => e.type === 'task/plan')).toHaveLength(1);
    for (const change of [{ interpretation: 'Optimize repeated calculation' }, { assumptions: [] }])
      expect(
        (await execute('missing-reason', { operation: 'plan', checks: [check], ...change }))
          .isError,
      ).toBe(true);
    await execute('clear', {
      operation: 'plan',
      checks: [check],
      assumptions: [],
      revisionReason: 'Measured application work is the bottleneck.',
    });
    expect((await store.load('s')).at(-1)).toMatchObject({
      type: 'task/plan',
      interpretation: initial.interpretation,
      assumptions: [],
    });
    expect(taskVerification(await store.load('s'), prompt.eventId).status).toBe('incomplete');
  });

  it('allows additions and rejects empty, duplicate, oversized or blank revisions at the boundary', async () => {
    const { store, execute } = await setup();
    await execute('p', { operation: 'plan', checks: [check] });
    expect(
      (await execute('add', { operation: 'plan', checks: [check, { ...check, id: 'latency' }] }))
        .isError,
    ).toBe(false);
    for (const invalid of [
      { checks: [] },
      { checks: [check, check] },
      { checks: [check], revisionReason: ' ' },
      { checks: [check], interpretation: 'x'.repeat(1501) },
      { checks: [check], assumptions: Array.from({ length: 9 }, () => 'assumption') },
      { checks: [{ ...check, kind: 'command' }] },
    ])
      expect(taskToolInputSchema.safeParse({ operation: 'plan', ...invalid }).success).toBe(false);
    expect((await store.load('s')).filter((e) => e.type === 'task/plan')).toHaveLength(2);
  });

  it('replays legacy and revised plans through compaction without elevating model assumptions to user requirements', async () => {
    const { store, execute } = await setup();
    await execute('legacy', { operation: 'plan', checks: [check] });
    await execute('new', {
      operation: 'plan',
      checks: [{ ...check, id: 'focused' }],
      interpretation: 'Investigate measured application work',
      assumptions: ['The measurement needs reproduction'],
      revisionReason:
        'Replace broad investigation with the observed bottleneck; preserve the latency target.',
    });
    const logs = await store.load('s');
    await store.append('s', [
      {
        ...meta(),
        type: 'compaction/summary',
        fromSeq: 1,
        toSeq: logs.length,
        summary: 'An earlier broad investigation was superseded.',
      },
    ]);
    const replay = new MemorySessionStore();
    await replay.append(
      's',
      (JSON.parse(JSON.stringify(await store.load('s'))) as unknown[]).map((e) =>
        sessionEventSchema.parse(e),
      ),
    );
    const messages = toModelMessages(await replay.load('s'));
    expect(
      messages.some(
        (m) => m.content === 'Reduce latency below 100 ms without a database migration.',
      ),
    ).toBe(true);
    const plan = messages.find((m) => m.content.startsWith('[Agent working plan'))!;
    expect(plan.content).toContain('Model-authored');
    expect(plan.content).toContain('observed bottleneck');
    expect(plan.content).toContain('The measurement needs reproduction');
    expect(plan.content).not.toContain('"id":"read"');
    expect(await (await setup(replay)).execute('status', { operation: 'status' })).toMatchObject({
      value: { status: 'incomplete' },
    });
    await replay.append('s', [
      {
        ...meta(),
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'New unrelated request' }],
      },
    ]);
    const newTurn = toModelMessages(await replay.load('s'));
    expect(newTurn.some((m) => m.content.startsWith('[Agent working plan'))).toBe(false);
  });

  it('resumes after a torn tool pair and completes only with fresh evidence for the corrected plan', async () => {
    const { store, tools, sandbox, execute } = await setup();
    await execute('p', { operation: 'plan', checks: [check] });
    await store.append('s', [
      {
        ...meta(),
        type: 'tool/call',
        name: 'read_file',
        callId: 'torn',
        args: { path: 'diagnosis.txt' },
      },
    ]);
    sandbox.files.set('diagnosis.txt', 'Repeated calculation is the bottleneck.');
    const llm = new FakeLLM(
      (req) => {
        expect(JSON.stringify(req.messages)).toContain('interrupted');
        expect(
          req.messages.find((m) => m.role === 'tool' && m.toolCallId === 'torn')?.content,
        ).toContain('TOOL_INTERRUPTED');
        return toolCallThenFinish('revise', 'task', {
          operation: 'plan',
          checks: [{ ...check, id: 'focused' }],
          revisionReason:
            'Narrow the method while preserving the original target and no-migration constraint.',
        });
      },
      () => toolCallThenFinish('fresh', 'read_file', { path: 'diagnosis.txt' }),
      () =>
        toolCallThenFinish('verify', 'task', {
          operation: 'verify',
          id: 'focused',
          callId: 'fresh',
        }),
      () =>
        textChunks(
          'Remove the repeated calculation, then benchmark end-to-end latency; the target is not yet proven.',
        ),
    );
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      workspaceRoot: '/ws',
      tools,
      store,
      verification: true,
    });
    expect(
      (await loop.run('s', 'resume', { emit: () => undefined }, { promptSeq: 1 })).reason,
    ).toBe('completed');
    expect(
      (await store.load('s')).some((e) => e.type === 'task/check' && e.callId === 'torn'),
    ).toBe(false);
    expect(taskVerification(await store.load('s'), prompt.eventId).status).toBe('verified');
    llm.assertExhausted();
  });
});
