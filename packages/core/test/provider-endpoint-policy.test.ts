import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request } from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { lookup } from 'node:dns/promises';
import { ProviderEndpointPolicy } from '../src/llm/endpoint-policy.js';

vi.mock('node:https', () => ({ request: vi.fn() }));
afterEach(() => {
  vi.clearAllMocks();
});
function response(status: number): void {
  vi.mocked(request).mockImplementation(((
    url: URL,
    options: RequestOptions,
    callback: (message: IncomingMessage) => void,
  ) => {
    expect(url.hostname).toBe('provider.example');
    expect(options.family).toBe(4);
    const done = vi.fn();
    options.lookup!('provider.example', {}, done);
    expect(done).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    const output = new EventEmitter();
    return Object.assign(output, {
      end: () => {
        const input = Object.assign(new PassThrough(), {
          statusCode: status,
          headers: { 'content-type': 'text/plain' },
        });
        callback(input as unknown as IncomingMessage);
        input.end('OK');
      },
    }) as unknown as ClientRequest;
  }) as typeof request);
}

describe('constrained SDK provider transport', () => {
  it('pins the validated connect address while retaining the original TLS hostname', async () => {
    response(200);
    const lookupAddress = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
    const policy = new ProviderEndpointPolicy(
      [{ origin: 'https://provider.example' }],
      lookupAddress as unknown as typeof lookup,
    );
    expect(
      await (
        await policy.fetch('https://provider.example/v1/messages', { method: 'POST', body: '{}' })
      ).text(),
    ).toBe('OK');
    expect(lookupAddress).toHaveBeenCalledTimes(1);
  });
  it('revalidates DNS at dispatch and refuses mixed/private answers after an earlier successful check', async () => {
    const lookupAddress = vi
      .fn()
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValue([
        { address: '8.8.8.8', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]);
    const policy = new ProviderEndpointPolicy(
      [{ origin: 'https://provider.example' }],
      lookupAddress as unknown as typeof lookup,
    );
    await policy.validate('https://provider.example/v1');
    await expect(policy.fetch('https://provider.example/v1/messages')).rejects.toMatchObject({
      code: 'INVALID',
    });
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects redirects without following them or forwarding credentials', async () => {
    response(302);
    const policy = new ProviderEndpointPolicy(
      [{ origin: 'https://provider.example' }],
      vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) as unknown as typeof lookup,
    );
    await expect(
      policy.fetch('https://provider.example/v1/messages', {
        headers: { authorization: 'Bearer private-key' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

it('permits safe configuration publication while provider DNS is down and redacts the failure at dispatch', async () => {
  const lookupAddress = vi.fn(async () => {
    throw new Error('private upstream hostname details');
  });
  const policy = new ProviderEndpointPolicy(
    [{ origin: 'https://provider.example' }],
    lookupAddress as unknown as typeof lookup,
  );
  expect(() => policy.validateConfiguration('https://provider.example/v1')).not.toThrow();
  expect(lookupAddress).not.toHaveBeenCalled();
  await expect(policy.validate('https://provider.example/v1')).rejects.toMatchObject({
    code: 'UNAVAILABLE',
    message: 'Provider address unavailable',
    isRetryable: true,
  });
});
