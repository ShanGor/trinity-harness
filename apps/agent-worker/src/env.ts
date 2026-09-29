import { existsSync } from 'node:fs';
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import { loadEnv } from '@trinity-harness/shared';

const workerEnvSchema = z.object({
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
  SYSTEM_PROMPT: z.string().min(1).default('You are Trinity, a software engineering agent.'),
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

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

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
  return { ...result.data, DATABASE_URL: base.DATABASE_URL, REDIS_URL: process.env['REDIS_URL'] };
}
