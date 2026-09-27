import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1).optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

export interface LoadEnvOptions {
  /**
   * Fail-closed (AGENTS.md §4/§5): when true (default), a missing
   * DATABASE_URL throws. Apps that do not touch PostgreSQL (e.g. the M1
   * in-memory server) pass false and fail later at the actual DB boundary.
   */
  requireDatabaseUrl?: boolean;
}

export function loadEnv(
  source?: NodeJS.ProcessEnv,
  opts?: LoadEnvOptions & { requireDatabaseUrl?: true },
): AppEnv & { DATABASE_URL: string };
export function loadEnv(source?: NodeJS.ProcessEnv, opts?: LoadEnvOptions): AppEnv;
export function loadEnv(source: NodeJS.ProcessEnv = process.env, opts?: LoadEnvOptions): AppEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration: ${result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  if (opts?.requireDatabaseUrl !== false && !result.data.DATABASE_URL) {
    throw new Error('Invalid environment configuration: DATABASE_URL is required');
  }
  return result.data;
}
