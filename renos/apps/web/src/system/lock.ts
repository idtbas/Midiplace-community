/**
 * Geräte-PIN für den Sperrbildschirm.
 *
 * Die PIN wird nie im Klartext gespeichert, sondern als PBKDF2-SHA-256-Hash mit zufälligem Salt
 * (Format: `pbkdf2$<iterationen>$<salt>$<hash>`, Base64). Sie schützt vor neugierigen Blicken auf
 * ein entsperrtes iPad – nicht vor jemandem, der die Website-Daten ausliest (das kann nur iPadOS).
 */

const ITERATIONS = 150_000;
const PREFIX = 'pbkdf2';

export const PIN_RULES = { min: 4, max: 32 };

/** Prüft eine neue PIN bzw. ein Passwort. Liefert eine Fehlermeldung oder null. */
export function validatePin(pin: string): string | null {
  if (pin.length < PIN_RULES.min) return `Mindestens ${PIN_RULES.min} Zeichen.`;
  if (pin.length > PIN_RULES.max) return `Höchstens ${PIN_RULES.max} Zeichen.`;
  if (/^\s|\s$/.test(pin)) return 'Keine Leerzeichen am Anfang oder Ende.';
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function derive(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, ITERATIONS);
  return `${PREFIX}$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [prefix, iter, salt, hash] = stored.split('$');
  const iterations = Number(iter);
  if (prefix !== PREFIX || !salt || !hash || !Number.isInteger(iterations) || iterations < 1000 || iterations > 10_000_000) return false;
  const expected = fromBase64(hash);
  const actual = await derive(pin, fromBase64(salt), iterations);
  if (actual.length !== expected.length) return false;
  // Vergleich ohne frühen Abbruch.
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}

/** Wartezeit nach Fehlversuchen: ab dem 5. Versuch 30 s, danach jeweils doppelt so lang (max. 15 min). */
export function lockoutMs(failedAttempts: number): number {
  if (failedAttempts < 5) return 0;
  return Math.min(30_000 * 2 ** (failedAttempts - 5), 15 * 60_000);
}
