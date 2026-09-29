import type {
  PermissionDecision,
  PermissionPolicy,
  ToolCall,
  ToolContextInput,
  ToolRegistry,
  ToolResult,
  ToolSchema,
} from '@trinity-harness/contracts';

import { classifyBashCommand } from './tools/bash-classifier.js';

/**
 * Policy-gating decorator over a {@link ToolRegistry} (docs/design.md §12.1,
 * §6.3 interception points). Decides per tool call:
 *
 * - `allowed` → delegate to the inner registry (unchanged M2 behavior);
 * - `denied`  → synthesize an isError result, the inner registry never runs;
 * - `ask`     → return an `ask` verdict; the CALLER (Agent Loop) owns the
 *   human-in-the-loop round trip — a registry must never block on I/O.
 *
 * No policy (undefined) ⇒ transparent pass-through, preserving the M1/M2
 * behavior for tests and inline mode.
 */
export class PolicyToolRegistry implements ToolRegistry {
  constructor(
    private readonly inner: ToolRegistry,
    private readonly policy: PermissionPolicy | undefined,
  ) {}

  register(def: Parameters<ToolRegistry['register']>[0]): Disposable {
    return this.inner.register(def);
  }

  schemas(): ToolSchema[] {
    return this.inner.schemas();
  }

  concurrencyOf(name: string): 'parallel' | 'exclusive' {
    return this.inner.concurrencyOf(name);
  }

  /** Policy decision for one call; 'ask' means the loop must gate it. */
  decide(call: ToolCall): PermissionDecision {
    const policy = this.policy;
    if (!policy) return 'allowed';
    const decision =
      policy.tools[call.name] ?? policy.tools['*'] ?? (call.name === 'bash' ? 'ask' : 'allowed');
    if (decision !== 'ask') return decision;
    if (
      call.name === 'bash' &&
      policy.allowWorkspaceInternalBash &&
      classifyBashCommand(
        (call.args as { command?: unknown } | null)?.['command'] as string | undefined,
      ) === 'workspace-internal'
    ) {
      return 'allowed';
    }
    return 'ask';
  }

  async execute(call: ToolCall, ctx: ToolContextInput): Promise<ToolResult> {
    if (this.decide(call) === 'denied') {
      return {
        value: { message: `tool '${call.name}' is denied by the session permission policy` },
        isError: true,
      };
    }
    return this.inner.execute(call, ctx);
  }
}
