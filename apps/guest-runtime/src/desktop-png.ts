import { PNG } from 'pngjs';
import { BROWSER_LIMITS } from '@trinity-harness/contracts';

/** Keep desktop geometry intact while fitting the private-frame wire limit. */
export function encodeDesktopPng(rgba: Uint8Array, width: number, height: number): Buffer {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > BROWSER_LIMITS.imageDimension ||
    height > BROWSER_LIMITS.imageDimension ||
    rgba.byteLength !== width * height * 4
  )
    throw new Error('Invalid desktop picture');
  const picture = new PNG({ width, height });
  picture.data = Buffer.from(rgba);
  for (const mask of [0xff, 0xf8, 0xf0, 0xe0, 0xc0, 0x80]) {
    if (mask !== 0xff) {
      for (let i = 0; i < picture.data.length; i += 4) {
        picture.data[i] = picture.data[i]! & mask;
        picture.data[i + 1] = picture.data[i + 1]! & mask;
        picture.data[i + 2] = picture.data[i + 2]! & mask;
      }
    }
    const png = PNG.sync.write(picture, { colorType: 2 });
    if (png.byteLength <= BROWSER_LIMITS.image) return png;
  }
  throw new Error('Desktop picture exceeds the limit');
}
