/**
 * Time-ordered UUIDv7 id generator.
 *
 * v7 embeds a 48-bit millisecond timestamp in the high bits, so B-tree
 * inserts (sessions, events, audit log, usage) append near the rightmost
 * leaf instead of scattering like v4 — better index locality and page
 * reuse. A per-process 12-bit counter keeps ids monotonically increasing
 * within the same millisecond (RFC 9562 §5.5 monotonicity option).
 *
 * Randomness comes from `crypto.getRandomValues`, which — unlike
 * `crypto.randomUUID` — is available in non-secure contexts (plain-http
 * LAN origins such as http://host:5173); a Math.random fallback covers
 * exotic runtimes. Node 22 exposes Web Crypto globally, so no import is
 * needed and the same code runs in the browser.
 */

/** 12-bit counter for same-millisecond monotonicity (per process). */
let lastMs = -1;
let counter = 0;

function fillRandom(buf: Uint8Array<ArrayBuffer>): void {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(buf);
    return;
  }
  for (let i = 0; i < buf.length; i++) buf[i] = (Math.random() * 256) | 0;
}

export function newId(): string {
  let ms = Date.now();

  if (ms === lastMs) {
    counter += 1;
    if (counter > 0x0fff) {
      // 4096 ids in one millisecond — not realistically reachable for this
      // app; wait out the millisecond rather than emit an out-of-order id.
      while (Date.now() === ms) {
        // busy spin (≤ 1 ms)
      }
      ms = Date.now();
      counter = 0;
    }
  } else {
    lastMs = ms;
    counter = 0;
  }
  lastMs = ms;

  const bytes = new Uint8Array(8);
  fillRandom(bytes);

  const out = new Uint8Array(16);
  // 48-bit big-endian Unix timestamp (ms).
  out[0] = ms / 2 ** 40;
  out[1] = ms / 2 ** 32;
  out[2] = ms / 2 ** 24;
  out[3] = ms / 2 ** 16;
  out[4] = ms / 2 ** 8;
  out[5] = ms;
  // version 7 + 12-bit counter (rand_a).
  out[6] = 0x70 | (counter >> 8);
  out[7] = counter & 0xff;
  // variant 10 + 62 random bits (rand_b).
  out[8] = 0x80 | (bytes[0]! & 0x3f);
  out.set(bytes.subarray(1), 9);

  const hex: string[] = [];
  for (const b of out) hex.push(b.toString(16).padStart(2, '0'));
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
