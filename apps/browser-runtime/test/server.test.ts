import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { BrowserRuntimeRequest } from '@trinity-harness/contracts';
import { browserRuntimeFailure } from '@trinity-harness/core';
import { buildBrowserRuntimeServer } from '../src/server.js';

it('authenticates every request and validates bounded typed operations before dispatch', async () => {
  const execute = vi.fn(async (request: BrowserRuntimeRequest) =>
    browserRuntimeFailure(request, 'NOT_EXECUTED'),
  );
  const token = 't'.repeat(32);
  const app = buildBrowserRuntimeServer({ execute }, token);
  try {
    const payload = {
      sessionId: randomUUID(),
      callId: 'call',
      args: { operation: 'navigate', url: 'https://example.com/' },
      permissionGranted: false,
    };
    expect((await app.inject({ method: 'POST', url: '/execute', payload })).statusCode).toBe(401);
    expect(execute).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/execute',
          headers: { authorization: `Bearer ${token}` },
          payload: { ...payload, args: { operation: 'evaluate', script: 'unsafe()' } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/execute',
          headers: { authorization: `Bearer ${token}` },
          payload,
        })
      ).json(),
    ).toMatchObject({ isError: true, value: { code: 'NOT_EXECUTED' } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/execute',
          headers: { authorization: `Bearer ${token}` },
          payload: { ...payload, junk: 'x'.repeat(30_000) },
        })
      ).statusCode,
    ).toBe(413);
  } finally {
    await app.close();
  }
});
