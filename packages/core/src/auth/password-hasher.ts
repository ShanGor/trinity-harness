import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

import type { PasswordHasher } from '@trinity-harness/contracts';

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, derived) => {
      if (err) reject(err);
      else resolve(derived as Buffer);
    });
  });
}

const N = 16384;
const KEYLEN = 64;

/**
 * scrypt password hashing (node:crypto — no external dependency).
 * Encoded form: `scrypt$N$r$p$salt$hash` (base64url).
 */
export class ScryptPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = (await scrypt(password, salt, KEYLEN, { N })) as Buffer;
    return `scrypt$${N}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    try {
      const [scheme, n, saltB64, hashB64] = encoded.split('$');
      if (scheme !== 'scrypt' || !n || !saltB64 || !hashB64) return false;
      const expected = Buffer.from(hashB64, 'base64url');
      const derived = (await scrypt(password, Buffer.from(saltB64, 'base64url'), expected.length, {
        N: Number(n),
      })) as Buffer;
      return timingSafeEqual(derived, expected);
    } catch {
      return false;
    }
  }
}
