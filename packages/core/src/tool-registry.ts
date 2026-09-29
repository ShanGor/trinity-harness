import type {
  Disposable,
  SandboxPort,
  ToolCall,
  ToolContextInput,
  ToolDefinition,
  ToolRegistry,
  ToolResult,
  ToolSchema,
} from '@trinity-harness/contracts';
import { z } from 'zod';

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

  async execute(call: ToolCall, ctx: ToolContextInput): Promise<ToolResult> {
    const def = this.tools.get(call.name);
    if (!def) {
      return { value: { message: `unknown tool: ${call.name}` }, isError: true };
    }
    const parsed = def.parameters.safeParse(call.args);
    if (!parsed.success) {
      return {
        value: {
          message: `invalid arguments for ${call.name}`,
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        isError: true,
      };
    }
    const signals = [
      AbortSignal.timeout(def.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      ...(ctx.signal ? [ctx.signal] : []),
    ];
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals as AbortSignal[]);
    try {
      return await def.execute(parsed.data, { ...ctx, sandbox: this.sandbox, signal });
    } catch (err) {
      return {
        value: {
          message: err instanceof Error ? err.message : String(err),
        },
        isError: true,
      };
    }
  }
}
