import {
  skillArgumentsSchema,
  type SkillRuntimePort,
  type ToolDefinition,
} from '@trinity-harness/contracts';

import { defineTool } from '../tools/define-tool.js';

/** Instruction loading shares normal tool validation, permissions and event recording. */
export function createSkillTool(runtime: SkillRuntimePort): ToolDefinition {
  return defineTool({
    name: 'skill',
    effect: { kind: 'read', scope: 'control', evidence: 'none' },
    description:
      'Load instructions for an available runtime skill before acting on a matching task. Use the exact catalog name. Optionally read a relative text resource from that skill. This does not execute scripts or grant permissions.',
    parameters: skillArgumentsSchema,
    concurrency: 'exclusive',
    execute: async (args, ctx) => ({
      value: await runtime.load({
        ...args,
        sessionId: ctx.sessionId,
        workspaceRoot: ctx.workspaceRoot,
        signal: ctx.signal,
      }),
      isError: false,
    }),
  });
}
