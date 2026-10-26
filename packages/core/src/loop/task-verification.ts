import { effectScopeSchema } from '@trinity-harness/contracts';
import type {
  SessionEvent,
  TaskEvidence,
  TaskStatus,
  ToolCall,
  ToolEffect,
} from '@trinity-harness/contracts';

const readTools = new Set([
  'read_file',
  'glob',
  'read_blob',
  'skill',
  'research',
  'task',
  'recall',
  'lsp_diagnostics',
  'lsp_hover',
  'lsp_definition',
  'lsp_references',
  'lsp_symbols',
]);
const browserReads = new Set([
  'read_page',
  'get_page_text',
  'read_observation',
  'search_observation',
  'screenshot',
]);

export function verificationToolAllowed(
  events: readonly SessionEvent[],
  promptId: string,
  call: ToolCall,
): boolean {
  if (readTools.has(call.name)) return true;
  const args = call.args as { command?: unknown; operation?: unknown } | null;
  if (call.name === 'browser') return browserReads.has(String(args?.operation));
  const plan = events.findLast(
    (event) => event.type === 'task/plan' && event.promptId === promptId,
  );
  return (
    call.name === 'bash' &&
    plan?.type === 'task/plan' &&
    plan.checks.some((check) => check.kind === 'command' && check.command === args?.command)
  );
}

/** Eligible receipts, derived from the same boundaries used by verification. */
function legacyTaskEvidence(events: readonly SessionEvent[], promptId: string): TaskEvidence[] {
  const plan = events.findLast(
    (event) => event.type === 'task/plan' && event.promptId === promptId,
  );
  if (plan?.type !== 'task/plan') return [];
  const promptIndex = events.findIndex((event) => event.eventId === promptId);
  if (promptIndex < 0) return [];
  const planIndex = events.findIndex((event) => event.eventId === plan.eventId);
  let lastEffect = promptIndex;
  events.forEach((event, index) => {
    if (
      index > promptIndex &&
      (event.type === 'browser/user_input' || event.type === 'browser/control_changed')
    )
      lastEffect = Math.max(lastEffect, index);
    if (index <= promptIndex || event.type !== 'tool/call' || readTools.has(event.name)) return;
    const args = event.args as { command?: unknown; operation?: unknown } | null;
    if (
      event.name === 'bash' &&
      plan.checks.some((check) => check.kind === 'command' && check.command === args?.command)
    )
      return;
    if (event.name === 'browser' && browserReads.has(String(args?.operation))) return;
    const resultIndex = events.findIndex(
      (item, resultIndex) =>
        resultIndex > index && item.type === 'tool/result' && item.callId === event.callId,
    );
    lastEffect = Math.max(lastEffect, resultIndex < 0 ? index : resultIndex);
  });
  const boundary = Math.max(lastEffect, planIndex);
  const calls = new Map<string, Extract<SessionEvent, { type: 'tool/call' }>>();
  const evidence: TaskEvidence[] = [];
  events.forEach((event, index) => {
    if (index <= boundary) return;
    if (event.type === 'tool/call') calls.set(event.callId, event);
    if (event.type !== 'tool/result' || event.isError) return;
    const call = calls.get(event.callId);
    if (!call) return;
    const args = call.args as { command?: unknown; operation?: unknown } | null;
    const value = event.value as { exitCode?: unknown } | null;
    if (
      call.name === 'bash' &&
      typeof args?.command === 'string' &&
      value?.exitCode === 0 &&
      plan.checks.some((check) => check.kind === 'command' && check.command === args.command)
    ) {
      evidence.push({
        callId: call.callId,
        toolName: call.name,
        resultSeq: index + 1,
        kind: 'command',
        command: args.command,
      });
    } else if (
      (readTools.has(call.name) && !['task', 'skill'].includes(call.name)) ||
      (call.name === 'browser' && browserReads.has(String(args?.operation)))
    ) {
      evidence.push({
        callId: call.callId,
        toolName: call.name,
        resultSeq: index + 1,
        kind: 'observation',
      });
    }
  });
  return evidence;
}

