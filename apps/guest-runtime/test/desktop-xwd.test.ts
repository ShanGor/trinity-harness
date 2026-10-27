import { expect, it } from 'vitest';
import { decodeDesktopXwd } from '../src/desktop-xwd.js';

function picture(): Buffer {
  const buffer = Buffer.alloc(100 + 12 + 8);
  const words = [
    100, 7, 2, 24, 2, 1, 0, 0, 32, 0, 32, 32, 8, 4, 0xff0000, 0xff00, 0xff, 8, 256, 1, 2, 1, 0, 0,
    0,
  ];
  words.forEach((word, index) => buffer.writeUInt32BE(word, index * 4));
  buffer.set([3, 2, 1, 0, 6, 5, 4, 0], 112);
  return buffer;
}
it('decodes a full X11 desktop including the colour-table offset', () => {
  const decoded = decodeDesktopXwd(picture());
  expect([decoded.width, decoded.height]).toEqual([2, 1]);
  expect([...decoded.rgba]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
});
it('rejects truncated, oversized or unsupported framebuffer formats', () => {
  expect(() => decodeDesktopXwd(picture().subarray(0, 119))).toThrow('Incomplete');
  const oversized = picture();
  oversized.writeUInt32BE(2049, 16);
  expect(() => decodeDesktopXwd(oversized)).toThrow('Unsupported');
  const masks = picture();
  masks.writeUInt32BE(1, 56);
  expect(() => decodeDesktopXwd(masks)).toThrow('Unsupported');
});
