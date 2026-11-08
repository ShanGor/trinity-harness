/** Approximate tokens, matching Trinity's composer baseline. No payload normalization. */
export const LARGE_PASTE_TOKEN_THRESHOLD = 8_000;
export const MAX_PASTE_BYTES = 20 * 1024 * 1024;
export function isLargePaste(text: string, threshold = LARGE_PASTE_TOKEN_THRESHOLD): boolean {
  return Math.ceil(text.length / 4) >= threshold;
}
