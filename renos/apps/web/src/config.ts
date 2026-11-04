/**
 * Laufzeitkonfiguration des Frontends.
 *
 * - `server`: Spiele liegen auf einem RenOS-Server (eigener Server, siehe README).
 * - `local`:  Kein Server nötig (z. B. GitHub Pages). Spiele werden direkt auf dem iPad installiert
 *             (OPFS von RenOS) und über einen statischen Spiele-Host auf einer zweiten Adresse ausgeführt.
 */
export type BackendMode = 'server' | 'local';

export const BACKEND_MODE: BackendMode = import.meta.env.VITE_RENOS_BACKEND === 'local' ? 'local' : 'server';
export const IS_LOCAL = BACKEND_MODE === 'local';

/** Vorgabe für den Spiele-Host (z. B. aus einer GitHub-Repository-Variable beim Build). */
export const DEFAULT_GAME_HOST = (import.meta.env.VITE_RENOS_GAME_HOST ?? '').trim();

/** Basis-Pfad der App (GitHub Pages: /<repo>/renos/). */
export const BASE_URL = import.meta.env.BASE_URL;

/** Pfad zu einer Datei aus `public/`, unabhängig davon, unter welchem Pfad RenOS liegt. */
export function asset(path: string): string {
  return `${BASE_URL}${path.replace(/^\/+/, '')}`;
}

/**
 * Prüft und normalisiert die Adresse des Spiele-Hosts. Er muss auf einem anderen Origin als RenOS liegen,
 * sonst liefen fremde Spiele mit den Rechten von RenOS.
 */
export function normalizeGameHost(input: string): { ok: true; url: string; origin: string } | { ok: false; reason: 'empty' | 'invalid' | 'insecure' | 'same-origin' } {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: 'empty' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) return { ok: false, reason: 'insecure' };
  if (typeof window !== 'undefined' && url.origin === window.location.origin) return { ok: false, reason: 'same-origin' };
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return { ok: true, url: url.toString(), origin: url.origin };
}
