import { describe, expect, it } from 'vitest';

import { newId } from '../src/ids.js';

const V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newId (UUIDv7)', () => {
  it('produces version-7, variant-RFC4122 ids', () => {
    for (let i = 0; i < 1000; i++) {
      expect(newId()).toMatch(V7_RE);
    }
  });

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 100_000 }, () => newId()));
    expect(ids.size).toBe(100_000);
  });

  it('is monotonically increasing, including within the same millisecond', () => {
    // Burst of ids in a tight loop — most share one or two milliseconds.
    const ids = Array.from({ length: 10_000 }, () => newId());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('embeds the current timestamp (ms) in the first 48 bits', () => {
    const before = Date.now();
    const id = newId();
    const after = Date.now();
    const ms = parseInt(id.replaceAll('-', '').slice(0, 12), 16);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });
});
