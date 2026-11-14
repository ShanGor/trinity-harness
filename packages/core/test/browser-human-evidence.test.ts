import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sessionEventSchema, type SessionEvent, type ToolEffect } from '@trinity-harness/contracts';
import { toModelMessages } from '../src/index.js';
import { taskEvidence } from '../src/loop/task-verification.js';

const meta = () => ({ eventId: randomUUID(), at: '2026-10-26T00:00:00Z' });
const control = (): SessionEvent => ({
  ...meta(),
  type: 'browser/control_changed',
  generation: randomUUID(),
  epoch: 1,
  mode: 'human',
});
it('retains browser control across personal context selection without treating input as instructions', () => {
  const prompt: SessionEvent = {
    ...meta(),
    type: 'message/user',
    surfaceOp: 'append',
    content: [{ kind: 'text', text: 'Continue researching' }],
  };
  const events: SessionEvent[] = [
    control(),
    prompt,
    {
      ...meta(),
      type: 'memory/selection',
      receipt: {
        promptId: prompt.eventId,
        policyRevision: 0,
        memories: [],
        episodes: [],
        omitted: false,
      },
    },
  ];
  const messages = toModelMessages(events.map((event) => sessionEventSchema.parse(event)));
  const hints = messages.filter((message) =>
    message.content.startsWith('[Runtime browser control:'),
  );
  expect(hints).toHaveLength(1);
  expect(hints[0]).toMatchObject({ role: 'user', context: 'control' });
  expect(hints[0]!.content).toContain('human');
  expect(hints[0]!.content).toContain('not a new task instruction');
  expect(messages.at(-1)?.content).toBe('Continue researching');
});
it.each(['browser/control_changed', 'browser/user_input'] as const)(
  '%s invalidates current browser receipts while retaining immutable sources and workspace reads on replay',
  (type) => {
    const prompt: SessionEvent = {
      ...meta(),
      type: 'message/user',
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'Inspect current state and reference' }],
    };
    const events: SessionEvent[] = [
      prompt,
      {
        ...meta(),
        type: 'task/plan',
        promptId: prompt.eventId,
        evidenceVersion: 2,
        checks: [
          { id: 'live', requirement: 'Current page', kind: 'observation', dependency: 'browser' },
          {
            id: 'source',
            requirement: 'Saved source',
            kind: 'observation',
            dependency: 'reference',
          },
          {
            id: 'files',
            requirement: 'Workspace state',
            kind: 'observation',
            dependency: 'workspace',
          },
        ],
      },
    ];
    const read = (callId: string, effect: ToolEffect): void => {
      events.push(
        { ...meta(), type: 'tool/call', callId, name: 'browser', args: {}, effect },
        { ...meta(), type: 'tool/result', callId, value: {}, isError: false },
      );
    };
    read('live', { kind: 'read', scope: 'browser', evidence: 'observation' });
    read('source', { kind: 'read', scope: 'reference', evidence: 'immutable-observation' });
    read('files', { kind: 'read', scope: 'workspace', evidence: 'observation' });
    expect(taskEvidence(events, prompt.eventId).map((e) => e.callId)).toEqual([
      'live',
      'source',
      'files',
    ]);
    events.push(
      type === 'browser/control_changed'
        ? control()
        : {
            ...meta(),
            type,
            generation: randomUUID(),
            epoch: 1,
            requestId: randomUUID(),
            effect: 'unknown',
          },
    );
    const replay = events.map((event) => sessionEventSchema.parse(event));
    expect(taskEvidence(replay, prompt.eventId).map((e) => e.callId)).toEqual(['source', 'files']);
    read('fresh', { kind: 'read', scope: 'browser', evidence: 'observation' });
    expect(taskEvidence(events, prompt.eventId).map((e) => e.callId)).toEqual([
      'source',
      'files',
      'fresh',
    ]);
  },
);