/** Metadata is supplied by adapters. Missing metadata retains conservative legacy handling. */
export function recordedEffect(
  call: Extract<SessionEvent, { type: 'tool/call' }>,
  result?: Extract<SessionEvent, { type: 'tool/result' }>,
): ToolEffect {
  if (result?.effect) return result.effect;
  if (call.effect) return call.effect;
  if (readTools.has(call.name) || call.name === 'recall') {
    const control = ['task', 'skill'].includes(call.name);
    return {
      kind: 'read',
      scope: control
        ? 'control'
        : call.name === 'read_blob' || call.name === 'recall'
          ? 'reference'
          : 'workspace',
      evidence: control ? 'none' : 'observation',
    };
  }
  const operation = (call.args as { operation?: unknown } | null)?.operation;
  if (call.name === 'browser' && browserReads.has(String(operation)))
    return {
      kind: 'read',
      scope: ['read_observation', 'search_observation'].includes(String(operation))
        ? 'reference'
        : 'browser',
      evidence: ['read_observation', 'search_observation'].includes(String(operation))
        ? 'immutable-observation'
        : 'observation',
    };
  return { kind: 'unknown', scope: 'unknown' };
}

export function hasTaskEffects(events: readonly SessionEvent[], promptId: string): boolean {
  const start = events.findIndex(
    (event) => event.type === 'message/user' && event.eventId === promptId,
  );
  if (start < 0) return false;
  const next = events.findIndex((event, i) => i > start && event.type === 'message/user');
  const turn = events.slice(start + 1, next < 0 ? undefined : next);
  return turn.some((event) => {
    if (event.type !== 'tool/call') return false;
    const result = turn.find((item) => item.type === 'tool/result' && item.callId === event.callId);
    const effect = recordedEffect(event, result?.type === 'tool/result' ? result : undefined);
    return effect.kind === 'unknown' || effect.kind === 'mutation';
  });
}

function revisionBoundary(
  events: readonly SessionEvent[],
  promptId: string,
  checkId: string,
): number {
  let boundary = events.findIndex((event) => event.eventId === promptId);
  let previous: Extract<SessionEvent, { type: 'task/plan' }> | undefined;
  events.forEach((event, i) => {
    if (event.type !== 'task/plan' || event.promptId !== promptId) return;
    const check = event.checks.find((item) => item.id === checkId);
    if (
      previous &&
      check &&
      (JSON.stringify(previous.checks.find((item) => item.id === checkId)) !==
        JSON.stringify(check) ||
        previous.interpretation !== event.interpretation ||
        JSON.stringify(previous.assumptions) !== JSON.stringify(event.assumptions) ||
        JSON.stringify(previous.intent && { ...previous.intent, actionPurpose: undefined }) !==
          JSON.stringify(event.intent && { ...event.intent, actionPurpose: undefined }))
    )
      boundary = i;
    previous = event;
  });
  return boundary;
}

