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
  createLoop: () => CoreAgentLoop;
  description?: string | undefined;
  /** Child permission policy snapshot (fail-closed default: workspace-write). */
  policy?: PermissionPolicy | undefined;
}

export function createSubagentTool(opts: SubagentToolOptions): ToolDefinition {
  const policy = opts.policy ?? parsePermissionPolicy('workspace-write');
  return defineTool({
    name: 'subagent',
    description:
      opts.description ??
      'Dispatch a sub-agent with an independent context to research or execute a self-contained task. ' +
        'Returns the sub-agent final report. Use for exploration, parallelizable analysis, or ' +
        'well-scoped subtasks; keep the task description self-contained.',
    parameters: z.object({
      task: z.string().min(1).max(20_000).describe('Self-contained task for the sub-agent'),
      /**
       * Optional additional system guidance for the sub-agent (output
       * format, focus areas). Kept short — it is not the task itself.
       */
      context: z.string().max(5_000).optional(),
    }),
    timeoutMs: 600_000,
    execute: async (args, ctx): Promise<{ value: unknown; isError: boolean }> => {
      const childId = newId();
      // The child's Loop is created per call by the factory; the child store
      // lives inside it (fresh context = nothing replays into the parent).
      const loop: AgentLoop = opts.createLoop();
      let finalText = '';
      const usage: ModelUsage[] = [];
      const sink = {
        emit: (event: LoopEvent): void => {
          if (event.type === 'model/usage') usage.push(event.usage);
          if (event.type === 'message/assistant' && typeof event.content === 'string') {
            finalText = event.content; // last assistant message wins
          }
        },
      };
      // Optional guidance rides inside the child prompt — the child's own
      // system prompt is fixed at creation time.
      const childPrompt = args.context
        ? `${args.task}\n\n[parent-agent guidance]\n${args.context}`
        : args.task;
      let outcome: Awaited<ReturnType<AgentLoop['run']>>;
      try {
        outcome = await loop.run(childId, childPrompt, sink, {
          signal: ctx.signal,
          actor: `subagent:${ctx.sessionId}`,
          tenantId: ctx.tenantId,
          policy,
          taskBudget: ctx.taskBudget,
        });
      } finally {
        for (const entry of usage) await ctx.recordUsage?.(entry);
      }
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
