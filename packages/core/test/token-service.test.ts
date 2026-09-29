import { describe, expect, it } from 'vitest';

import { HmacTokenService } from '../src/index.js';

const identity = { userId: 'u1', tenantId: 't1', role: 'developer' as const };

describe('HmacTokenService (M2)', () => {
  it('round-trips an identity', async () => {
    const tokens = new HmacTokenService('a'.repeat(32));
    const token = await tokens.issue(identity);
    expect(await tokens.verify(token)).toEqual(identity);
  });

  it('rejects tampered payloads, wrong secrets and malformed tokens (fail-closed)', async () => {
    const tokens = new HmacTokenService('a'.repeat(32));
    const other = new HmacTokenService('b'.repeat(32));
    const token = await tokens.issue(identity);

    expect(await other.verify(token)).toBeNull();

    const [body, exp, sig] = token.split('.') as [string, string, string];
    const tamperedBody = Buffer.from(
      JSON.stringify({ ...identity, role: 'admin' }),
      'utf8',
    ).toString('base64url');
    expect(await tokens.verify(`${tamperedBody}.${exp}.${sig}`)).toBeNull();
    expect(await tokens.verify('not-a-token')).toBeNull();
    expect(await tokens.verify(`${body}.${exp}`)).toBeNull();
  });

  it('expires tokens after ttlMs (injected clock — deterministic)', async () => {
    let now = 1_000_000;
    const tokens = new HmacTokenService('a'.repeat(32), 1000, () => now);
    const token = await tokens.issue(identity);
    expect(await tokens.verify(token)).toEqual(identity);
    now += 1001;
    expect(await tokens.verify(token)).toBeNull();
  });

  it('refuses a weak secret at construction (fail-closed)', () => {
    expect(() => new HmacTokenService('short')).toThrow();
  });
});