export function taskEvidence(events: readonly SessionEvent[], promptId: string): TaskEvidence[] {
  const plan = events.findLast(
    (event) => event.type === 'task/plan' && event.promptId === promptId,
  );
  if (plan?.type !== 'task/plan' || plan.evidenceVersion !== 2)
    return legacyTaskEvidence(events, promptId);
  const start = events.findIndex(
    (event) => event.type === 'message/user' && event.eventId === promptId,
  );
  if (start < 0) return [];
  const next = events.findIndex((event, i) => i > start && event.type === 'message/user');
  const limit = next < 0 ? events.length : next;
  const calls = events.flatMap((event, i) =>
    event.type === 'tool/call' && i > start && i < limit ? [{ call: event, index: i }] : [],
  );
  const pairs = calls.map(({ call, index }) => {
    const resultIndex = events.findIndex(
      (event, i) =>
        i > index && i < limit && event.type === 'tool/result' && event.callId === call.callId,
    );
    const result = events[resultIndex];
    return {
      call,
      index,
      resultIndex,
      result: result?.type === 'tool/result' ? result : undefined,
      effect: recordedEffect(call, result?.type === 'tool/result' ? result : undefined),
    };
  });
  const evidence: TaskEvidence[] = [];
  const revisions = new Map(
    plan.checks.map((check) => [check.id, revisionBoundary(events, promptId, check.id)]),
  );
  const effects = new Map<ToolEffect['scope'], { end: number; callId: string }[]>();
  events.forEach((event, index) => {
    if (
      index > start &&
      index < limit &&
      (event.type === 'browser/user_input' || event.type === 'browser/control_changed')
    )
      effects.set(
        'browser',
        [...(effects.get('browser') ?? []), { end: index, callId: event.eventId }]
          .sort((a, b) => b.end - a.end)
          .slice(0, 2),
      );
  });
  const commands = new Set(
    plan.checks.flatMap((check) =>
      check.kind === 'command' && check.command ? [check.command] : [],
    ),
  );
  for (const pair of pairs) {
    if (pair.effect.kind === 'read') continue;
    if (
      pair.call.name === 'bash' &&
      commands.has(String((pair.call.args as { command?: unknown } | null)?.command))
    )
      continue;
    const end = pair.resultIndex < 0 ? limit : pair.resultIndex;
    for (const scope of effectScopeSchema.options) {
      if (
        pair.effect.kind !== 'unknown' &&
        pair.effect.scope !== 'unknown' &&
        pair.effect.scope !== scope &&
        scope !== 'unknown'
      )
        continue;
      effects.set(
        scope,
        [...(effects.get(scope) ?? []), { end, callId: pair.call.callId }]
          .sort((a, b) => b.end - a.end)
          .slice(0, 2),
      );
    }
  }
  for (const pair of pairs) {
    if (!pair.result || pair.result.isError) continue;
    const args = pair.call.args as { command?: unknown } | null;
    const value = pair.result.value as { exitCode?: unknown } | null;
    const command =
      pair.call.name === 'bash' && typeof args?.command === 'string' && value?.exitCode === 0
        ? args.command
        : undefined;
    const observation =
      pair.effect.evidence === 'observation' || pair.effect.evidence === 'immutable-observation';
    if (!command && !observation) continue;
    const checkIds = plan.checks
      .filter((check) => {
        if (
          command
            ? check.kind !== 'command' || check.command !== command
            : check.kind !== 'observation'
        )
          return false;
        if (pair.index <= revisions.get(check.id)!) return false;
        const scope =
          check.dependency ??
          (command
            ? 'workspace'
            : pair.effect.evidence === 'immutable-observation'
              ? 'reference'
              : pair.effect.scope);
        if (
          check.dependency &&
          pair.effect.scope !== check.dependency &&
          !(pair.effect.evidence === 'immutable-observation' && check.dependency === 'reference')
        )
          return false;
        const immutable = pair.effect.evidence === 'immutable-observation' && scope === 'reference';
        if (immutable) return true;
        const latestEffect = effects
          .get(scope)
          ?.find((effect) => effect.callId !== pair.call.callId);
        return !latestEffect || latestEffect.end < pair.index;
      })
      .map((check) => check.id);
    if (checkIds.length)
      evidence.push({
        callId: pair.call.callId,
        toolName: pair.call.name,
        resultSeq: pair.resultIndex + 1,
        kind: command ? 'command' : 'observation',
        ...(command ? { command } : {}),
        checkIds,
      });
  }
  return evidence;
}

export function evidenceRejection(
  events: readonly SessionEvent[],
  promptId: string,
  checkId: string,
  callId: string,
): string {
  const prompt = events.findIndex((event) => event.eventId === promptId);
  const call = events.findIndex((event) => event.type === 'tool/call' && event.callId === callId);
  const result = events.find(
    (event, i) => i > call && event.type === 'tool/result' && event.callId === callId,
  );
  if (call <= prompt) return 'Evidence does not belong to the active request.';
  if (result?.type !== 'tool/result' || result.isError)
    return 'The tool result is missing or failed.';
  const plan = events.findLast(
    (event) => event.type === 'task/plan' && event.promptId === promptId,
  );
  const check =
    plan?.type === 'task/plan' ? plan.checks.find((item) => item.id === checkId) : undefined;
  const selectedCall = events[call];
  if (
    check?.kind === 'command' &&
    selectedCall?.type === 'tool/call' &&
    (selectedCall.name !== 'bash' ||
      (selectedCall.args as { command?: unknown } | null)?.command !== check.command)
  )
    return 'The executed command does not exactly match this check. Run the command in commandRepairs unchanged, then verify its eligible resultSeq. Extra formatting, redirections, filters or diagnostics change the command; a successful different command cannot verify this check.';
  if (call <= revisionBoundary(events, promptId, checkId))
    return 'The check or its interpretation changed after this observation; collect evidence for the current revision.';
  return 'Evidence does not match the check method/dependency, or a later relevant or unknown effect invalidated it. Inspect current eligible evidence and verify the affected state.';
}

