import type { MediaTokenBinding, MediaTokenPort } from '@trinity-harness/contracts';
import { MEDIA_TOKEN_TTL_SECONDS } from '@trinity-harness/contracts';
import { z } from 'zod';

/**
 * Redis-backed short-lived media tokens (docs/webrtc-media-design.md §4).
 * Opaque random IDs (never JWTs — no client-readable claims), one-time use via
 * GETDEL, revocable by deletion, TTL-enforced by Redis. Fail-closed: `issue`
 * returns null and `consume` returns null on any backend error or malformed
 * value.
 */

/** Minimal Redis surface so tests can substitute an in-memory fake. */
export interface MediaTokenRedis {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

const storedBindingSchema = z.object({
  userId: z.string().min(1),
  tenantId: z.string().min(1),
  sessionId: z.string().min(1),
  expiresAt: z.string().min(1),
});

export class RedisMediaTokens implements MediaTokenPort {
  constructor(
    private readonly redis: MediaTokenRedis,
    private readonly ttlSeconds: number = MEDIA_TOKEN_TTL_SECONDS,
    private readonly id: () => string = () => crypto.randomUUID(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(
    identity: { userId: string; tenantId: string },
    sessionId: string,
  ): Promise<string | null> {
    const expiresAt = new Date(this.now().getTime() + this.ttlSeconds * 1000).toISOString();
    const token = this.id();
    try {
      await this.redis.set(
        keyOf(token),
        JSON.stringify({
          userId: identity.userId,
          tenantId: identity.tenantId,
          sessionId,
          expiresAt,
        }),
        'EX',
        this.ttlSeconds,
      );
    } catch {
      return null;
    }
    return token;
  }

  /** One-time: GETDEL atomically reads and deletes, so reuse is impossible. */
  async consume(token: string): Promise<MediaTokenBinding | null> {
    let raw: string | null;
    try {
      raw = await this.redis.getdel(keyOf(token));
    } catch {
      return null;
    }
    if (raw === null) return null;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null; // corrupted value: deny rather than throw
    }
    const parsed = storedBindingSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  }

  /** Best-effort revocation; deletion failure leaves the TTL as backstop. */
  async revoke(token: string): Promise<void> {
    try {
      await this.redis.del(keyOf(token));
    } catch {
      // The TTL still bounds exposure; nothing else to do here.
    }
  }
}

function keyOf(token: string): string {
  return `media:token:${token}`;
}
