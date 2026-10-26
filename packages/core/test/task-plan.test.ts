import { describe, expect, it } from 'vitest';
import {
  sessionEventSchema,
  taskToolInputSchema,
  taskStatusSchema,
  type SessionEvent,
  type LLMRequest,
} from '@trinity-harness/contracts';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  createTaskTool,
  bashTool,
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
  it('adds adjacent references only for currently eligible successful results and leaves stored values unchanged', async () => {
    const { store, execute, read } = await setup();
    await execute('plan', { operation: 'plan', checks: [{ ...check, dependency: 'workspace' }] });
    await read('read');
    const events = await store.load('s');
    const seq = events.length;
    const projected = toModelMessages(events).find((message) => message.toolCallId === 'read');
    expect(projected?.content).toContain(`Runtime verification reference: resultSeq=${seq}`);
    expect(JSON.stringify(events.at(-1))).not.toContain('Runtime verification reference');
    await store.append('s', [
      {
        ...meta(),
        type: 'tool/call',
        name: 'write_file',
        callId: 'effect',
        args: {},
        effect: { kind: 'mutation', scope: 'workspace' },
      },
      {
        ...meta(),
        type: 'tool/result',
        callId: 'effect',
        isError: false,
        value: {},
        effect: { kind: 'mutation', scope: 'workspace' },
      },
      { ...meta(), type: 'tool/call', name: 'read_file', callId: 'failed', args: {} },
      { ...meta(), type: 'tool/result', callId: 'failed', isError: true, value: {} },
    ]);
    const after = toModelMessages(await store.load('s'));
    expect(after.find((message) => message.toolCallId === 'read')?.content).not.toContain(
      'Runtime verification reference',
    );
    expect(after.find((message) => message.toolCallId === 'failed')?.content).not.toContain(
      'Runtime verification reference',
    );
  });

  it('explains command mismatches and keeps diagnostics separate from eligible evidence on replay', async () => {
    const { store, execute } = await setup();
    const command = 'uname -a; cat /etc/os-release';
    const planned = { id: 'os', kind: 'command', requirement: 'Capture OS', command };
    await execute('plan', { operation: 'plan', checks: [planned] });
    await store.append('s', [
      {
        ...meta(),
        type: 'tool/call',
        name: 'bash',
        callId: 'formatted',
        args: { command: `${command}; hostname` },
      },
      {
        ...meta(),
        type: 'tool/result',
        callId: 'formatted',
        isError: false,
        value: { exitCode: 0, stdout: 'Linux' },
      },
    ]);
    const status = await execute('status', { operation: 'status' });
    expect(taskStatusSchema.parse(status.value)).toMatchObject({
      status: 'incomplete',
      evidence: [],
      commandRepairs: [{ checkId: 'os', command, reason: 'exact_command_required' }],
    });
    expect(
      await execute('wrong-proof', { operation: 'verify', id: 'os', callId: 'formatted' }),
    ).toMatchObject({
      isError: true,
      value: { message: expect.stringContaining('does not exactly match') },
    });
    const replay = new MemorySessionStore();
    await replay.append(
      's',
      (await store.load('s')).map((event) => sessionEventSchema.parse(event)),
    );
    expect(taskState(await replay.load('s'), prompt.eventId)).toEqual(status.value);
    const messages = toModelMessages(await replay.load('s'));
    const control = messages.find((message) => message.content.startsWith('[Agent working plan'))!;
    expect(control.content).toContain('exact_command_required');
    expect(control.content).toContain('extra formatting');
    expect(messages.find((message) => message.toolCallId === 'formatted')?.content).not.toContain(
      'Runtime verification reference',
    );
  });

  it('distinguishes stale exact results from evidence that only needs verification', async () => {
    const { store, execute } = await setup();
    const command = 'uname -a';
    await execute('plan', {
      operation: 'plan',
      checks: [{ id: 'os', kind: 'command', requirement: 'Capture OS', command }],
    });
    const run = async (callId: string, exitCode = 0) => {
      await store.append('s', [
        { ...meta(), type: 'tool/call', name: 'bash', callId, args: { command } },
        { ...meta(), type: 'tool/result', callId, isError: false, value: { exitCode } },
      ]);
      return (await store.load('s')).length;
    };
    await run('failed', 1);
    expect(taskState(await store.load('s'), prompt.eventId).commandRepairs?.[0]?.reason).toBe(
      'exact_command_required',
    );
    const resultSeq = await run('exact');
    expect(taskState(await store.load('s'), prompt.eventId).commandRepairs).toEqual([
      { checkId: 'os', command, reason: 'verification_required', resultSeq },
    ]);
    await execute('verify', { operation: 'verify', id: 'os', resultSeq });
    expect(taskState(await store.load('s'), prompt.eventId).commandRepairs).toBeUndefined();
    await store.append('s', [
      { ...meta(), type: 'tool/call', name: 'write_file', callId: 'mutation', args: {} },
      { ...meta(), type: 'tool/result', callId: 'mutation', isError: false, value: {} },
    ]);
    expect(taskState(await store.load('s'), prompt.eventId).commandRepairs).toEqual([
      { checkId: 'os', command, reason: 'fresh_evidence_required' },
    ]);
    expect((await execute('stale', { operation: 'verify', id: 'os', resultSeq })).isError).toBe(
      true,
    );
    const nextPrompt = { ...prompt, ...meta() };
    await store.append('s', [nextPrompt]);
    await execute('next-plan', {
      operation: 'plan',
      checks: [{ id: 'os', kind: 'command', requirement: 'Capture OS', command }],
    });
    expect(taskState(await store.load('s'), nextPrompt.eventId).commandRepairs?.[0]?.reason).toBe(
      'exact_command_required',
    );
  });

  it('recovers the system-info command mismatch and completes after exact commands are verified', async () => {
    const store = new MemorySessionStore();
    const sandbox = new FakeSandbox();
    const executed: string[] = [];
    sandbox.execHandler = (command) => {
      executed.push(command);
      return { stdout: 'fixture system info', stderr: '', exitCode: 0 };
    };
    const tools = new CoreToolRegistry(sandbox);
    tools.register(createTaskTool(store));
    tools.register(bashTool);
    const checks = [
      {
        id: 'os',
        kind: 'command',
        requirement: 'Capture OS',
        command: 'uname -a; cat /etc/os-release',
      },
      {
        id: 'resources',
        kind: 'command',
        requirement: 'Capture resources',
        command: 'lscpu; free -h; df -h /',
      },
    ];
    const llm = new FakeLLM(
      () => toolCallThenFinish('plan', 'task', { operation: 'plan', checks }),
      () =>
        toolCallThenFinish('formatted-os', 'bash', { command: `${checks[0]!.command}; hostname` }),
      () =>
        toolCallThenFinish('formatted-resources', 'bash', { command: `${checks[1]!.command}; id` }),
      () => textChunks('The system information was collected.'),
      ...checks.flatMap((check, index) => [
        (request: LLMRequest) => {
          const control = request.messages.find((message) =>
            message.content.startsWith('[Agent working plan'),
          )!;
          expect(control.content).toContain('exact_command_required');
          expect(control.content).toContain(check.command);
          return toolCallThenFinish(`exact-${index}`, 'bash', { command: check.command });
        },
        (request: LLMRequest) => {
          const control = request.messages.find((message) =>
            message.content.startsWith('[Agent working plan'),
          )!;
          const status = taskStatusSchema.parse(
            JSON.parse(control.content.split('\n').slice(1).join('\n')),
          );
          const repair = status.commandRepairs!.find((item) => item.checkId === check.id)!;
          expect(repair.reason).toBe('verification_required');
          return toolCallThenFinish(`verify-${index}`, 'task', {
            operation: 'verify',
            id: repair.checkId,
            resultSeq: repair.resultSeq,
          });
        },
      ]),
      () => textChunks('Here is the system information from the guest.'),
    );
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      workspaceRoot: '/ws',
      tools,
      store,
      verification: true,
    });
    expect((await loop.run('s', 'show me the system info', { emit: () => undefined })).reason).toBe(
      'completed',
    );
    const events = await store.load('s');
    expect(events.filter((event) => event.type === 'task/recovery')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'task/check')).toHaveLength(2);
    expect(events.findLast((event) => event.type === 'task/assessment')).toMatchObject({
      status: 'verified',
      pending: [],
    });
    expect(executed).toEqual([
      `${checks[0]!.command}; hostname`,
      `${checks[1]!.command}; id`,
      ...checks.map((check) => check.command),
    ]);
    llm.assertExhausted();
  });

  it('verifies using an exact event sequence and retains callId compatibility', async () => {
    const { store, execute, read } = await setup();
    await execute('plan', { operation: 'plan', checks: [check] });
    await read('opaque-engine-owned-id');
    const resultSeq = (await store.load('s')).length;
    expect(
      (await execute('verify-seq', { operation: 'verify', id: check.id, resultSeq })).isError,
    ).toBe(false);
    const recorded = (await store.load('s')).findLast((event) => event.type === 'task/check');
    expect(recorded).toMatchObject({ callId: 'opaque-engine-owned-id', resultSeq });
    expect(
      (
        await execute('verify-id', {
          operation: 'verify',
          id: check.id,
          callId: 'opaque-engine-owned-id',
        })
      ).isError,
    ).toBe(false);
  });

  it('rejects mismatched selectors and failed, stale or non-result sequences', async () => {
    const { store, execute, read } = await setup();
    await execute('plan', { operation: 'plan', checks: [{ ...check, dependency: 'workspace' }] });
    await read('observed');
    const observedSeq = (await store.load('s')).length;
    expect(
      (
        await execute('mismatch', {
          operation: 'verify',
          id: check.id,
          resultSeq: observedSeq,
          callId: 'different-id',
        })
      ).isError,
    ).toBe(true);
    expect(
      (await execute('not-result', { operation: 'verify', id: check.id, resultSeq: 1 })).isError,
    ).toBe(true);
    await store.append('s', [
      { ...meta(), type: 'tool/call', callId: 'failed', name: 'read_file', args: {} },
      { ...meta(), type: 'tool/result', callId: 'failed', isError: true, value: {} },
    ]);
    expect(
      (
        await execute('failed-receipt', {
          operation: 'verify',
          id: check.id,
          resultSeq: (await store.load('s')).length,
        })
      ).isError,
    ).toBe(true);
    await store.append('s', [
      {
        ...meta(),
        type: 'tool/call',
        callId: 'effect',
        name: 'write_file',
        args: {},
        effect: { kind: 'mutation', scope: 'workspace' },
      },
      {
        ...meta(),
        type: 'tool/result',
        callId: 'effect',
        isError: false,
        value: {},
        effect: { kind: 'mutation', scope: 'workspace' },
      },
    ]);
    expect(
      (await execute('stale', { operation: 'verify', id: check.id, resultSeq: observedSeq }))
        .isError,
    ).toBe(true);
    const next = { ...prompt, ...meta() };
    await store.append('s', [next]);
    await execute('next-plan', { operation: 'plan', checks: [check] });
    expect(
      (
        await execute('previous-prompt', {
          operation: 'verify',
          id: check.id,
          resultSeq: observedSeq,
        })
      ).isError,
    ).toBe(true);
    expect((await store.load('s')).some((event) => event.type === 'task/check')).toBe(false);
  });

  it('requires an exact evidence selector in the shared verify schema', () => {
    expect(taskToolInputSchema.safeParse({ operation: 'verify', id: 'x' }).success).toBe(false);
    expect(
      taskToolInputSchema.safeParse({ operation: 'verify', id: 'x', resultSeq: 0 }).success,
    ).toBe(false);
    expect(
      taskToolInputSchema.safeParse({ operation: 'verify', id: 'x', resultSeq: 4 }).success,
    ).toBe(true);
  });

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
