import { describe, expect, it } from 'vitest';

import { createPcmResampler, floatToInt16 } from '../src/streaming-asr.js';

function expectSamplesClose(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    expect(actual[i]).toBeCloseTo(expected[i]!, 5);
  }
}

describe('createPcmResampler', () => {
  it('passes samples through at identical rates', () => {
    const resample = createPcmResampler(16_000, 16_000);
    expectSamplesClose(resample(new Float32Array([0.1, -0.2, 0.5])), [0.1, -0.2, 0.5]);
  });

  it('downsamples 48 kHz to 16 kHz by factor 3 with phase carry', () => {
    const resample = createPcmResampler(48_000, 16_000);
    // Three identical samples ⇒ integrate-and-dump yields the same value.
    const block = (v: number, n: number) => new Float32Array(Array(n).fill(v));
    expectSamplesClose(resample(block(0.3, 3)), [0.3]);
    // Phase carries across callbacks: 2 samples now + 1 later still yield one
    // averaged sample, not a dropped or doubled frame.
    expectSamplesClose(resample(block(0.3, 2)), []);
    expectSamplesClose(resample(block(0.3, 1)), [0.3]);
    // Mixed values average correctly.
    const r2 = createPcmResampler(48_000, 16_000);
    expectSamplesClose(r2(new Float32Array([0, 0, 0.9])), [0.3]);
  });
});

describe('floatToInt16', () => {
  it('clamps and rounds to signed 16-bit samples', () => {
    expect(floatToInt16(0)).toBe(0);
    expect(floatToInt16(1)).toBe(0x7fff);
    expect(floatToInt16(-1)).toBe(-0x8000);
    expect(floatToInt16(2)).toBe(0x7fff);
    expect(floatToInt16(-2)).toBe(-0x8000);
    expect(floatToInt16(0.5)).toBe(Math.round(0.5 * 0x7fff));
  });
});
