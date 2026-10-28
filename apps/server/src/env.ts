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

const serverEnvSchema = z.object({
  ...guestDeploymentEnvShape,
  SCHEDULING_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
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
  SKILL_DIRS: skillDirectoriesEnvSchema,
  MAX_TURN_STEPS: turnStepBudgetSchema,
  MODEL_CONTEXT_TOKENS: z.coerce.number().int().min(4096).default(200_000),
  MODEL_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8192),
  COMPACTION_CONTEXT_TOKENS: z.coerce.number().int().min(4096).optional(),
  TASK_MAX_TOOL_CALLS: z.coerce.number().int().positive().max(100_000).optional(),
  TASK_MAX_REQUESTS: z.coerce.number().int().min(4).max(4096).optional(),
  TASK_MAX_TOKENS: z.coerce.number().int().min(32768).optional(),
  TASK_MAX_DURATION_MS: z.coerce.number().int().positive().max(86_400_000).optional(),
  TASK_MAX_COST: z
    .string()
    .regex(/^[A-Z]{3}:\d+(\.\d{1,14})?$/)
    .optional(),
  SYSTEM_PROMPT: z.string().min(1).default(DEFAULT_SYSTEM_PROMPT),
  /** Anthropic extended thinking budget (tokens). */
  REASONING_BUDGET_TOKENS: z.coerce.number().int().positive().optional(),
  /** OpenAI reasoning effort. */
  REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /**
   * M2: present ⇒ distributed mode (BullMQ turns + Redis Stream SSE relay).
   * The agent-worker process consumes the queue (docs/design.md §18 M2).
   */
  REDIS_URL: z.string().min(1).optional(),
  /**
   * Voice I/O (docs/design.md §10): base URLs of the local STT service
   * (Fun-ASR, OpenAI-compatible /v1/audio/transcriptions) and TTS service
   * (Qwen3-TTS, /tts + /tts/stream) proxied by /api/speech/*.
   */
  SPEECH_ASR_URL: z.string().url().default('http://127.0.0.1:8000'),
  SPEECH_TTS_URL: z.string().url().default('http://127.0.0.1:8001'),
  /** M2: HMAC signing key for bearer tokens (fail-closed, AGENTS.md §5). */
  TOKEN_SECRET: z.string().min(16).optional(),
  /** Separate operator credential for host release drain/resume calls. */
  FIRECRACKER_MAINTENANCE_TOKEN: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,}$/)
    .optional(),
  /** M2: first-boot bootstrap admin (only used while the users table is empty). */
  ADMIN_EMAIL: z.string().email().default('admin@trinity.local'),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  /**
   * M3: default permission policy for new sessions (preset name or JSON
   * policy). Defaults to the 'workspace-write' preset (docs/design.md §12.1).
   */
  DEFAULT_PERMISSION_POLICY: z.string().min(1).max(4000).optional(),
  /** M4: context manager budget for inline-mode loops (§5.1). */
  CONTEXT_MAX_TOKENS: z.coerce.number().int().positive().default(160_000),
  CONTEXT_KEEP_TOKENS: z.coerce.number().int().positive().default(40_000),
  COMPACTION_MODEL: z.string().min(1).optional(),
  /** M4: tool-result spill threshold in bytes (§7). */
  SPILL_THRESHOLD_BYTES: z.coerce.number().int().positive().default(50_000),
  /** M4: language-server integration for inline-mode loops (§9). */
  LSP_ENABLED: z.coerce.boolean().default(true),
  LSP_MAX_SERVERS: z.coerce.number().int().positive().default(4),
  /**
   * M5 sandbox hardening (docs/design.md §12.3): 'minimal' (default) scrubs
   * secrets from the env of spawned shells/processes; 'inherit' is a local-
   * convenience legacy mode only.
   */
  SANDBOX_ENV_MODE: z.enum(['minimal', 'inherit']).default('minimal'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema> & { modelPricing: ModelPricing };

export function loadServerEnv(): ServerEnv {
  // Load .env from the repo root first, then the app dir (local overrides).
  for (const candidate of [
    path.resolve(process.cwd(), '../../.env'),
    path.resolve(process.cwd(), '.env'),
  ]) {
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate, quiet: true });
    }
  }
  // Without PostgreSQL the server runs the M1 in-memory inline mode, where
  // DATABASE_URL stays optional; auth/RBAC requires PG and is enabled only
  // when DATABASE_URL is present (see main.ts).
  loadEnv(process.env, { requireDatabaseUrl: false });
  const result = serverEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(
      `Invalid server environment: ${result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  validateBrowserDeployment(result.data);
  validateGuestDeployment(result.data, !!process.env['DATABASE_URL']);
  return {
    ...result.data,
    modelPricing: loadModelPricingConfig(new URL('../../../config/models.yaml', import.meta.url)),
  };
}
