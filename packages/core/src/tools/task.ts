import type { SessionStore, ToolDefinition, ToolResult } from '@trinity-harness/contracts';
import { taskToolInputSchema } from '@trinity-harness/contracts';
import { newId } from '@trinity-harness/shared';
import { taskVerification } from '../loop/task-verification.js';
import { defineTool } from './define-tool.js';

export function createTaskTool(store: SessionStore): ToolDefinition {
  return defineTool({
    name: 'task',
    concurrency: 'exclusive',
    description:
      'Track requirements and verify completion using current-task tool evidence. Before substantive work, plan checks covering every requirement. Command checks require the exact test/build command. After execution, verify each check with its successful tool callId. Observation checks require a successful read. Checks become stale after later effects. This tool never executes commands; run them through normal tools and permissions. Status reports pending checks. A verified checklist proves recorded checks passed, not semantic correctness.',
    parameters: taskToolInputSchema,
    execute: async (args, ctx): Promise<ToolResult> => {
      const events = await store.load(ctx.sessionId);
      const prompt = events.findLast((event) => event.type === 'message/user');
      if (!prompt) return { isError: true, value: { message: 'No active task' } };
      const promptId = prompt.eventId;
      const meta = { eventId: newId(), at: new Date().toISOString(), promptId };
      if (args.operation === 'plan') {
        const previous = events.findLast(
          (event) => event.type === 'task/plan' && event.promptId === promptId,
        );
        if (
          previous?.type === 'task/plan' &&
          previous.checks.some(
            (check) => !args.checks.some((next) => JSON.stringify(next) === JSON.stringify(check)),
          )
        )
          return {
            isError: true,
            value: {
              message:
                'Existing requirements/checks cannot be removed or weakened; add checks or report incomplete work.',
            },
          };
        // Repeated identical plans must not invalidate existing evidence.
        if (
          previous?.type !== 'task/plan' ||
          JSON.stringify(previous.checks) !== JSON.stringify(args.checks)
        )
          await store.append(ctx.sessionId, [{ ...meta, type: 'task/plan', checks: args.checks }]);
      } else if (args.operation === 'verify') {
        const resultIndex = events.findLastIndex(
          (event) => event.type === 'tool/result' && event.callId === args.callId,
        );
        if (resultIndex < events.findIndex((event) => event.eventId === promptId))
          return { isError: true, value: { message: 'Evidence must come from this task' } };
        const candidate = {
          ...meta,
          type: 'task/check' as const,
          id: args.id,
          callId: args.callId,
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
              message:
                'Check evidence is missing, failed, stale, or does not match its declared verification method.',
            },
          };
        await store.append(ctx.sessionId, [candidate]);
      }
      return { isError: false, value: taskVerification(await store.load(ctx.sessionId), promptId) };
    },
  });
}
