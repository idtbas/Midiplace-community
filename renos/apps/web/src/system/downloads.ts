import { create } from 'zustand';
import type { FsNode } from '@/persistence/db';
import { MAX_FILE_BYTES, createFile, guessMime, uniqueName } from '@/persistence/fs';
import { notify } from './notifications';
import { useSettings } from './settings';

/**
 * Downloads von RenOS: Dateien aus dem Internet landen in Files (Standard: Downloads) – nicht in der
 * Dateien-App des iPads.
 *
 * Eine Web-App darf fremde Dateien nur laden, wenn der Server es erlaubt (CORS). Viele Seiten tun das
 * (z. B. GitHub-Rohdateien, student-transfer.com), viele Datei-Hoster nicht. Für diese kann ein eigener,
 * kleiner Weiterleitungsdienst eingetragen werden (Settings → Browser, Anleitung in der README); RenOS
 * nutzt ihn nur, wenn der direkte Weg scheitert.
 */

export type DownloadState = 'running' | 'done' | 'error' | 'cancelled';

export interface DownloadItem {
  id: string;
  url: string;
  name: string;
  received: number;
  total: number | null;
  state: DownloadState;
  error?: string;
  nodeId?: string;
  viaProxy: boolean;
  startedAt: number;
}

interface DownloadStore {
  items: DownloadItem[];
  update: (id: string, patch: Partial<DownloadItem>) => void;
  add: (item: DownloadItem) => void;
  clearFinished: () => void;
}

export const useDownloads = create<DownloadStore>()((set) => ({
  items: [],
  add: (item) => set((s) => ({ items: [item, ...s.items].slice(0, 50) })),
  update: (id, patch) => set((s) => ({ items: s.items.map((d) => (d.id === id ? { ...d, ...patch } : d)) })),
  clearFinished: () => set((s) => ({ items: s.items.filter((d) => d.state === 'running') })),
}));

const controllers = new Map<string, AbortController>();

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly kind: 'blocked' | 'http' | 'too-large' | 'network' | 'invalid',
  ) {
    super(message);
  }
}

/** Eine Webseite statt einer Datei: gefundene Links auf Dateien. */
export interface PageResult {
  kind: 'page';
  url: string;
  links: Array<{ url: string; label: string }>;
}

/** Adresse prüfen und vervollständigen („example.com/x“ → https://example.com/x). */
export function normalizeUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Dateiname aus Content-Disposition oder Adresse. */
export function fileNameFor(url: string, disposition: string | null): string {
  if (disposition) {
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
    if (star?.[1]) {
      try {
        return sanitizeName(decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')));
      } catch {
        /* weiter mit filename= */
      }
    }
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
    if (plain?.[1]) return sanitizeName(plain[1].trim());
  }
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    // Mediafire & Co.: …/datei.zip/file
    const last = [...segments].reverse().find((s) => /\.[a-z0-9]{1,8}$/i.test(s)) ?? segments[segments.length - 1];
    if (last) return sanitizeName(decodeURIComponent(last));
    return sanitizeName(parsed.hostname);
  } catch {
    return 'download';
  }
}

function sanitizeName(name: string): string {
  const clean = [...name]
    .map((c) => (c === '/' || c === '\\' || c.charCodeAt(0) < 32 ? '_' : c))
    .join('')
    .trim()
    .slice(0, 180);
  return clean && clean !== '.' && clean !== '..' ? clean : 'download';
}

const FILE_LINK = /\.(zip|rar|7z|tar|gz|tgz|xz|apk|exe|dmg|rpa|rpy|txt|pdf|png|jpe?g|webp|gif|mp3|ogg|opus|wav|mp4|webm|mkv)(\?|#|$)/i;

/** Links auf Dateien in einer Webseite (z. B. Download-Knopf einer Hoster-Seite). */
export function findFileLinks(html: string, baseUrl: string): Array<{ url: string; label: string }> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const seen = new Set<string>();
  const out: Array<{ url: string; label: string }> = [];
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    let href: string;
    try {
      href = new URL(a.getAttribute('href') ?? '', baseUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:/i.test(href) || seen.has(href)) continue;
    const label = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
    const downloadish = FILE_LINK.test(new URL(href).pathname) || a.hasAttribute('download') || /download/i.test(a.id + ' ' + a.className + ' ' + label);
    if (!downloadish) continue;
    seen.add(href);
    out.push({ url: href, label: label.slice(0, 120) || fileNameFor(href, null) });
  }
  return out.slice(0, 40);
}

export function proxyUrlFor(proxy: string, url: string): string {
  const base = proxy.trim().replace(/\/+$/, '');
  return `${base}/?url=${encodeURIComponent(url)}`;
}

