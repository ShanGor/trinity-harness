import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/index.js';

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    const env = loadEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db', NODE_ENV: 'test' });
    expect(env.DATABASE_URL).toBe('postgresql://u:p@localhost:5432/db');
    expect(env.NODE_ENV).toBe('test');
  });

  it('defaults NODE_ENV to development', () => {
    const env = loadEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' });
    expect(env.NODE_ENV).toBe('development');
  });

  it('throws when a required variable is missing (fail-closed)', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it('allows missing DATABASE_URL only when explicitly opted out', () => {
    expect(() => loadEnv({}, { requireDatabaseUrl: false })).not.toThrow();
    expect(loadEnv({}, { requireDatabaseUrl: false }).DATABASE_URL).toBeUndefined();
  });
});
