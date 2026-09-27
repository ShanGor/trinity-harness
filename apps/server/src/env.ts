import { existsSync } from 'node:fs';
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import { loadEnv } from '@trinity-harness/shared';

const serverEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  /** Workspace the sandbox is rooted at for coding sessions. */
  WORKSPACE_ROOT: z.string().min(1).default(process.cwd()),
  /** Model in "provider/model-id" form (see AiSdkGateway routing). */
  MODEL: z.string().min(1).default('anthropic/claude-sonnet-4-20250514'),
  SYSTEM_PROMPT: z.string().min(1).default('You are Trinity, a software engineering agent.'),
  /** Anthropic extended thinking budget (tokens). */
  REASONING_BUDGET_TOKENS: z.coerce.number().int().positive().optional(),
  /** OpenAI reasoning effort. */
  REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

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
  // M1 uses the in-memory session store, so DATABASE_URL stays optional.
  loadEnv(process.env, { requireDatabaseUrl: false });
  const result = serverEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(
      `Invalid server environment: ${result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}
