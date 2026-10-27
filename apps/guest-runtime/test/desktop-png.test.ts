import { expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { BROWSER_LIMITS } from '@trinity-harness/contracts';
import { encodeDesktopPng } from '../src/desktop-png.js';

it('keeps a high-entropy desktop within the frame limit without changing its geometry', () => {
  const width = 1280,
    height = 800;
  const pixels = Buffer.alloc(width * height * 4);
  let state = 0x12345678;
  for (let i = 0; i < pixels.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixels[i + channel] = state & 0xff;
    }
    pixels[i + 3] = 255;
  }
  const encoded = encodeDesktopPng(pixels, width, height);
  expect(encoded.byteLength).toBeLessThanOrEqual(BROWSER_LIMITS.image);
  const decoded = PNG.sync.read(encoded);
  expect([decoded.width, decoded.height]).toEqual([width, height]);
  expect(decoded.data[3]).toBe(255);
  expect(decoded.data.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(true);
});
it('rejects mismatched or oversized desktop geometry', () => {
  expect(() => encodeDesktopPng(new Uint8Array(3), 1, 1)).toThrow('Invalid desktop picture');
  expect(() => encodeDesktopPng(new Uint8Array(), 2049, 1)).toThrow('Invalid desktop picture');
});
