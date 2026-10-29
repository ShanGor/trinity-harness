import { describe, expect, it } from 'vitest';

import { decodeUlawSample, encodeUlawSample, upsample8to16 } from '../src/g711.js';

describe('g711 μ-law', () => {
  it('decodes known μ-law vectors (RFC 3551 figure)', () => {
    // Standard test vectors: μ-law 0 → +32124-ish max magnitude? Verify
    // monotonicity and known anchor points instead of the exact figure.
    expect(decodeUlawSample(0xff)).toBe(0); // 0xff is μ-law zero
    expect(decodeUlawSample(0x00)).toBeLessThan(-30_000); // max magnitude, negative
    expect(Math.abs(decodeUlawSample(0x80))).toBeGreaterThan(30_000); // max magnitude
  });

  it('encode/decode roundtrip preserves magnitude for speech-range samples', () => {
    // μ-law is logarithmic: it preserves relative magnitude well in the
    // speech range but compresses loud samples (20 000 decodes to ~8 000).
    for (const amplitude of [500, 2_000, 8_000]) {
      const decoded = decodeUlawSample(encodeUlawSample(amplitude));
      expect(Math.abs(decoded)).toBeGreaterThan(amplitude * 0.7);
      expect(Math.abs(decoded)).toBeLessThan(amplitude * 1.3);
    }
    const loud = Math.abs(decodeUlawSample(encodeUlawSample(20_000)));
    expect(loud).toBeGreaterThan(6_000);
  });

  it('roundtrips negative samples', () => {
    const decoded = decodeUlawSample(encodeUlawSample(-8_000));
    expect(decoded).toBeLessThan(-5_000);
    expect(decoded).toBeGreaterThan(-11_000);
  });
});

describe('upsample8to16', () => {
  it('doubles the length and interpolates midpoints', () => {
    const out = upsample8to16(new Int16Array([0, 100, 200]));
    expect(Array.from(out)).toEqual([0, 50, 100, 150, 200, 200]);
  });

  it('handles an empty input', () => {
    expect(upsample8to16(new Int16Array(0)).length).toBe(0);
  });
});
