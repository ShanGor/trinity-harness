import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { BrowserRuntimeRequest } from '@trinity-harness/contracts';
import { browserRuntimeFailure } from '@trinity-harness/core';
import { buildBrowserRuntimeServer } from '../src/server.js';

it('keeps managed previews private and validates both request and response without executing tools', async () => {
  const execute = vi.fn();
  const preview = vi.fn(async () => ({ state: 'unavailable' as const }));
  const token = 'p'.repeat(32);
  const app = buildBrowserRuntimeServer({ execute, preview }, token);
  const payload = { sessionId: randomUUID() };
  const headers = { authorization: `Bearer ${token}` };
  try {
    expect((await app.inject({ method: 'POST', url: '/preview', payload })).statusCode).toBe(401);
    expect(preview).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/preview',
          headers,
          payload: { ...payload, url: 'https://example.com/' },
        })
      ).statusCode,
    ).toBe(400);
    const response = await app.inject({ method: 'POST', url: '/preview', headers, payload });
    expect(response.json()).toEqual({ state: 'unavailable' });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(preview).toHaveBeenCalledWith(payload.sessionId, expect.any(AbortSignal));
    preview.mockResolvedValueOnce({ state: 'unavailable', secret: 'must not leave runtime' } as {
      state: 'unavailable';
    });
    const invalid = await app.inject({ method: 'POST', url: '/preview', headers, payload });
    expect(invalid.statusCode).toBe(500);
    expect(invalid.body).not.toContain('secret');
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

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
