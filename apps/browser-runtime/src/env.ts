import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

export const browserRuntimeEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  WORKSPACE_ROOT: z.string().min(1),
  BROWSER_PROFILE_DIR: z.string().min(1).refine(path.isAbsolute, 'must be an absolute path'),
  BROWSER_RUNTIME_TOKEN: z.string().min(32).max(200),
  BROWSER_RUNTIME_HOST: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
  BROWSER_RUNTIME_PORT: z.coerce.number().int().min(1).max(65535).default(3010),
  BROWSER_RUNTIME_MAX_SESSIONS: z.coerce.number().int().min(1).max(32).default(4),
  BROWSER_RUNTIME_IDLE_MS: z.coerce.number().int().min(1000).max(3_600_000).default(300_000),
  BROWSER_CDP_OWNER_ID: z.uuid().optional(),
  ADMIN_EMAIL: z.email().default('admin@trinity.local'),
  ZENDRIVER_BINARY: z.string().min(1).default('zendriver-mcp'),
  ZENDRIVER_CHROME_VERSION: z
    .string()
    .regex(/^\d+\.\d+\.\d+\.\d+$/)
    .default('155.0.8059.84'),
});
export type BrowserRuntimeEnv = z.infer<typeof browserRuntimeEnvSchema>;
export function loadBrowserRuntimeEnv(): BrowserRuntimeEnv {
  for (const candidate of [
    path.resolve(process.cwd(), '../../.env'),
    path.resolve(process.cwd(), '.env'),
  ]) {
    if (existsSync(candidate)) loadDotenv({ path: candidate, quiet: true });
  }
  return browserRuntimeEnvSchema.parse(process.env);
}
