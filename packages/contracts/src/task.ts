import { z } from 'zod';
import type { LLMRequest } from './llm.js';
import type { ModelUsage } from './usage.js';

export const taskBudgetSchema = z.object({
  /** An omitted ceiling is unlimited; persisted ceilings remain effective on replay. */
  maxSteps: z.number().int().positive().max(1024).optional(),
  maxRequests: z.number().int().positive().max(4096).optional(),
  maxTokens: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().max(86_400_000).optional(),
  /** Per-currency ceilings; prices still come only from config/models.yaml. */
  maxCost: z
    .array(
      z.object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        amount: z.string().regex(/^\d+(\.\d{1,14})?$/),
      }),
    )
    .max(16)
    .default([]),
  /** Reserved for verification and the final answer; children cannot spend it. */
  reserveRequests: z.number().int().nonnegative().default(3),
  reserveTokens: z.number().int().nonnegative().default(16_384),
});
export type TaskBudget = z.infer<typeof taskBudgetSchema>;

export const taskCheckSchema = z.object({
  id: z.string().min(1).max(80),
  requirement: z.string().min(1).max(1000),
  kind: z.enum(['command', 'observation']),
  /** Exact command for command checks. Never executed by this tool. */
  command: z.string().min(1).max(4000).optional(),
});
export const taskPlanSchema = z
  .object({
    operation: z.literal('plan'),
    checks: z.array(taskCheckSchema).min(1).max(32),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.checks.map((check) => check.id)).size !== value.checks.length)
      ctx.addIssue({ code: 'custom', message: 'Check IDs must be unique' });
    if (value.checks.some((check) => check.kind === 'command' && !check.command))
      ctx.addIssue({ code: 'custom', message: 'Command checks require an exact command' });
  });
export const taskToolInputSchema = z.discriminatedUnion('operation', [
  taskPlanSchema,
  z.object({
    operation: z.literal('verify'),
    id: z.string().min(1).max(80),
    callId: z.string().min(1).max(200),
  }),
  z.object({ operation: z.literal('status') }),
]);

export const taskEventSchemas = [
  z.object({ type: z.literal('task/budget'), promptId: z.uuid(), limits: taskBudgetSchema }),
  z.object({
    type: z.literal('task/request'),
    promptId: z.uuid(),
    requestId: z.uuid(),
    model: z.string(),
    purpose: z.enum(['assistant', 'compaction', 'subagent']),
    estimatedInputTokens: z.number().int().nonnegative(),
    reservedTokens: z.number().int().nonnegative(),
    reservedCost: z.array(z.object({ currency: z.string(), amount: z.string() })),
    lane: z.enum(['work', 'verification', 'final']),
  }),
  z.object({ type: z.literal('task/request_denied'), promptId: z.uuid(), requestId: z.uuid() }),
  z.object({ type: z.literal('task/step'), promptId: z.uuid() }),
  z.object({
    type: z.literal('task/recovery'),
    promptId: z.uuid(),
    kind: z.enum(['retry', 'overflow', 'length', 'interrupted', 'verification']),
    advice: z.string().min(1).max(2000),
  }),
  z.object({
    type: z.literal('task/plan'),
    promptId: z.uuid(),
    checks: z.array(taskCheckSchema).min(1).max(32),
  }),
  z.object({
    type: z.literal('task/check'),
    promptId: z.uuid(),
    id: z.string(),
    callId: z.string(),
    resultSeq: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('task/assessment'),
    promptId: z.uuid(),
    status: z.enum(['verified', 'unverified', 'incomplete']),
    pending: z.array(z.string()).max(32),
  }),
] as const;

/** Shared by parent and children. Implementations persist admission before spending. */
export interface TaskBudgetScope {
  readonly signal: AbortSignal;
  readonly maxSteps: number | undefined;
  shouldConclude(request: LLMRequest): Promise<boolean>;
  shouldFinalize(request: LLMRequest): Promise<boolean>;
  admit(
    request: LLMRequest,
    purpose: ModelUsage['purpose'],
    lane: 'work' | 'verification' | 'final',
  ): Promise<string>;
  record(usage: ModelUsage): Promise<void>;
  dispose(): void;
}
export interface TaskExecutionPort {
  open(
    sessionId: string,
    promptId: string,
    signal?: AbortSignal,
    actor?: string,
  ): Promise<TaskBudgetScope>;
}
