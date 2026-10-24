import type {
  Disposable,
  SandboxPort,
  ToolCall,
  ToolContextInput,
  ToolDefinition,
  ToolRegistry,
  ToolResult,
  ToolSchema,
  ToolEffect,
} from '@trinity-harness/contracts';
import { z } from 'zod';
import { browserErrorSchema, toolEffectSchema } from '@trinity-harness/contracts';

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Default in-process ToolRegistry: zod-validated dispatch, sandbox injection,
 * timeout enforcement and error convergence (failures become isError results,
 * never unhandled throws — AGENTS.md §4.1).
 */
export class CoreToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(private readonly sandbox: SandboxPort) {}

  register(def: ToolDefinition): Disposable {
    this.tools.set(def.name, def);
    const handle: Disposable = {
      dispose: () => {
        if (this.tools.get(def.name) === def) {
          this.tools.delete(def.name);
        }
      },
      [Symbol.dispose]() {
        this.dispose();
      },
    };
    return handle;
  }

  schemas(): ToolSchema[] {
    return [...this.tools.values()].map((def) => ({
      name: def.name,
      description: def.description,
      parameters: z.toJSONSchema(def.parameters) as Record<string, unknown>,
    }));
  }

  concurrencyOf(name: string): 'parallel' | 'exclusive' {
    return this.tools.get(name)?.concurrency ?? 'parallel';
  }

  effectOf(call: ToolCall): ToolEffect {
    const def = this.tools.get(call.name);
    const args = def?.parameters.safeParse(call.args);
    if (!def || !args?.success) return { kind: 'read', scope: 'control', evidence: 'none' };
    if (!def.effect && !def.effectFor) return { kind: 'unknown', scope: 'unknown' };
    const classified = def.effectFor ? def.effectFor(args.data) : def.effect;
    const parsed = toolEffectSchema.safeParse(classified);
    return parsed.success ? parsed.data : { kind: 'unknown', scope: 'unknown' };
  }

  async execute(call: ToolCall, ctx: ToolContextInput): Promise<ToolResult> {
    const def = this.tools.get(call.name);
    if (!def) {
      return { value: { message: `unknown tool: ${call.name}` }, isError: true };
    }
    const parsed = def.parameters.safeParse(call.args);
    if (!parsed.success) {
      if (call.name === 'browser')
        return {
          isError: true,
          value: browserErrorSchema.parse({
            kind: 'browser-error-v1',
            code: 'INVALID_ARGUMENTS',
            operation: 'browser',
            effect: 'none',
            message: 'Invalid or disabled browser operation arguments.',
          }),
        };
      return {
        value: {
          message: `invalid arguments for ${call.name}`,
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        isError: true,
      };
    }
    const signal =
      def.timeoutMs === null
        ? ctx.signal
        : AbortSignal.any([
            AbortSignal.timeout(def.timeoutMs ?? DEFAULT_TIMEOUT_MS),
            ...(ctx.signal ? [ctx.signal] : []),
          ]);
    try {
      return await def.execute(parsed.data, {
        ...ctx,
        callId: call.id,
        sandbox: this.sandbox.withSignal?.(signal) ?? this.sandbox,
        signal,
      });
    } catch (err) {
      if (call.name === 'browser')
        return {
          isError: true,
          value: browserErrorSchema.parse({
            kind: 'browser-error-v1',
            code: signal?.aborted ? 'CANCELLED' : 'DRIVER_FAILED',
            operation: 'browser',
            effect: 'unknown',
            message: 'Browser execution failed. Reobserve before retrying effects.',
          }),
        };
      return {
        value: {
          message: err instanceof Error ? err.message : String(err),
        },
        isError: true,
      };
    }
  }
}
