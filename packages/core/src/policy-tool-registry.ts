import type {
  PermissionDecision,
  PermissionPolicy,
  ToolCall,
  ToolContextInput,
  ToolRegistry,
  ToolResult,
  ToolSchema,
  ToolEffect,
  ToolAssessment,
} from '@trinity-harness/contracts';

import { matchesCommandPrefix } from './tools/command-prefix.js';

import { classifyBashCommand } from './tools/bash-classifier.js';
import { bashReferencesSensitiveFile, isSensitiveFilePath } from './tools/sensitive-files.js';
import { browserActionOperations } from '@trinity-harness/contracts';

/**
 * Policy-gating decorator over a {@link ToolRegistry} (docs/design.md §12.1,
 * §6.3 interception points). Decides per tool call:
 *
 * - `allowed` → delegate to the inner registry (unchanged M2 behavior);
 * - `denied`  → synthesize an isError result, the inner registry never runs;
 * - `ask`     → return an `ask` verdict; the CALLER (Agent Loop) owns the
 *   human-in-the-loop round trip — a registry must never block on I/O.
 *
 * Adapter-owned preflight adds consequence checks to the static policy.
 * Unknown targets remain unavailable; sensitive-file reads require approval.
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
    return this.inner
      .schemas()
      .filter((tool) => (this.policy?.tools[tool.name] ?? this.policy?.tools['*']) !== 'denied');
  }

  concurrencyOf(name: string): 'parallel' | 'exclusive' {
    return this.inner.concurrencyOf(name);
  }

  effectOf(call: ToolCall): ToolEffect {
    return this.inner.effectOf?.(call) ?? { kind: 'unknown', scope: 'unknown' };
  }

  /** Policy decision for one call; 'ask' means the loop must gate it. */
  decide(call: ToolCall): PermissionDecision {
    const policy = this.policy;
    const rawCommand = (call.args as { command?: unknown } | null)?.command;
    const command = typeof rawCommand === 'string' ? rawCommand : undefined;
    if (call.name === 'browser') {
      const operation = (call.args as { operation?: unknown } | null)?.operation;
      if (
        typeof operation === 'string' &&
        browserActionOperations.some((value) => value === operation)
      ) {
        if (policy?.tools['browser'] === 'denied' || policy?.tools['*'] === 'denied')
          return 'denied';
        return policy?.tools[`browser.${operation}`] ?? policy?.tools['*'] ?? 'allowed';
      }
    }
    const configuredDecision = policy?.tools[call.name] ?? policy?.tools['*'];
    if (configuredDecision === 'denied') return 'denied';
    const readPath = (call.args as { path?: unknown } | null)?.path;
    if (
      (call.name === 'read_file' &&
        typeof readPath === 'string' &&
        isSensitiveFilePath(readPath)) ||
      (call.name === 'bash' && bashReferencesSensitiveFile(command))
    )
      return 'ask';
    if (!policy) return 'allowed';
    const decision = configuredDecision ?? (call.name === 'bash' ? 'ask' : 'allowed');
    if (decision !== 'ask') return decision;
    if (call.name === 'bash' && matchesCommandPrefix(command, policy.commandPrefixes ?? []))
      return 'allowed';
    if (
      call.name === 'bash' &&
      policy.allowWorkspaceInternalBash &&
      classifyBashCommand(command) === 'workspace-internal'
    ) {
      return 'allowed';
    }
    return 'ask';
  }

  async assess(call: ToolCall, ctx: ToolContextInput): Promise<ToolAssessment> {
    const decision = this.decide(call);
    if (decision === 'denied')
      return { decision: 'unavailable', summary: 'The session policy denies this action.' };
    const assessment = (await this.inner.assess?.(call, ctx)) ?? {
      decision: 'allowed' as const,
      summary: '',
    };
    if (assessment.decision !== 'allowed') return assessment;
    if (
      assessment.authorized &&
      this.policy?.tools[call.name] === undefined &&
      this.policy?.tools['*'] === undefined &&
      call.name === 'bash' &&
      !bashReferencesSensitiveFile((call.args as { command?: string }).command)
    )
      return assessment;
    return { decision, summary: assessment.summary };
  }

  async execute(call: ToolCall, ctx: ToolContextInput): Promise<ToolResult> {
    let decision = this.decide(call);
    if (decision === 'denied') {
      return {
        value: { message: `tool '${call.name}' is denied by the session permission policy` },
        isError: true,
      };
    }
    if (!ctx.permissionGranted) {
      const assessment = await this.assess(call, ctx);
      if (assessment.decision === 'unavailable')
        return { isError: true, value: { message: assessment.summary } };
      decision = assessment.decision;
      if (decision === 'ask')
        return {
          isError: true,
          value: {
            message: `tool '${call.name}' requires agent approval before execution`,
            consequence: assessment.summary,
          },
        };
    }
    return this.inner.execute(call, ctx);
  }
}
