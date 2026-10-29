import { describe, expect, it } from 'vitest';

import { RedisMediaTokens, type MediaTokenRedis } from '../src/media-token.js';

/** In-memory Redis with TTL semantics and an injectable clock. */
class MemoryRedis implements MediaTokenRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  private failing = false;
  private clock: () => number;

  constructor(start = 1_000_000_000_000) {
    let now = start;
    this.clock = () => now;
    this.advance = (ms: number) => {
      now += ms;
    };
  }

  readonly advance: (ms: number) => void;

  failNext(): void {
    this.failing = true;
  }

  private guard(): void {
    if (this.failing) {
      this.failing = false;
      throw new Error('redis unavailable');
    }
  }

  async set(key: string, value: string, _mode: 'EX', seconds: number): Promise<unknown> {
    this.guard();
    this.store.set(key, { value, expiresAt: this.clock() + seconds * 1000 });
    return 'OK';
  }

  async getdel(key: string): Promise<string | null> {
    this.guard();
    const entry = this.store.get(key);
    this.store.delete(key);
    if (!entry || entry.expiresAt <= this.clock()) return null;
    return entry.value;
  }

  async del(key: string): Promise<unknown> {
    this.guard();
    this.store.delete(key);
    return 1;
  }
}

const IDENTITY = { userId: 'user-1', tenantId: 'tenant-1' };

describe('RedisMediaTokens (docs/webrtc-media-design.md §4)', () => {
  it('issues a token and consumes it exactly once with the full binding', async () => {
    const redis = new MemoryRedis();
    const tokens = new RedisMediaTokens(
      redis,
      600,
      () => 'tok-1',
      () => new Date(1_000_000),
    );
    const token = await tokens.issue(IDENTITY, 'session-1');
    expect(token).toBe('tok-1');
    const binding = await tokens.consume(token!);
    expect(binding).toMatchObject({
      userId: 'user-1',
      tenantId: 'tenant-1',
      sessionId: 'session-1',
    });
    expect(binding!.expiresAt).toBe(new Date(1_000_000 + 600_000).toISOString());
    // One-time: a second consume finds nothing.
    expect(await tokens.consume(token!)).toBeNull();
  });

  it('expires tokens after the TTL', async () => {
    const redis = new MemoryRedis();
    const tokens = new RedisMediaTokens(redis, 600);
    const token = (await tokens.issue(IDENTITY, 'session-1'))!;
    redis.advance(601_000);
    expect(await tokens.consume(token)).toBeNull();
  });

  it('revokes tokens before use', async () => {
    const redis = new MemoryRedis();
    const tokens = new RedisMediaTokens(redis, 600);
    const token = (await tokens.issue(IDENTITY, 'session-1'))!;
    await tokens.revoke(token);
    expect(await tokens.consume(token)).toBeNull();
  });

  it('fails closed on backend errors and on malformed stored values', async () => {
    const redis = new MemoryRedis();
    const tokens = new RedisMediaTokens(redis, 600);
    redis.failNext();
    expect(await tokens.issue(IDENTITY, 'session-1')).toBeNull();

    const ok = (await tokens.issue(IDENTITY, 'session-1'))!;
    redis.failNext();
    expect(await tokens.consume(ok)).toBeNull();
    // The failed consume must not have destroyed the token.
    expect(await tokens.consume(ok)).not.toBeNull();

    // Direct corruption: an unparseable value consumes to null, not a throw.
    const bad = (await tokens.issue(IDENTITY, 'session-1'))!;
    await redis.set(`media:token:${bad}`, '{not json', 'EX', 600);
    expect(await tokens.consume(bad)).toBeNull();
  });
});
