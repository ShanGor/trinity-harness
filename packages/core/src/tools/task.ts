import type { SessionStore, ToolDefinition, ToolResult } from '@trinity-harness/contracts';
import { taskToolInputSchema } from '@trinity-harness/contracts';
import { newId } from '@trinity-harness/shared';
import {
  taskState,
  taskVerification,
  evidenceRejection,
  hasTaskEffects,
} from '../loop/task-verification.js';
import { defineTool } from './define-tool.js';

export function createTaskTool(store: SessionStore): ToolDefinition {
  return defineTool({
    name: 'task',
    effect: { kind: 'read', scope: 'control', evidence: 'none' },
    concurrency: 'exclusive',
    description:
      'Track a revisable working plan and verify checks using current-task tool evidence. In verification-enabled runs, record a minimal plan before mutations or unknown-effect calls, even for small edits, tied to the requested outcome and constraints. Routine reads and direct answers need no checklist. Optional intent records source user event IDs, deliverables, constraints and action purpose; these remain your interpretation. Optional interpretation and assumptions distinguish your understanding from the original request. To replace mistaken checks, interpretation or assumptions, submit the full updated checks and a revisionReason explaining the correction and how user requirements remain covered. Omitted interpretation/assumptions retain their previous values; use assumptions: [] to clear assumptions. Changed checks or interpretations require fresh evidence; unchanged checks retain valid evidence. An initial plan may bind earlier successful reads from this request. Mark a check purpose method only when it is a chosen method rather than a requested outcome; retire such checks with a revisionReason when irrelevant, preserving user obligations. Optional assess records your outcome judgment and unresolved requirements; it does not verify semantic success. Command checks require the exact shell command string, including formatting, redirections and filters. Run the planned command unchanged; extra diagnostics belong in separate calls. Observation checks require a successful read. Set dependency workspace or browser for checks about current state; immutable source evidence proves only the recorded observation. After execution, verify each check using the exact resultSeq from the working-plan evidence list or task status (preferred), or its exact recorded callId. Never guess provider IDs; both selectors, if supplied, must identify the same result. Later effects invalidate checks. This tool never executes commands or changes user requirements or permissions. Status reports pending checks, recent eligible evidence IDs and commandRepairs. For exact_command_required, run the supplied command unchanged through bash; exit code 0 from a different command is not matching evidence. For fresh_evidence_required, collect a fresh exact-command result under the current plan. For verification_required, call task verify with checkId as id and the supplied resultSeq. Before rerunning commands, inspect prior effects and apply normal permissions; never repeat mutations merely to repair bookkeeping. Repairing the plan or assessing fulfilled does not verify checks. Never guess a resultSeq or use 0. Verified checks do not prove relevance, semantic correctness or task completeness.',
    parameters: taskToolInputSchema,
    execute: async (args, ctx): Promise<ToolResult> => {
      const events = await store.load(ctx.sessionId);
      const prompt = events.findLast((event) => event.type === 'message/user');
      if (!prompt) return { isError: true, value: { message: 'No active task' } };
      const promptId = prompt.eventId;
      const meta = { eventId: newId(), at: new Date().toISOString(), promptId };
      if (args.operation === 'candidate') {
        const candidate = events.findLast(
          (event) => event.type === 'response/candidate' && event.promptId === promptId,
        );
        if (candidate?.type !== 'response/candidate')
          return { isError: true, value: { message: 'No rejected candidate for this request.' } };
        return {
          isError: false,
          value: {
            eventId: candidate.eventId,
            text: candidate.text.slice(args.offset, args.offset + 4000),
            from: Math.min(args.offset, candidate.text.length),
            to: Math.min(args.offset + 4000, candidate.text.length),
            totalCharacters: candidate.text.length,
          },
        };
      }
      if (args.operation === 'plan') {
        const previous = events.findLast(
          (event) => event.type === 'task/plan' && event.promptId === promptId,
        );
        const prior = previous?.type === 'task/plan' ? previous : undefined;
        const start = events.findLast(
          (event) => event.type === 'turn/start' && event.promptId === promptId,
        );
        const evidenceVersion = prior
          ? prior.evidenceVersion
          : start?.type === 'turn/start' && start.executionVersion !== 2
            ? undefined
            : 2;
        const interpretation = args.interpretation ?? prior?.interpretation;
        const assumptions = args.assumptions ?? prior?.assumptions;
        const intent = args.intent ?? prior?.intent;
        if (
          intent &&
          (intent.sourceEventIds.some(
            (id) => !events.some((event) => event.type === 'message/user' && event.eventId === id),
          ) ||
            !intent.sourceEventIds.includes(promptId))
        )
          return {
            isError: true,
            value: {
              message:
                'Intent must reference the current committed user message; additional references must be original user messages from this session.',
            },
          };
        if (
          !args.checks.length &&
          (!prior ||
            !args.revisionReason ||
            prior.checks.some((check) => check.purpose !== 'method') ||
            hasTaskEffects(events, promptId))
        )
          return {
            isError: true,
            value: {
              message:
                'Only an existing method-only checklist can be retired with a reason, and outstanding effects still require verification. Preserve user outcome requirements.',
            },
          };
        const next = {
          checks: args.checks,
          ...(intent !== undefined ? { intent } : {}),
          ...(interpretation !== undefined ? { interpretation } : {}),
          ...(assumptions !== undefined ? { assumptions } : {}),
        };
        if (
          prior &&
          (prior.checks.some(
            (check) =>
              !args.checks.some((candidate) => JSON.stringify(candidate) === JSON.stringify(check)),
          ) ||
            (prior.interpretation !== undefined && prior.interpretation !== interpretation) ||
            (prior.assumptions !== undefined &&
              JSON.stringify(prior.assumptions) !== JSON.stringify(assumptions)) ||
            (prior.intent !== undefined &&
              JSON.stringify(prior.intent) !== JSON.stringify(intent))) &&
          !args.revisionReason
        )
          return {
            isError: true,
            value: {
              message:
                'Replacing existing checks, interpretation or assumptions requires revisionReason. Explain the correction and how the original user objective and constraints remain covered; submit the complete revised checks. A revision does not change user requirements or permissions.',
            },
          };
        // Repeated identical plans must not invalidate existing evidence.
        if (
          !prior ||
          JSON.stringify({
            checks: prior.checks,
            interpretation: prior.interpretation,
            assumptions: prior.assumptions,
            ...(prior.intent !== undefined ? { intent: prior.intent } : {}),
          }) !== JSON.stringify(next)
        )
          await store.append(ctx.sessionId, [
            {
              ...meta,
              type: 'task/plan',
              ...(evidenceVersion === 2 ? { evidenceVersion: 2 as const } : {}),
              ...next,
              ...(args.revisionReason !== undefined ? { revisionReason: args.revisionReason } : {}),
            },
          ]);
      } else if (args.operation === 'verify') {
        const resultIndex =
          args.resultSeq !== undefined
            ? args.resultSeq - 1
            : events.findLastIndex(
                (event) => event.type === 'tool/result' && event.callId === args.callId,
              );
        const selected = events[resultIndex];
        if (
          selected?.type !== 'tool/result' ||
          (args.callId !== undefined && selected.callId !== args.callId) ||
          resultIndex < events.findIndex((event) => event.eventId === promptId)
        )
          return {
            isError: true,
            value: {
              message:
                'Select an exact resultSeq (preferred) or callId from this task’s eligible evidence list; both selectors must agree.',
              ...taskState(events, promptId),
            },
          };
        const callId = selected.callId;
        const candidate = {
          ...meta,
          type: 'task/check' as const,
          id: args.id,
          callId,
          resultSeq: resultIndex + 1,
        };
        const plan = events.findLast(
          (event) => event.type === 'task/plan' && event.promptId === promptId,
        );
        const check =
          plan?.type === 'task/plan' ? plan.checks.find((item) => item.id === args.id) : undefined;
        if (
          !check ||
          taskVerification([...events, candidate], promptId).pending.some((item) =>
            item.startsWith(`${args.id}:`),
          )
        )
          return {
            isError: true,
            value: {
              message: evidenceRejection(events, promptId, args.id, callId),
              ...taskState(events, promptId),
            },
          };
        await store.append(ctx.sessionId, [
          { ...candidate, ...(plan ? { planId: plan.eventId } : {}) },
        ]);
      } else if (args.operation === 'assess') {
        const plan = events.findLast(
          (event) => event.type === 'task/plan' && event.promptId === promptId,
        );
        await store.append(ctx.sessionId, [
          {
            ...meta,
            type: 'task/outcome',
            outcome: args.outcome,
            unresolved: args.unresolved,
            ...(plan ? { planId: plan.eventId } : {}),
          },
        ]);
      }
      return { isError: false, value: taskState(await store.load(ctx.sessionId), promptId) };
    },
  });
}
