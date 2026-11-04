import { db, type OverlayRecord } from '@/persistence/db';
import { isVoicePath, mediaKind } from './desktop';
import { IMAGE_HEADER_BYTES, imageSize } from './imageSize';

/**
 * Dateien, die ein umgewandeltes Spiel selbst in seinem Spielordner anlegt – z. B. ein Szenario, das
 * Student Transfer aus einer ZIP entpackt. Im Browser liegt der Spielordner nur im Arbeitsspeicher;
 * ohne RenOS wären solche Dateien nach dem Beenden weg. RenOS bewahrt sie pro Spiel auf und gibt sie
 * beim nächsten Start in der game.zip (Skripte, kleine Dateien) bzw. zum Nachladen (Bilder, Audio,
 * Video) wieder mit.
 *
 * Alles kommt aus dem Spiel und ist damit nicht vertrauenswürdig: Pfade werden streng geprüft, nur der
 * Spielordner des laufenden Spiels ist erreichbar, und Größen sind begrenzt.
 */

export const OVERLAY_LIMITS = {
  maxFileBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxFiles: 50_000,
  /** Bilder darüber werden bei Bedarf nachgeladen statt in der game.zip mitgegeben. */
  remoteImageBytes: 48 * 1024,
  remoteAudioBytes: 256 * 1024,
};

const changeListeners = new Set<(gameId: string) => void>();

/** Benachrichtigung bei Änderungen (z. B. um eine zwischengespeicherte game.zip zu verwerfen). */
export function onOverlayChange(listener: (gameId: string) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function changed(gameId: string) {
  for (const listener of changeListeners) listener(gameId);
}

/** Prüft einen Pfad aus dem Spiel: nur unter game/, keine Ausbrüche, keine Steuerzeichen. */
export function validOverlayPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length > 512 || !path.startsWith('game/')) return false;
  if (path.includes('\\') || [...path].some((c) => c.charCodeAt(0) < 32)) return false;
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  // Nicht überschreibbar: Dateien, mit denen RenOS das Spiel steuert.
  const rel = path.slice('game/'.length);
  return !['renpyweb_remote_files.txt', 'renos_base.txt', 'renos_overlay.txt', 'renos_web_support.rpy'].includes(rel) && !rel.startsWith('python-packages/_renos');
}

/** Sofort mitgeben (game.zip) oder bei Bedarf nachladen? */
export async function classifyOverlayFile(path: string, blob: Blob): Promise<{ kind: 'local' | 'remote'; meta: string }> {
  const rel = path.slice('game/'.length);
  const media = mediaKind(rel);
  if (media === 'video') return { kind: 'remote', meta: 'video -' };
  if (media === 'audio') {
    if (isVoicePath(rel)) return { kind: 'remote', meta: 'voice -' };
    return blob.size > OVERLAY_LIMITS.remoteAudioBytes ? { kind: 'remote', meta: 'music -' } : { kind: 'local', meta: '' };
  }
  if (media === 'image' && blob.size > OVERLAY_LIMITS.remoteImageBytes && !/^gui\//i.test(rel)) {
    const head = new Uint8Array(await blob.slice(0, IMAGE_HEADER_BYTES).arrayBuffer());
    const dims = imageSize(head);
    if (dims) return { kind: 'remote', meta: `image ${dims.width},${dims.height}` };
  }
  return { kind: 'local', meta: '' };
}

export async function listOverlay(gameId: string): Promise<OverlayRecord[]> {
  return db.overlay.where('gameId').equals(gameId).toArray();
}

export async function overlayUsage(gameId: string): Promise<{ files: number; bytes: number }> {
  const records = await listOverlay(gameId);
  return { files: records.length, bytes: records.reduce((n, r) => n + r.size, 0) };
}

export async function readOverlayFile(gameId: string, path: string): Promise<Blob | null> {
  const record = await db.overlay.get([gameId, path]);
  return record?.blob ?? null;
}

export type OverlaySaveResult = { ok: true } | { ok: false; reason: string };

/** Speichert eine vom Spiel angelegte Datei (ersetzt eine frühere Fassung). */
export async function saveOverlayFile(gameId: string, path: unknown, data: unknown): Promise<OverlaySaveResult> {
  if (!validOverlayPath(path)) return { ok: false, reason: 'Ungültiger Pfad.' };
  if (!(data instanceof ArrayBuffer)) return { ok: false, reason: 'Keine Daten.' };
  if (data.byteLength > OVERLAY_LIMITS.maxFileBytes) return { ok: false, reason: 'Die Datei ist zu groß.' };
  const existing = await listOverlay(gameId);
  const previous = existing.find((r) => r.path === path);
  const total = existing.reduce((n, r) => n + r.size, 0) - (previous?.size ?? 0) + data.byteLength;
  if (total > OVERLAY_LIMITS.maxTotalBytes) return { ok: false, reason: 'Zu viele Daten für dieses Spiel.' };
  if (!previous && existing.length >= OVERLAY_LIMITS.maxFiles) return { ok: false, reason: 'Zu viele Dateien für dieses Spiel.' };
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota && estimate.usage !== undefined && estimate.quota - estimate.usage < data.byteLength + 64 * 1024 * 1024) {
      return { ok: false, reason: 'Nicht genug Speicherplatz auf dem iPad.' };
    }
  } catch {
    /* Schätzung nicht verfügbar */
  }
  const blob = new Blob([data]);
  const { kind, meta } = await classifyOverlayFile(path, blob);
  await db.overlay.put({ gameId, path, blob, size: blob.size, kind, meta, updatedAt: Date.now() });
  changed(gameId);
  return { ok: true };
}

export async function removeOverlayFiles(gameId: string, paths: unknown): Promise<number> {
  if (!Array.isArray(paths)) return 0;
  const valid = paths.filter(validOverlayPath).slice(0, OVERLAY_LIMITS.maxFiles);
  if (!valid.length) return 0;
  await db.overlay.bulkDelete(valid.map((p) => [gameId, p] as [string, string]));
  changed(gameId);
  return valid.length;
}

export async function deleteOverlay(gameId: string): Promise<void> {
  await db.overlay.where('gameId').equals(gameId).delete();
  changed(gameId);
}
