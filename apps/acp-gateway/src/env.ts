import { existsSync } from 'node:fs';
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const gatewayEnvSchema = z.object({
  /** Base URL of the trinity-harness server (the internal ACP HTTP binding). */
  ACP_SERVER_URL: z.url().default('http://127.0.0.1:3000'),
  /** Bearer token for the server (login via /api/auth/login, M2 auth). */
  ACP_TOKEN: z.string().min(1).optional(),
});

export type GatewayEnv = z.infer<typeof gatewayEnvSchema>;

export function loadGatewayEnv(source: NodeJS.ProcessEnv = process.env): GatewayEnv {
  // Load .env from the repo root first, then the app dir (local overrides).
  for (const candidate of [
    path.resolve(process.cwd(), '../../.env'),
    path.resolve(process.cwd(), '.env'),
  ]) {
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate, quiet: true });
    }
  }
  const result = gatewayEnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(
      `Invalid gateway environment: ${result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}
