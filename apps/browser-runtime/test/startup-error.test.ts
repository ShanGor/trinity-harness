import { expect, it } from 'vitest';
import { z } from 'zod';
import { formatStartupError } from '../src/startup-error.js';

it('explains a port conflict without printing raw error details', () => {
  const error = Object.assign(new Error('private connection details'), { code: 'EADDRINUSE' });
  const message = formatStartupError(error, 'listen');
  expect(message).toContain('EADDRINUSE');
  expect(message).toContain('BROWSER_RUNTIME_PORT is already in use');
  expect(message).toContain('BROWSER_RUNTIME_ENDPOINT');
  expect(message).not.toContain(error.message);
});

it('reports invalid environment fields without values or custom issue messages', () => {
  const result = z
    .object({ BROWSER_RUNTIME_TOKEN: z.string().min(32), DATABASE_URL: z.never() })
    .safeParse({ BROWSER_RUNTIME_TOKEN: 'secret', DATABASE_URL: 'postgres://user:secret@host/db' });
  expect(result.success).toBe(false);
  if (result.success) return;
  const message = formatStartupError(result.error, 'configuration');
  expect(message).toContain('BROWSER_RUNTIME_TOKEN, DATABASE_URL');
  expect(message).not.toContain('secret');
  expect(message).not.toContain('postgres://');
});

it('gives safe phase guidance for arbitrary failures and untrusted error codes', () => {
  for (const error of [
    new Error('postgres://user:secret@host/db'),
    Object.assign(new Error('private'), { code: 'secret' }),
    'secret',
    null,
  ]) {
    const message = formatStartupError(error, 'database');
    expect(message).toContain('PostgreSQL availability');
    expect(message).not.toContain('secret');
  }
});

it.each(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ENOENT', 'EACCES', '28P01'])(
  'provides safe guidance for %s',
  (code) => {
    const message = formatStartupError(Object.assign(new Error('secret'), { code }), 'database');
    expect(message).toContain(code === '28P01' ? 'authentication failed' : code);
    expect(message).not.toContain('secret');
  },
);
