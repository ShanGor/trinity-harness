import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  sessionEventSchema,
  taskStatusSchema,
  type SessionEvent,
  type ToolEffect,
} from '@trinity-harness/contracts';
import {
  evidenceRejectionDetails,
  taskEvidence,
  taskState,
} from '../src/loop/task-verification.js';

const meta = () => ({ eventId: randomUUID(), at: '2026-11-14T00:00:00Z' });
function fixture(): { events: SessionEvent[]; promptId: string } {
  const prompt: SessionEvent = {
    ...meta(),
    type: 'message/user',
    surfaceOp: 'append',
    content: [{ kind: 'text', text: 'Inspect the exported file' }],
  };
  return {
    promptId: prompt.eventId,
    events: [
      prompt,
      {
        ...meta(),
        type: 'task/plan',
        promptId: prompt.eventId,
        evidenceVersion: 2,
        checks: [
          {
            id: 'file',
            kind: 'observation',
            requirement: 'Read the output',
            dependency: 'workspace',
            resourcePaths: ['output.md'],
          },
        ],
      },
    ],
  };
}
function call(events: SessionEvent[], id: string, effect: ToolEffect, failed = false): void {
  events.push(
    {
      ...meta(),
      type: 'tool/call',
      callId: id,
      name: 'read_file',
      args: { path: 'output.md' },
      effect,
    },
    {
      ...meta(),
      type: 'tool/result',
      callId: id,
      value: { content: 'PRIVATE VALUE NEVER IN DIAGNOSTICS' },
      isError: failed,
    },
  );
}
const read: ToolEffect = {
  kind: 'read',
  scope: 'workspace',
  evidence: 'observation',
  resourcePaths: ['output.md'],
};

it.each(['mutation', 'unknown'] as const)(
  'shares %s rejection diagnostics with eligibility and survives replay',
  (kind) => {
    const { events, promptId } = fixture();
    call(events, 'read', read);
    events.push(
      {
        ...meta(),
        type: 'tool/call',
        callId: 'effect',
        name: 'bash',
        args: { command: 'PRIVATE COMMAND' },
        effect: { kind, scope: 'workspace', resourcePaths: ['output.md'] },
      },
      { ...meta(), type: 'tool/result', callId: 'effect', value: {}, isError: false },
    );
    const replay = events.map((event) => sessionEventSchema.parse(event));
    expect(taskEvidence(replay, promptId)).toEqual([]);
    const detail = evidenceRejectionDetails(replay, promptId, 'file', 'read');
    expect(detail).toMatchObject({
      checkId: 'file',
      checkRevisionSeq: 2,
      resultSeq: 4,
      invalidatingSeq: 6,
      reason: kind === 'unknown' ? 'unknown_effect' : 'later_effect',
      repair: kind === 'unknown' ? 'inspect_effect_before_retry' : 'observe_affected_state',
    });
    const status = taskStatusSchema.parse(taskState(replay, promptId));
    expect(status.rejections).toEqual([detail]);
    expect(JSON.stringify(detail)).not.toMatch(/PRIVATE|output.md/);
    call(replay, 'fresh', read);
    expect(taskEvidence(replay, promptId).map((item) => item.callId)).toEqual(['fresh']);
    expect(taskState(replay, promptId).rejections).toEqual([]);
  },
);

it('reports failed and torn-tail receipts without claiming they succeeded or repeating effects', () => {
  const { events, promptId } = fixture();
  call(events, 'failed', read, true);
  expect(taskState(events, promptId).rejections?.[0]).toMatchObject({
    reason: 'failed_result',
    resultSeq: 4,
  });
  events.push({
    ...meta(),
    type: 'tool/call',
    callId: 'torn',
    name: 'read_file',
    args: {},
    effect: read,
  });
  expect(taskState(events, promptId).rejections?.[0]).toMatchObject({
    reason: 'missing_result',
    repair: 'inspect_failed_result',
  });
  expect(taskState(events, promptId).rejections?.[0]).not.toHaveProperty('resultSeq');
  expect(taskEvidence(events, promptId)).toEqual([]);
});