export function taskVerification(
  events: readonly SessionEvent[],
  promptId: string,
): { status: 'verified' | 'unverified' | 'incomplete'; pending: string[] } {
  const plan = events.findLast(
    (event) => event.type === 'task/plan' && event.promptId === promptId,
  );
  if (plan?.type !== 'task/plan')
    return {
      status: 'unverified',
      pending: ['Declare the requirements and verification checks using task plan.'],
    };
  const evidence = taskEvidence(events, promptId);
  const pending = plan.checks
    .filter(
      (check) =>
        !events.some((event) => {
          return (
            event.type === 'task/check' &&
            event.promptId === promptId &&
            event.id === check.id &&
            evidence.some(
              (receipt) =>
                receipt.callId === event.callId &&
                receipt.resultSeq === event.resultSeq &&
                receipt.kind === check.kind &&
                (!receipt.checkIds || receipt.checkIds.includes(check.id)) &&
                (check.kind !== 'command' || receipt.command === check.command),
            )
          );
        }),
    )
    .map((check) => `${check.id}: ${check.requirement}`);
  return { status: pending.length ? 'incomplete' : 'verified', pending };
}

/** Model-visible receipts are bounded; validation still searches all eligible evidence. */
export function taskState(events: readonly SessionEvent[], promptId: string): TaskStatus {
  const evidence = taskEvidence(events, promptId);
  const assessment = taskVerification(events, promptId);
  const plan = events.findLast(
    (event) => event.type === 'task/plan' && event.promptId === promptId,
  );
  const start = events.findIndex((event) => event.eventId === promptId);
  const next = events.findIndex((event, index) => index > start && event.type === 'message/user');
  const turn = start < 0 ? [] : events.slice(start + 1, next < 0 ? undefined : next);
  const successfulCalls = new Set(
    turn.flatMap((event) =>
      event.type === 'tool/result' &&
      !event.isError &&
      (event.value as { exitCode?: unknown } | null)?.exitCode === 0
        ? [event.callId]
        : [],
    ),
  );
  const successfulCommands = new Set(
    turn.flatMap((event) =>
      event.type === 'tool/call' && event.name === 'bash' && successfulCalls.has(event.callId)
        ? [(event.args as { command?: unknown } | null)?.command]
        : [],
    ),
  );
  const commandRepairs: NonNullable<TaskStatus['commandRepairs']> = [];
  if (plan?.type === 'task/plan')
    for (const check of plan.checks) {
      if (
        check.kind !== 'command' ||
        !check.command ||
        !assessment.pending.includes(`${check.id}: ${check.requirement}`)
      )
        continue;
      const receipt = evidence.findLast(
        (item) =>
          item.kind === 'command' &&
          item.command === check.command &&
          (!item.checkIds || item.checkIds.includes(check.id)),
      );
      commandRepairs.push({
        checkId: check.id,
        command: check.command,
        reason: receipt
          ? 'verification_required'
          : successfulCommands.has(check.command)
            ? 'fresh_evidence_required'
            : 'exact_command_required',
        ...(receipt ? { resultSeq: receipt.resultSeq } : {}),
      });
    }
  return {
    ...assessment,
    evidence: evidence.slice(-32),
    evidenceTruncated: evidence.length > 32,
    ...(commandRepairs.length ? { commandRepairs } : {}),
  };
}
