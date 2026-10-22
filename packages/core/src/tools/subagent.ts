import type {
  AgentLoop,
  PermissionPolicy,
  ToolDefinition,
  LoopEvent,
  ModelUsage,
} from '@trinity-harness/contracts';
import { parsePermissionPolicy } from '@trinity-harness/contracts';
import { newId } from '@trinity-harness/shared';
import { z } from 'zod';

import { defineTool } from './define-tool.js';
import type { CoreAgentLoop } from '../loop/agent-loop.js';

/**
 * Subagent tool (docs/design.md §8): dispatches a CHILD agent with an
 * INDEPENDENT context (fresh in-memory session log, optional step limit) and
 * returns its final message — the parent context only pays for the result.
 *
 * `createLoop` is injected by the composition root (the child's tool set is
 * typically the parent's minus `subagent` itself to avoid unbounded
 * recursion; the child runs ungated-by-default with an explicit policy).
 */
export interface SubagentToolOptions {
  createLoop: (scope: { parentSessionId: string; childSessionId: string }) => CoreAgentLoop;
  description?: string | undefined;
  /** Composition-root capability, independent of the parent's browser configuration. */
  browserAccess?: 'live' | 'saved-only';
  /** Fallback child policy for callers without an authenticated parent snapshot (default: workspace-write). */
  policy?: PermissionPolicy | undefined;
}

export function createSubagentTool(opts: SubagentToolOptions): ToolDefinition {
  const policy = opts.policy ?? parsePermissionPolicy('workspace-write');
  return defineTool({
    name: 'subagent',
    description:
      (opts.description ??
        'Dispatch a sub-agent with an independent context to research or execute a self-contained task. ' +
          'Returns the sub-agent final report. Use for exploration, parallelizable analysis, or ' +
          'well-scoped subtasks. Specify the unresolved question and how the result will inform the parent task; resolve task-defining ambiguity before delegating a candidate survey. The original current user request is supplied separately when available; keep parent interpretations distinguishable from user constraints.') +
      (opts.browserAccess === 'saved-only'
        ? ' This child has no live browser access and starts without parent observations. Do not delegate live web research to it.'
        : opts.browserAccess === 'live'
          ? ' This child has its own trusted browser tab, subject to the authenticated parent owner and ordinary permissions. Its observations stay in its independent context; inspect original sources in the parent before citing them as parent evidence.'
          : ''),
    parameters: z.object({
      task: z.string().min(1).max(20_000).describe('Self-contained task for the sub-agent'),
      /**
       * Optional additional system guidance for the sub-agent (output
       * format, focus areas). Kept short — it is not the task itself.
       */
      context: z.string().max(5_000).optional(),
    }),
    // The inherited task owns the deadline; delegation is a loop, not one I/O call.
    timeoutMs: null,
    execute: async (args, ctx): Promise<{ value: unknown; isError: boolean }> => {
      const childId = newId();
      // The child's Loop is created per call by the factory; the child store
      // lives inside it (fresh context = nothing replays into the parent).
      const loop: AgentLoop = opts.createLoop({
        parentSessionId: ctx.sessionId,
        childSessionId: childId,
      });
      let finalText = '';
      const reporting = new AbortController();
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, reporting.signal])
        : reporting.signal;
      let progress = Promise.resolve();
      let progressError: unknown;
      let requests = 0;
      let toolResults = 0;
      let compactions = 0;
      let guidance: string | undefined;
      const report = (status: string): void => {
        if (!ctx.reportProgress) return;
        const message = `Subagent ${childId.slice(-8)}: ${status}; ${requests} model requests, ${toolResults} tool results, ${compactions} context compactions.${guidance ? ` Strategy: ${guidance}` : ''}`;
        progress = progress
          .then(async () => {
            if (!reporting.signal.aborted) await ctx.reportProgress!(message);
          })
          .catch((error: unknown) => {
            progressError ??= error;
            reporting.abort(error);
          });
      };
      const usage: ModelUsage[] = [];
      const sink = {
        emit: (event: LoopEvent): void => {
          if (event.type === 'model/usage') {
            usage.push(event.usage);
            requests += 1;
            report('running');
          }
          if (event.type === 'tool/result') {
            toolResults += 1;
            report('running');
          }
          if (event.type === 'context/compacted') {
            compactions += 1;
            report('running');
          }
          if (event.type === 'turn/guidance') {
            guidance = event.advice;
            report('strategy guidance updated');
          }
          if (event.type === 'turn/end') report(event.reason);
          if (event.type === 'message/assistant' && event.phase !== 'progress') {
            finalText = event.content; // last assistant message wins
          }
        },
      };
      // Keep the durable user wording separate from model-authored delegation.
      const childPrompt = [
        'Execute the delegated subtask below. The original user request supplies purpose and constraints, not an instruction to perform the entire parent task. Parent guidance and the delegated task are working interpretations and may be mistaken. If they conflict with the original request or depend on an unresolved consequential assumption, report that conflict or investigate the focused uncertainty before expanding the work. Return supported findings and remaining gaps; do not pad the report with unrelated candidates. Check the advertised tool operations before research. If live browsing is unavailable and no relevant saved observations were supplied, return that limitation immediately instead of guessing observation IDs, retrying unavailable operations or surveying candidates from memory.',
        JSON.stringify({
          ...(ctx.userRequest !== undefined ? { originalUserRequest: ctx.userRequest } : {}),
          delegatedTask: args.task,
          ...(args.context !== undefined ? { parentGuidance: args.context } : {}),
        }),
      ].join('\n\n');
      let outcome: Awaited<ReturnType<AgentLoop['run']>>;
      try {
        report('started');
        await progress;
        signal.throwIfAborted();
        outcome = await loop.run(childId, childPrompt, sink, {
          signal,
          actor: `subagent:${ctx.sessionId}`,
          tenantId: ctx.tenantId,
          policy: ctx.permissionPolicy ?? policy,
          taskBudget: ctx.taskBudget,
          contextGuard: ctx.contextGuard,
        });
      } finally {
        await progress;
        try {
          for (const entry of usage) await ctx.recordUsage?.(entry);
        } finally {
          reporting.abort();
        }
      }
      if (progressError !== undefined) throw progressError;
      if (outcome.reason !== 'completed') {
        return {
          value: {
            message: `sub-agent did not complete (${outcome.reason})`,
            steps: outcome.steps,
            partial: finalText.slice(0, 2_000),
          },
          isError: true,
        };
      }
      return {
        value: { report: finalText, steps: outcome.steps, childSessionId: childId },
        isError: false,
      };
    },
  });
}
