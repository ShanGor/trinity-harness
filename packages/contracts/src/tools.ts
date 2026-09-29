import type { z } from 'zod';

import type { SandboxPort } from './sandbox.js';
import type { ToolSchema } from './llm.js';

/**
 * Tool contracts (docs/design.md §5.2, §8): value/render separation —
 * execute() returns a normalized JSON value; rendering for the model is a
 * separate concern handled by the Loop.
 */
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResult<V = unknown> {
  value: V;
  isError: boolean;
}

export interface ToolContext {
  sessionId: string;
  workspaceRoot: string;
  signal?: AbortSignal | undefined;
  /**
   * Injected by the ToolRegistry at execute time: the sandbox is the only
   * allowed path for process/FS effects (docs/design.md §12.3).
   */
  sandbox: SandboxPort;
}

export interface ToolDefinition<A = unknown, V = unknown> {
  name: string;
  description: string;
  /** Argument validator; the registry parses/validates before execute(). */
  parameters: z.ZodType<A>;
  execute(args: A, ctx: ToolContext): Promise<ToolResult<V>>;
  concurrency?: 'parallel' | 'exclusive';
  timeoutMs?: number;
}

/**
 * What callers (the Loop) provide. The registry adds `sandbox` before
 * invoking the tool.
 */
export type ToolContextInput = Omit<ToolContext, 'sandbox'>;

export interface ToolRegistry {
  /** Registers a tool; returns a handle that unregisters on dispose. */
  register(def: ToolDefinition): Disposable;
  /** Zod-validated dispatch; bad args / unknown tools become isError results. */
  execute(call: ToolCall, ctx: ToolContextInput): Promise<ToolResult>;
  schemas(): ToolSchema[];
  /**
   * Concurrency class of a tool (design.md §6.3); 'exclusive' tools never run
   * concurrently with anything. Unknown tools are 'parallel' (they will fail
   * at execute() with an isError result anyway).
   */
  concurrencyOf(name: string): 'parallel' | 'exclusive';
}