async function fetchWithFallback(url: string, signal: AbortSignal): Promise<{ response: Response; viaProxy: boolean }> {
  try {
    return { response: await fetch(url, { signal, mode: 'cors', credentials: 'omit', redirect: 'follow' }), viaProxy: false };
  } catch (error) {
    if (signal.aborted) throw error;
    const proxy = useSettings.getState().downloadProxy;
    if (!proxy) {
      throw new DownloadError(
        'Der Server erlaubt keine Downloads aus Web-Apps (oder ist nicht erreichbar). Tipp: In Safari öffnen und die Datei danach in Files importieren – oder in den Einstellungen einen eigenen Weiterleitungsdienst eintragen.',
        'blocked',
      );
    }
    try {
      return { response: await fetch(proxyUrlFor(proxy, url), { signal, mode: 'cors', credentials: 'omit' }), viaProxy: true };
    } catch (proxyError) {
      if (signal.aborted) throw proxyError;
      throw new DownloadError('Weder direkt noch über den Weiterleitungsdienst erreichbar.', 'network');
    }
  }
}

/**
 * Lädt eine Adresse herunter und legt die Datei in Files ab. Liefert die Datei – oder, wenn die Adresse
 * eine Webseite ist, die darauf gefundenen Datei-Links.
 */
export async function startDownload(input: string, options: { folderId?: string; allowPage?: boolean } = {}): Promise<{ kind: 'file'; node: FsNode } | PageResult> {
  const url = normalizeUrl(input);
  if (!url) throw new DownloadError('Bitte eine gültige Adresse (https://…) eingeben.', 'invalid');
  const id = crypto.randomUUID();
  const controller = new AbortController();
  controllers.set(id, controller);
  const store = useDownloads.getState();
  store.add({ id, url, name: fileNameFor(url, null), received: 0, total: null, state: 'running', viaProxy: false, startedAt: Date.now() });
  try {
    const { response, viaProxy } = await fetchWithFallback(url, controller.signal);
    if (!response.ok) throw new DownloadError(`Der Server antwortet mit Fehler ${response.status}.`, 'http');
    const type = response.headers.get('content-type') ?? '';
    // Über den Weiterleitungsdienst: die tatsächliche Adresse (nach Umleitungen) steht in X-Final-Url.
    const finalUrl = (viaProxy ? response.headers.get('x-final-url') : response.url) || url;
    const name = fileNameFor(finalUrl, response.headers.get('content-disposition'));
    const length = Number(response.headers.get('content-length')) || null;
    if (length && length > MAX_FILE_BYTES) throw new DownloadError(`Die Datei ist größer als ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`, 'too-large');
    store.update(id, { name, total: length, viaProxy });

    if (/text\/html/i.test(type) && options.allowPage !== false && !/\.html?$/i.test(name)) {
      const html = await response.text();
      useDownloads.getState().update(id, { state: 'done', received: html.length, name: `${name} (Webseite)` });
      return { kind: 'page', url: finalUrl, links: findFileLinks(html, finalUrl) };
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    if (response.body) {
      const reader = response.body.getReader();
      let lastUpdate = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        if (received > MAX_FILE_BYTES) {
          await reader.cancel();
          throw new DownloadError(`Die Datei ist größer als ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`, 'too-large');
        }
        const now = Date.now();
        if (now - lastUpdate > 150) {
          lastUpdate = now;
          useDownloads.getState().update(id, { received });
        }
      }
    } else {
      const buffer = new Uint8Array(await response.arrayBuffer());
      chunks.push(buffer);
      received = buffer.byteLength;
    }
    const mime = type.split(';')[0]?.trim() || guessMime(name);
    const blob = new Blob(chunks as Uint8Array<ArrayBuffer>[], { type: mime });
    const folderId = options.folderId ?? 'downloads';
    const node = await createFile(folderId, await uniqueName(folderId, name), blob, mime);
    useDownloads.getState().update(id, { state: 'done', received, name: node.name, nodeId: node.id });
    notify({ kind: 'success', title: `„${node.name}“ heruntergeladen`, message: 'Gespeichert in Files → Downloads.' });
    return { kind: 'file', node };
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const message = error instanceof DownloadError ? error.message : cancelled ? 'Abgebrochen.' : error instanceof Error ? error.message : 'Download fehlgeschlagen.';
    useDownloads.getState().update(id, { state: cancelled ? 'cancelled' : 'error', error: message });
    throw error instanceof DownloadError || cancelled ? error : new DownloadError(message, 'network');
  } finally {
    controllers.delete(id);
  }
}

export function cancelDownload(id: string): void {
  controllers.get(id)?.abort();
}
