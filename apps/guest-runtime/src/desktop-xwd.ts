import { BROWSER_LIMITS } from '@trinity-harness/contracts';

/** Decode only the fixed Xvfb true-colour format selected by our guest image. */
export function decodeDesktopXwd(input: Uint8Array): {
  width: number;
  height: number;
  rgba: Uint8Array;
} {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 100) throw new Error('Invalid desktop framebuffer');
  const word = (index: number): number => bytes.readUInt32BE(index * 4);
  const header = word(0),
    width = word(4),
    height = word(5),
    stride = word(12),
    colors = word(19);
  if (
    header < 100 ||
    header > 4096 ||
    word(1) !== 7 ||
    word(2) !== 2 ||
    word(3) !== 24 ||
    !width ||
    !height ||
    width > BROWSER_LIMITS.imageDimension ||
    height > BROWSER_LIMITS.imageDimension ||
    word(6) !== 0 ||
    word(7) !== 0 ||
    word(11) !== 32 ||
    stride !== width * 4 ||
    word(13) !== 4 ||
    word(14) !== 0xff0000 ||
    word(15) !== 0xff00 ||
    word(16) !== 0xff ||
    colors > 256
  )
    throw new Error('Unsupported desktop framebuffer');
  const offset = header + colors * 12;
  if (offset + stride * height !== bytes.length) throw new Error('Incomplete desktop framebuffer');
  const rgba = Buffer.allocUnsafe(width * height * 4);
  for (let row = 0; row < height; row++)
    for (let column = 0; column < width; column++) {
      const source = offset + row * stride + column * 4;
      const target = (row * width + column) * 4;
      rgba[target] = bytes[source + 2]!;
      rgba[target + 1] = bytes[source + 1]!;
      rgba[target + 2] = bytes[source]!;
      rgba[target + 3] = 255;
    }
  return { width, height, rgba };
}
