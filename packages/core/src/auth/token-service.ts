import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Identity, TokenService } from '@trinity-harness/contracts';
import { roleSchema } from '@trinity-harness/contracts';

/**
 * HMAC-SHA256 signed bearer tokens (design.md §12.4: secrets stay server-side;
 * the signing key never leaves the backend). Payload is a compact base64url
 * JSON blob `{u, t, r, exp}`; tokens expire after `ttlMs` (default 24h).
 *
 * No external JWT dependency: this is a closed system where both issuer and
 * verifier are our own services sharing `TOKEN_SECRET`.
 */

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class HmacTokenService implements TokenService {
  constructor(
    private readonly secret: string,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {
    if (secret.length < 16) {
      throw new Error('TOKEN_SECRET must be at least 16 characters (fail-closed, AGENTS.md §5)');
    }
  }

  async issue(identity: Identity): Promise<string> {
    const payload = { u: identity.userId, t: identity.tenantId, r: identity.role };
    const body = b64url(JSON.stringify(payload));
    const exp = this.now() + this.ttlMs;
    const sig = sign(this.secret, `${body}.${exp}`);
    return `${body}.${exp}.${sig}`;
  }

  async verify(token: string): Promise<Identity | null> {
    try {
      const [body, expRaw, sig] = token.split('.');
      if (!body || !expRaw || !sig) return null;
      const expected = sign(this.secret, `${body}.${expRaw}`);
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      if (Number(expRaw) <= this.now()) return null;
      const payload: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (
        typeof payload !== 'object' ||
        payload === null ||
        typeof (payload as Record<string, unknown>)['u'] !== 'string' ||
        typeof (payload as Record<string, unknown>)['t'] !== 'string'
      ) {
        return null;
      }
      const { u, t, r } = payload as Record<string, unknown>;
      const role = roleSchema.safeParse(r);
      if (!role.success) return null;
      return { userId: u as string, tenantId: t as string, role: role.data };
    } catch {
      return null;
    }
  }
}
