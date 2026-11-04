import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Passwort-Hashing mit scrypt (in Node enthalten, keine zusätzliche Abhängigkeit).
 * Format: scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>
 */

const KEY_LENGTH = 64;
const DEFAULT_N = 2 ** 15;
const DEFAULT_R = 8;
const DEFAULT_P = 1;

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function maxmemFor(N: number, r: number): number {
  return 128 * N * r * 2;
}

export async function hashPassword(password: string, params = { N: DEFAULT_N, r: DEFAULT_R, p: DEFAULT_P }): Promise<string> {
  if (password.length < 8) throw new Error('Das Passwort muss mindestens 8 Zeichen lang sein.');
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, { ...params, maxmem: maxmemFor(params.N, params.r) });
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export function isValidPasswordHash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  return (
    Number.isInteger(N) && N! >= 2 ** 14 && N! <= 2 ** 20 && (N! & (N! - 1)) === 0 &&
    Number.isInteger(r) && r! >= 1 && r! <= 32 &&
    Number.isInteger(p) && p! >= 1 && p! <= 16 &&
    Buffer.from(parts[4] ?? '', 'base64url').length >= 16 &&
    Buffer.from(parts[5] ?? '', 'base64url').length === KEY_LENGTH
  );
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!isValidPasswordHash(stored)) return false;
  const parts = stored.split('$');
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  // Sehr lange Eingaben begrenzen, damit niemand den Server mit riesigen Passwörtern belastet.
  const candidate = await scrypt(password.slice(0, 1024), salt, expected.length, { N, r, p, maxmem: maxmemFor(N, r) });
  return timingSafeEqual(candidate, expected);
}
