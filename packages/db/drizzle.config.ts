import { existsSync } from 'node:fs';
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Load .env from the repo root first, then the package dir (local overrides).
for (const candidate of [
  path.resolve(process.cwd(), '../../.env'),
  path.resolve(process.cwd(), '.env'),
]) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate, quiet: true });
  }
}

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  // Fail-closed: never silently target an unknown database.
  throw new Error('DATABASE_URL is required (copy .env.example to .env or export it)');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
