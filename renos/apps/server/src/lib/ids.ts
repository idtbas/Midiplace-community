import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Erzeugt eine zufällige ID aus [a-z0-9] (Standard: 24 Zeichen ≈ 124 Bit Entropie).
 * Rejection Sampling vermeidet eine Verzerrung durch Modulo.
 */
export function randomId(length = 24): string {
  let out = '';
  while (out.length < length) {
    const bytes = randomBytes(length * 2);
    for (const byte of bytes) {
      // 252 = 7 * 36: Werte darüber werden verworfen, damit jedes Zeichen gleich wahrscheinlich ist.
      if (byte < 252) out += ALPHABET[byte % 36];
      if (out.length === length) break;
    }
  }
  return out;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