it('retains exact capture receipts across descriptive plan changes and later workspace effects', () => {
  const prompt: SessionEvent = {
    ...meta(),
    type: 'message/user',
    surfaceOp: 'append',
    content: [{ kind: 'text', text: 'Export page' }],
  };
  const plan: Extract<SessionEvent, { type: 'task/plan' }> = {
    ...meta(),
    type: 'task/plan',
    promptId: prompt.eventId,
    evidenceVersion: 2,
    interpretation: 'Capture and export',
    checks: [
      {
        id: 'capture',
        kind: 'observation',
        requirement: 'Rendered capture created',
        dependency: 'browser',
        operation: 'capture_document',
      },
    ],
  };
  const events: SessionEvent[] = [
    prompt,
    plan,
    {
      ...meta(),
      type: 'tool/call',
      name: 'browser',
      callId: 'capture',
      args: { operation: 'capture_document' },
      effect: { kind: 'read', scope: 'browser', evidence: 'immutable-observation' },
    },
    {
      ...meta(),
      type: 'tool/result',
      callId: 'capture',
      value: { captureId: 'saved' },
      isError: false,
    },
    {
      ...meta(),
      type: 'tool/call',
      name: 'browser',
      callId: 'pixels',
      args: { operation: 'screenshot' },
      effect: { kind: 'read', scope: 'browser', evidence: 'immutable-observation' },
    },
    { ...meta(), type: 'tool/result', callId: 'pixels', value: {}, isError: false },
    {
      ...plan,
      ...meta(),
      interpretation: 'Graphics are inline SVG',
      revisionReason: 'Clarify representation',
    },
    {
      ...meta(),
      type: 'tool/call',
      name: 'bash',
      callId: 'copy',
      args: { command: 'cp a b' },
      effect: { kind: 'unknown', scope: 'workspace', evidence: 'none' },
    },
    { ...meta(), type: 'tool/result', callId: 'copy', value: { exitCode: 0 }, isError: false },
  ];
  expect(
    taskEvidence(
      events.map((event) => sessionEventSchema.parse(event)),
      prompt.eventId,
    ).map((item) => item.callId),
  ).toEqual(['capture']);
  events.push({
    ...plan,
    ...meta(),
    checks: [{ ...plan.checks[0]!, requirement: 'Different capture requirement' }],
    revisionReason: 'Changed requirement',
  });
  expect(taskEvidence(events, prompt.eventId)).toEqual([]);
});

it('retains resource-specific reads across unrelated copies but invalidates the copied destination', () => {
  const prompt: SessionEvent = {
    ...meta(),
    type: 'message/user',
    surfaceOp: 'append',
    content: [{ kind: 'text', text: 'Read files' }],
  };
  const events: SessionEvent[] = [
    prompt,
    {
      ...meta(),
      type: 'task/plan',
      promptId: prompt.eventId,
      evidenceVersion: 2,
      checks: ['a', 'b'].map((path) => ({
        id: path,
        kind: 'observation' as const,
        requirement: path,
        dependency: 'workspace' as const,
        resourcePaths: [path],
      })),
    },
  ];
  for (const path of ['a', 'b'])
    events.push(
      {
        ...meta(),
        type: 'tool/call',
        callId: path,
        name: 'read_file',
        args: { path },
        effect: {
          kind: 'read',
          scope: 'workspace',
          evidence: 'observation',
          resourcePaths: [path],
        },
      },
      { ...meta(), type: 'tool/result', callId: path, value: {}, isError: false },
    );
  events.push(
    {
      ...meta(),
      type: 'tool/call',
      callId: 'copy',
      name: 'bash',
      args: { command: 'cp c b' },
      effect: { kind: 'mutation', scope: 'workspace', resourcePaths: ['b'] },
    },
    { ...meta(), type: 'tool/result', callId: 'copy', value: {}, isError: false },
  );
  expect(
    taskEvidence(
      events.map((event) => sessionEventSchema.parse(event)),
      prompt.eventId,
    ).map((item) => item.callId),
  ).toEqual(['a']);
});
