import {
  browserCdpEndpointSchema,
  skillDirectoriesEnvSchema,
  turnStepBudgetSchema,
  type ModelPricing,
} from '@trinity-harness/contracts';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import {
  browserDeploymentEnvShape,
  guestDeploymentEnvShape,
  validateGuestDeployment,
  validateBrowserDeployment,
  loadModelPricingConfig,
} from '@trinity-harness/core';
import { DEFAULT_SYSTEM_PROMPT, loadEnv } from '@trinity-harness/shared';

const workerEnvSchema = z.object({
  ...guestDeploymentEnvShape,
  SCHEDULING_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Workspace the sandbox is rooted at for coding sessions. */
  WORKSPACE_ROOT: z.string().min(1).default(process.cwd()),
  /** Model in "provider/model-id" form (see AiSdkGateway routing). */
  MODEL: z
    .string()
    .min(1)
    .regex(
      /^[^/]+\/[^/]+$/,
      'MODEL must be in "provider/model-id" form, e.g. "anthropic/claude-sonnet-4-20250514"',
    )
    .default('anthropic/claude-sonnet-4-20250514'),
  ...browserDeploymentEnvShape,
  BROWSER_CDP_ENDPOINT: browserCdpEndpointSchema.optional(),
  BROWSER_CDP_OWNER_ID: z.uuid().optional(),
  ADMIN_EMAIL: z.email().default('admin@trinity.local'),
  SKILL_DIRS: skillDirectoriesEnvSchema,
  MAX_TURN_STEPS: turnStepBudgetSchema,
  MODEL_CONTEXT_TOKENS: z.coerce.number().int().min(4096).default(200_000),
  MODEL_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8192),
  COMPACTION_CONTEXT_TOKENS: z.coerce.number().int().min(4096).optional(),
  TASK_MAX_REQUESTS: z.coerce.number().int().min(4).max(4096).optional(),
  TASK_MAX_TOKENS: z.coerce.number().int().min(32768).optional(),
  TASK_MAX_DURATION_MS: z.coerce.number().int().positive().max(86_400_000).optional(),
  TASK_MAX_COST: z
    .string()
    .regex(/^[A-Z]{3}:\d+(\.\d{1,14})?$/)
    .optional(),
  SYSTEM_PROMPT: z.string().min(1).default(DEFAULT_SYSTEM_PROMPT),
  REASONING_BUDGET_TOKENS: z.coerce.number().int().positive().optional(),
  REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /** M4: context manager budget (docs/design.md §5.1 Context Manager). */
  CONTEXT_MAX_TOKENS: z.coerce.number().int().positive().default(160_000),
  CONTEXT_KEEP_TOKENS: z.coerce.number().int().positive().default(40_000),
  /** M4: summarizer model (defaults to MODEL when unset). */
  COMPACTION_MODEL: z.string().min(1).optional(),
  /** M4: tool-result spill threshold in bytes (docs/design.md §7). */
  SPILL_THRESHOLD_BYTES: z.coerce.number().int().positive().default(50_000),
  /** M4: language-server integration (docs/design.md §9). */
  LSP_ENABLED: z.coerce.boolean().default(true),
  LSP_MAX_SERVERS: z.coerce.number().int().positive().default(4),
  /**
   * M5 sandbox hardening (docs/design.md §12.3): 'minimal' (default) scrubs
   * secrets from the env of spawned shells/processes; 'inherit' is a local-
   * convenience legacy mode only.
   */
  SANDBOX_ENV_MODE: z.enum(['minimal', 'inherit']).default('minimal'),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema> & { modelPricing: ModelPricing };

export function loadWorkerEnv(): WorkerEnv & { DATABASE_URL: string; REDIS_URL: string } {
  for (const candidate of [
    path.resolve(process.cwd(), '../../.env'),
    path.resolve(process.cwd(), '.env'),
  ]) {
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate, quiet: true });
    }
  }
  const base = loadEnv(process.env, { requireDatabaseUrl: true });
  if (!process.env['REDIS_URL']) {
    throw new Error('Invalid worker environment: REDIS_URL is required');
  }
  const result = workerEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(
      `Invalid worker environment: ${result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  validateBrowserDeployment(result.data);
  validateGuestDeployment(result.data, !!process.env['DATABASE_URL']);
  return {
    ...result.data,
    modelPricing: loadModelPricingConfig(new URL('../../../config/models.yaml', import.meta.url)),
    DATABASE_URL: base.DATABASE_URL,
    REDIS_URL: process.env['REDIS_URL'],
  };
}
