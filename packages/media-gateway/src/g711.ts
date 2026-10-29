/**
 * G.711 μ-law → PCM16 helpers for the media gateway
 * (docs/webrtc-media-design.md §2).
 *
 * The gateway answers with PCMU only (G.711 μ-law, 8 kHz, RFC 3551 mandatory
 * in WebRTC browsers), so audio can be decoded in a few lines of pure
 * TypeScript — no Opus codec dependency. Opus (opusscript) was evaluated and
 * rejected: its encode/decode buffer handling corrupts samples on current
 * Node versions. μ-law is toll-quality voice (64 kbit/s), adequate for ASR.
 *
 * PCM path: μ-law byte → PCM16 mono 8 kHz → linear-interpolation upsample to
 * 16 kHz (Fun-ASR's required rate).
 */

export const G711_SAMPLE_RATE = 8_000;
export const PCM_SAMPLE_RATE = 16_000;
/** One PCMU RTP packet is usually 20 ms: 160 samples at 8 kHz. */
export const G711_FRAME_SAMPLES = 160;

/** Decode a frame of μ-law bytes to PCM16 mono 8 kHz. */
export function decodeUlawFrame(ulaw: Uint8Array): Int16Array {
  const out = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i += 1) out[i] = decodeUlawSample(ulaw[i]!);
  return out;
}

/** Classic μ-law decode (16-bit, as in RFC 3551 / g711.c). */
export function decodeUlawSample(u: number): number {
  const flipped = ~u & 0xff;
  const sign = flipped & 0x80;
  const exponent = (flipped >> 4) & 0x07;
  const mantissa = flipped & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign === 0 ? sample : -sample;
}

/** Linear-interpolation upsample 8 kHz → 16 kHz (factor 2). */
export function upsample8to16(samples: Int16Array): Int16Array {
  if (samples.length === 0) return new Int16Array(0);
  const out = new Int16Array(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const current = samples[i]!;
    const next = i + 1 < samples.length ? samples[i + 1]! : current;
    out[i * 2] = current;
    out[i * 2 + 1] = Math.round((current + next) / 2);
  }
  return out;
}

/** Encode one PCM16 sample to μ-law (used by tests to synthesize uplink). */
export function encodeUlawSample(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 8_159;
  let mask: number;
  if (sample < 0) {
    sample = BIAS - sample;
    mask = 0x7f;
  } else {
    sample = BIAS + sample;
    mask = 0xff;
  }
  if (sample > CLIP) sample = CLIP;
  const segEnds = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];
  let segment = 0;
  while (segment < 8 && sample > segEnds[segment]!) segment += 1;
  if (segment >= 8) return 0x7f ^ mask;
  return (((segment << 4) | ((sample >> (segment + 3)) & 0x0f)) ^ mask) & 0xff;
}

/** Encode a frame of PCM16 samples to μ-law bytes (test helper). */
export function encodeUlawFrame(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = encodeUlawSample(samples[i]!);
  return out;
}

/**
 * Resample PCM16 to 8 kHz for the G.711 downlink. Integer factors average
 * consecutive samples (box decimation — adequate for speech); non-integer
 * factors fall back to nearest-neighbor decimation.
 */
export function resampleTo8k(samples: Int16Array, sampleRate: number): Int16Array {
  if (sampleRate === G711_SAMPLE_RATE) return samples;
  const factor = sampleRate / G711_SAMPLE_RATE;
  const outLength = Math.floor(samples.length / factor);
  const out = new Int16Array(outLength);
  if (Number.isInteger(factor)) {
    const n = factor;
    for (let i = 0; i < outLength; i += 1) {
      let sum = 0;
      for (let j = 0; j < n; j += 1) sum += samples[i * n + j]!;
      out[i] = Math.round(sum / n);
    }
  } else {
    for (let i = 0; i < outLength; i += 1) out[i] = samples[Math.floor(i * factor)]!;
  }
  return out;
}
