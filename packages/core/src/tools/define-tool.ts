import type { ToolDefinition } from '@trinity-harness/contracts';

/**
 * Identity helper that lets TypeScript infer the ToolDefinition generics
 * (args/result types) from the zod schema and execute() body instead of
 * falling back to `unknown`.
 */
export function defineTool<A, V>(def: ToolDefinition<A, V>): ToolDefinition<A, V> {
  return def;
}