it('reports changed-check boundaries and bounds diagnostics to the active request', () => {
  const { events, promptId } = fixture();
  call(events, 'read', read);
  const plan = events[1]!;
  if (plan.type !== 'task/plan') throw Error('fixture');
  events.push({
    ...plan,
    ...meta(),
    checks: [{ ...plan.checks[0]!, requirement: 'Changed requirement' }],
  });
  expect(evidenceRejectionDetails(events, promptId, 'file', 'read')).toMatchObject({
    reason: 'changed_check',
    checkRevisionSeq: 5,
  });
  expect(taskState(events, promptId).rejections?.[0]).toMatchObject({ reason: 'changed_check' });
  events.push({
    ...meta(),
    type: 'message/user',
    surfaceOp: 'append',
    content: [{ kind: 'text', text: 'Next request' }],
  });
  call(events, 'other-turn', read);
  expect(evidenceRejectionDetails(events, promptId, 'file', 'other-turn')).toMatchObject({
    reason: 'outside_request',
    repair: 'use_current_request',
  });
});

it('preserves publication evidence across unrelated copies, but invalidates overlapping output changes', () => {
  const { events, promptId } = fixture();
  const plan = events[1]!;
  if (plan.type !== 'task/plan') throw Error('fixture');
  plan.checks = [
    {
      id: 'export',
      kind: 'observation',
      requirement: 'Publish Markdown',
      dependency: 'workspace',
      operation: 'export_markdown',
    },
  ];
  const bundle = 'browser-capture-' + 'a'.repeat(32);
  events.push(
    {
      ...meta(),
      type: 'tool/call',
      callId: 'export',
      name: 'browser',
      args: { operation: 'export_markdown', captureId: 'capture' },
      effect: { kind: 'mutation', scope: 'workspace', evidence: 'observation' },
    },
    {
      ...meta(),
      type: 'tool/result',
      callId: 'export',
      isError: false,
      value: {
        kind: 'browser-markdown-export',
        path: bundle + '/content.md',
        bundlePath: bundle,
        captureId: 'capture',
        converter: 'turndown',
        converterVersion: 'test',
        inputHash: 'b'.repeat(64),
        warnings: false,
        coverage: 'unverified',
      },
    },
  );
  const copy = (destination: string): void => {
    events.push(
      {
        ...meta(),
        type: 'tool/call',
        callId: destination,
        name: 'bash',
        args: { command: 'not used as authority' },
        effect: { kind: 'mutation', scope: 'workspace', resourcePaths: [destination] },
      },
      {
        ...meta(),
        type: 'tool/result',
        callId: destination,
        value: { exitCode: 0 },
        isError: false,
      },
    );
  };
  copy('friendly.md');
  expect(taskEvidence(events, promptId).map((item) => item.callId)).toEqual(['export']);
  copy(bundle + '/content.md');
  expect(taskEvidence(events, promptId)).toEqual([]);
  expect(evidenceRejectionDetails(events, promptId, 'export', 'export')).toMatchObject({
    reason: 'later_effect',
    invalidatingSeq: 8,
  });
});

it('names the actual torn effect call as invalidator and bounds status diagnostics', () => {
  const { events, promptId } = fixture();
  call(events, 'read', read);
  events.push({
    ...meta(),
    type: 'tool/call',
    callId: 'torn-effect',
    name: 'bash',
    args: { command: 'private' },
    effect: { kind: 'unknown', scope: 'workspace' },
  });
  const detail = evidenceRejectionDetails(events, promptId, 'file', 'read');
  expect(detail).toMatchObject({
    reason: 'unknown_effect',
    invalidatingSeq: 5,
    repair: 'inspect_effect_before_retry',
  });
  for (let i = 0; i < 50; i++)
    call(events, 'rejected-' + i, { kind: 'read', scope: 'browser', evidence: 'observation' });
  const status = taskStatusSchema.parse(taskState(events, promptId));
  expect(status.rejections).toHaveLength(1);
  expect(JSON.stringify(status.rejections)).not.toContain('PRIVATE');
});
