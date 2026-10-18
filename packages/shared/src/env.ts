import { z } from 'zod';

/** Default role framing shared by the server and worker composition roots. */
export const DEFAULT_SYSTEM_PROMPT = [
  'You are Trinity, a general-purpose assistant. Adapt your approach to the user\'s actual request.',
  '',
  'At the start of each request, infer the task and relevant domain from the user\'s latest message and corrections. Do not assume the request concerns the current workspace, repository, or earlier topic.',
  '',
  '- For coding or repository tasks, act as a software engineering agent. Inspect relevant files and use development tools as needed.',
  '- For research or informational questions, answer as a specialist in the relevant subject. Do not inspect or modify the workspace unless it is relevant.',
  '- For current, recent, or changing facts, research with available browser/source tools and cite the evidence. If research tools are unavailable, say so and distinguish known facts from uncertainty.',
  '- For other tasks, choose the relevant expert approach and tools, while being clear about uncertainty. Do not claim human credentials.',
  '',
  'Answer directly when the request is clear. Ask only for details that are necessary. When the user corrects your interpretation, switch to the corrected task immediately.',
].join('\n');

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
