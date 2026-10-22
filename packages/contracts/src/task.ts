import { z } from 'zod';
import type { LLMRequest } from './llm.js';
import type { ModelUsage } from './usage.js';
import { effectScopeSchema } from './execution-context.js';

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
  purpose: z.enum(['outcome', 'method']).optional(),
  dependency: effectScopeSchema.optional(),
  /** Exact command for command checks. Never executed by this tool. */
  command: z.string().min(1).max(4000).optional(),
});
export const taskPlanDetailsSchema = z.object({
  checks: z.array(taskCheckSchema).max(32),
  intent: z
    .object({
      outcome: z.string().trim().min(1).max(1500),
      sourceEventIds: z.array(z.uuid()).min(1).max(16),
      deliverables: z.array(z.string().min(1).max(500)).max(16),
      constraints: z.array(z.string().min(1).max(500)).max(16),
      actionPurpose: z.string().min(1).max(1000).optional(),
    })
    .optional(),
  /** Model-authored working interpretation, not a replacement for the user request. */
  interpretation: z.string().trim().min(1).max(1500).optional(),
  assumptions: z.array(z.string().trim().min(1).max(500)).max(8).optional(),
  /** Required by the tool when replacing an existing interpretation, assumption or check. */
  revisionReason: z.string().trim().min(1).max(1000).optional(),
});
export const taskPlanSchema = taskPlanDetailsSchema
  .extend({ operation: z.literal('plan') })
  .superRefine((value, ctx) => {
    if (!value.checks.length && !value.revisionReason)
      ctx.addIssue({ code: 'custom', message: 'Retiring method checks requires revisionReason' });
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
  z.object({
    operation: z.literal('candidate'),
    offset: z.number().int().nonnegative().default(0),
  }),
  z.object({
    operation: z.literal('assess'),
    outcome: z.enum(['fulfilled', 'partial', 'needs-clarification']),
    unresolved: z.array(z.string().min(1).max(1000)).max(32),
  }),
]);

export const taskEvidenceSchema = z.object({
  callId: z.string(),
  toolName: z.string(),
  resultSeq: z.number().int().positive(),
  kind: z.enum(['command', 'observation']),
  command: z.string().optional(),
  checkIds: z.array(z.string()).max(32).optional(),
});
export type TaskEvidence = z.infer<typeof taskEvidenceSchema>;
export const taskStatusSchema = z.object({
  status: z.enum(['verified', 'unverified', 'incomplete']),
  pending: z.array(z.string()).max(32),
  evidence: z.array(taskEvidenceSchema).max(32),
  evidenceTruncated: z.boolean(),
});
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** Safe retry diagnostics; never persist raw provider headers or response bodies. */
export const modelRetrySchema = z.object({
  attempt: z.number().int().positive(),
  reason: z.enum(['rate_limit', 'overloaded', 'server_error', 'transport']),
  statusCode: z.number().int().min(100).max(599).optional(),
  delayMs: z.number().int().nonnegative().max(900_000),
  retryAt: z.iso.datetime(),
  delaySource: z.enum(['backoff', 'retry-after-ms', 'retry-after', 'rate-limit-reset']),
  exhausted: z.array(z.enum(['requests', 'tokens', 'input_tokens', 'output_tokens'])).max(4),
});
export type ModelRetry = z.infer<typeof modelRetrySchema>;

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
    retry: modelRetrySchema.optional(),
  }),
  z.object({
    type: z.literal('task/plan'),
    promptId: z.uuid(),
    evidenceVersion: z.literal(2).optional(),
    ...taskPlanDetailsSchema.shape,
  }),
  z.object({
    type: z.literal('task/check'),
    promptId: z.uuid(),
    id: z.string(),
    callId: z.string(),
    resultSeq: z.number().int().positive(),
    planId: z.uuid().optional(),
  }),
  z.object({
    type: z.literal('task/outcome'),
    promptId: z.uuid(),
    planId: z.uuid().optional(),
    outcome: z.enum(['fulfilled', 'partial', 'needs-clarification']),
    unresolved: z.array(z.string().max(1000)).max(32),
  }),
  z.object({
    type: z.literal('task/completion'),
    promptId: z.uuid(),
    outcomeId: z.uuid().optional(),
    checksStatus: z.enum(['verified', 'unverified', 'incomplete']),
    executionReason: z.enum(['completed', 'max-tokens', 'blocked', 'aborted', 'error']),
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
