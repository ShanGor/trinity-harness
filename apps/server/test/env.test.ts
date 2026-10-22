import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadServerEnv } from '../src/env.js';

vi.mock('dotenv', () => ({ config: vi.fn() }));

const budgetKeys = [
  'MAX_TURN_STEPS',
  'TASK_MAX_REQUESTS',
  'TASK_MAX_TOKENS',
  'TASK_MAX_DURATION_MS',
  'TASK_MAX_COST',
] as const;

beforeEach(() => {
  for (const key of budgetKeys) vi.stubEnv(key, undefined);
  vi.stubEnv('MODEL', 'fake/model');
});
afterEach(() => vi.unstubAllEnvs());

it('leaves every server task ceiling unlimited when unset', () => {
  const env = loadServerEnv();
  for (const key of budgetKeys) expect(env[key]).toBeUndefined();
});

it('parses independently configured server task ceilings', () => {
  vi.stubEnv('TASK_MAX_REQUESTS', '20');
  expect(loadServerEnv().TASK_MAX_REQUESTS).toBe(20);
  expect(loadServerEnv().TASK_MAX_TOKENS).toBeUndefined();
  vi.stubEnv('MAX_TURN_STEPS', '10');
  vi.stubEnv('TASK_MAX_TOKENS', '50000');
  vi.stubEnv('TASK_MAX_DURATION_MS', '1000');
  vi.stubEnv('TASK_MAX_COST', 'USD:1.50');
  expect(loadServerEnv()).toMatchObject({
    MAX_TURN_STEPS: 10,
    TASK_MAX_REQUESTS: 20,
    TASK_MAX_TOKENS: 50000,
    TASK_MAX_DURATION_MS: 1000,
    TASK_MAX_COST: 'USD:1.50',
  });
});

it.each(budgetKeys)('rejects invalid configured server ceiling %s', (key) => {
  vi.stubEnv(key, 'invalid');
  expect(() => loadServerEnv()).toThrow(key);
});

it('requires an explicit authenticated runtime for Zendriver and rejects simultaneous CDP attachment', () => {
  vi.stubEnv('BROWSER_DRIVER', 'zendriver');
  vi.stubEnv('BROWSER_CDP_ENDPOINT', undefined);
  vi.stubEnv('BROWSER_RUNTIME_ENDPOINT', undefined);
  vi.stubEnv('BROWSER_RUNTIME_TOKEN', undefined);
  expect(() => loadServerEnv()).toThrow('BROWSER_RUNTIME');
  vi.stubEnv('BROWSER_RUNTIME_ENDPOINT', 'http://127.0.0.1:3010');
  vi.stubEnv('BROWSER_RUNTIME_TOKEN', 't'.repeat(32));
  expect(loadServerEnv().BROWSER_DRIVER).toBe('zendriver');
  vi.stubEnv('BROWSER_CDP_ENDPOINT', '9222');
  expect(() => loadServerEnv()).toThrow('BROWSER_CDP_ENDPOINT');
});
