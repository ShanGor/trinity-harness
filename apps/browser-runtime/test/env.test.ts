import { expect, it } from 'vitest';
import { browserRuntimeEnvSchema } from '../src/env.js';

const minimal = {
  DATABASE_URL: 'postgresql://unused/unused',
  WORKSPACE_ROOT: '/workspace',
  BROWSER_PROFILE_DIR: '/browser-data',
  BROWSER_RUNTIME_TOKEN: 's'.repeat(32),
};
it('requires storage/credentials and defaults to a bounded loopback-only supervisor', () => {
  expect(browserRuntimeEnvSchema.parse(minimal)).toMatchObject({
    BROWSER_RUNTIME_HOST: '127.0.0.1',
    BROWSER_RUNTIME_PORT: 3010,
    BROWSER_RUNTIME_MAX_SESSIONS: 4,
    BROWSER_RUNTIME_IDLE_MS: 300000,
    ZENDRIVER_CHROME_VERSION: '155.0.8059.84',
  });
  expect(browserRuntimeEnvSchema.safeParse({}).success).toBe(false);
  for (const extra of [
    { BROWSER_RUNTIME_TOKEN: 'short' },
    { BROWSER_PROFILE_DIR: 'relative/browser-data' },
    { BROWSER_RUNTIME_HOST: '0.0.0.0' },
    { BROWSER_RUNTIME_MAX_SESSIONS: 0 },
    { BROWSER_RUNTIME_IDLE_MS: 0 },
    { ZENDRIVER_CHROME_VERSION: 'latest' },
    { SANDBOX_PROXY_URL: 'socks5://127.0.0.1:1080' },
    { SANDBOX_PROXY_URL: 'not a url' },
  ])
    expect(browserRuntimeEnvSchema.safeParse({ ...minimal, ...extra }).success).toBe(false);
});

it('accepts an explicit operator-configured proxy for managed Chrome', () => {
  const parsed = browserRuntimeEnvSchema.parse({
    ...minimal,
    SANDBOX_PROXY_URL: 'http://127.0.0.1:7890',
  });
  expect(parsed.SANDBOX_PROXY_URL).toBe('http://127.0.0.1:7890');
  expect(parsed.BROWSER_NO_PROXY).toContain('localhost');
  expect(
    browserRuntimeEnvSchema.safeParse({
      ...minimal,
      SANDBOX_PROXY_URL: 'http://user:password@proxy:7890',
    }).success,
  ).toBe(true);
});

it('requires local profiles only for local execution, leaving guest profile storage inside the VM', () => {
  const base = {
    DATABASE_URL: minimal.DATABASE_URL,
    WORKSPACE_ROOT: minimal.WORKSPACE_ROOT,
    BROWSER_RUNTIME_TOKEN: minimal.BROWSER_RUNTIME_TOKEN,
  };
  expect(browserRuntimeEnvSchema.safeParse(base).success).toBe(false);
  expect(
    browserRuntimeEnvSchema.safeParse({ ...base, EXECUTION_DRIVER: 'firecracker' }).success,
  ).toBe(true);
  expect(
    browserRuntimeEnvSchema.safeParse({
      ...base,
      EXECUTION_DRIVER: 'firecracker',
      SANDBOX_PROXY_URL: 'http://127.0.0.1:7890',
    }).success,
  ).toBe(true);
  expect(
    browserRuntimeEnvSchema.safeParse({
      ...base,
      EXECUTION_DRIVER: 'firecracker',
      SANDBOX_PROXY_URL: 'http://user:password@192.0.2.20:7890',
    }).success,
  ).toBe(true);
  expect(
    browserRuntimeEnvSchema.safeParse({
      ...base,
      EXECUTION_DRIVER: 'firecracker',
      SANDBOX_PROXY_URL: 'http://192.0.2.20:7890',
    }).success,
  ).toBe(true);
});
