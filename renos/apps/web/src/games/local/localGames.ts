import { GAME_ID_PATTERN, detectImageType, sanitizeTitle, type ArchiveAnalysis, type ArchiveLimits, type Game, type StorageInfoResponse } from '@renos/shared';
import { ApiError } from '@/api/client';
import { db, type LocalGame } from '@/persistence/db';
import { requestPersistentStorage } from '@/pwa/register';
import type { WorkerRequest, WorkerResponse } from './installWorker';
import { forgetGameDirectory, listGameDirectories, readGameFile, removeGameDirectory } from './opfs';
import { deleteSaves } from './saves';

/**
 * Spiele, die direkt auf diesem Gerät installiert sind (Modus „lokal“, z. B. RenOS auf GitHub Pages).
 * Metadaten liegen in IndexedDB, die Dateien im OPFS von RenOS. Eine Installation gilt erst als
 * vorhanden, wenn ihr Datenbankeintrag existiert; verwaiste Ordner werden beim Start entfernt.
 */

export const LOCAL_LIMITS: ArchiveLimits = {
  maxEntries: 200_000,
  // Die tatsächliche Grenze ist der freie Speicher (wird vor der Installation geprüft).
  maxUncompressedBytes: Number.MAX_SAFE_INTEGER,
  maxCompressionRatio: 200,
};
const STORAGE_MARGIN = 128 * 1024 * 1024;
const MAX_COVER_BYTES = 8 * 1024 * 1024;

// ----- Worker ----------------------------------------------------------------

type Pending = {
  resolve: (value: WorkerResponse) => void;
  reject: (error: unknown) => void;
  onProgress?: (bytes: number, files: number) => void;
};
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./installWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data;
    const entry = pending.get(msg.id);
    if (!entry) return;
    if (msg.type === 'progress') {
      entry.onProgress?.(msg.bytesWritten, msg.filesWritten);
      return;
    }
    pending.delete(msg.id);
    entry.resolve(msg);
  };
  worker.onerror = (event) => {
    for (const [id, entry] of pending) {
      entry.reject(new ApiError('install_failed', 0, event.message || undefined));
      pending.delete(id);
    }
    worker = null;
  };
  return worker;
}

type CallRequest = WorkerRequest extends infer R ? (R extends { type: 'analyze' | 'install' } ? Omit<R, 'id'> : never) : never;

function call(request: CallRequest, onProgress?: Pending['onProgress']) {
  seq += 1;
  const id = seq;
  const promise = new Promise<WorkerResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ ...request, id } as WorkerRequest);
  });
  return { id, promise };
}

function workerError(code: string, detail?: string): ApiError {
  switch (code) {
    case 'insufficient_storage':
      return new ApiError('insufficient_storage', 0, 'Auf diesem iPad ist nicht genug Speicher für RenOS frei. Lösche Spiele oder Dateien und versuche es erneut.');
    case 'aborted':
      return new ApiError('aborted', 0);
    case 'archive_invalid':
      return new ApiError('archive_invalid', 0, `Das Archiv konnte nicht sicher entpackt werden${detail ? ` (${detail})` : ''}.`);
    case 'storage_unavailable':
      return new ApiError('install_failed', 0, 'Der lokale Speicher ist nicht verfügbar (privater Modus oder blockierte Website-Daten).');
    default:
      return new ApiError('install_failed', 0);
  }
}

// ----- Analyse & Installation ------------------------------------------------

export async function analyzeLocalArchive(file: File): Promise<ArchiveAnalysis> {
  const { promise } = call({ type: 'analyze', file, limits: LOCAL_LIMITS });
  const result = await promise;
  if (result.type === 'analysis') return result.analysis;
  if (result.type === 'error') throw workerError(result.code, result.detail);
  throw new ApiError('internal_error', 0);
}

function randomGameId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  while (out.length < 24) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < 252) out += alphabet[byte % 36];
      if (out.length === 24) break;
    }
  }
  return out;
}

export async function freeLocalBytes(): Promise<number | null> {
  try {
    const estimate = await navigator.storage.estimate();
    if (!estimate.quota) return null;
    return Math.max(0, estimate.quota - (estimate.usage ?? 0));
  } catch {
    return null;
  }
}

export interface LocalInstallHandle {
  promise: Promise<Game>;
  cancel: () => void;
}

export function installLocalGame(
  file: File,
  analysis: ArchiveAnalysis,
  title: string,
  hostUrl: string,
  onProgress: (bytesWritten: number, filesWritten: number) => void,
): LocalInstallHandle {
  const gameId = randomGameId();
  let workerId = 0;
  let cancelled = false;
  const promise = (async () => {
    if (!analysis.installable) throw new ApiError('archive_not_installable', 0);
    const free = await freeLocalBytes();
    if (free !== null && free < analysis.uncompressedBytes + STORAGE_MARGIN) throw workerError('insufficient_storage');
    // Ohne dauerhaften Speicher könnte iPadOS große Spiele bei Speicherknappheit entfernen.
    await requestPersistentStorage();
    if (cancelled) throw new ApiError('aborted', 0);
    const job = call({ type: 'install', file, gameId, rootPrefix: analysis.rootPrefix, limits: LOCAL_LIMITS }, onProgress);
    workerId = job.id;
    const result = await job.promise;
    if (result.type === 'error') throw workerError(result.code, result.detail);
    if (result.type !== 'installed') throw new ApiError('install_failed', 0);

    if (!(await readGameFile(gameId, 'index.html'))) throw new ApiError('install_failed', 0, 'Nach dem Entpacken fehlt die index.html.');
    let coverVersion = 0;
    if (analysis.presplash) {
      const presplash = await readGameFile(gameId, analysis.presplash);
      if (presplash && presplash.size <= MAX_COVER_BYTES) {
        const head = new Uint8Array(await presplash.slice(0, 16).arrayBuffer());
        const type = detectImageType(head);
        if (type) {
          await db.covers.put({ id: gameId, data: new Blob([await presplash.arrayBuffer()], { type: type.mime }) });
          coverVersion = 1;
        }
      }
    }
    const record: LocalGame = {
      id: gameId,
      title: sanitizeTitle(title, analysis.detectedTitle ?? 'Unbenanntes Spiel'),
      entry: 'index.html',
      sizeBytes: result.bytesWritten,
      fileCount: result.filesWritten,
      installedAt: new Date().toISOString(),
      lastPlayedAt: null,
      sourceFileName: file.name.slice(0, 200),
      runtime: analysis.runtime,
      coverVersion,
    };
    // Erst jetzt erscheint das Spiel in der Bibliothek.
    await db.games.add(record);
    return toGame(record, hostUrl);
  })().catch(async (error: unknown) => {
    await db.covers.delete(gameId).catch(() => undefined);
    await removeGameDirectory(gameId).catch(() => undefined);
    throw error;
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      if (workerId) getWorker().postMessage({ type: 'cancel', id: workerId } satisfies WorkerRequest);
    },
  };
}

// ----- Verwaltung ------------------------------------------------------------

const coverUrls = new Map<string, { version: number; url: string }>();

async function coverUrlFor(record: LocalGame): Promise<string | null> {
  if (!record.coverVersion) return null;
  const cached = coverUrls.get(record.id);
  if (cached && cached.version === record.coverVersion) return cached.url;
  const cover = await db.covers.get(record.id);
  if (!cover) return null;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(cover.data);
  coverUrls.set(record.id, { version: record.coverVersion, url });
  return url;
}

export function playUrlFor(gameId: string, hostUrl: string): string {
  return hostUrl ? `${hostUrl}host.html?game=${gameId}` : '';
}

async function toGame(record: LocalGame, hostUrl: string): Promise<Game> {
  return {
    id: record.id,
    title: record.title,
    entry: record.entry,
    sizeBytes: record.sizeBytes,
    fileCount: record.fileCount,
    installedAt: record.installedAt,
    lastPlayedAt: record.lastPlayedAt,
    coverUrl: await coverUrlFor(record),
    sourceFileName: record.sourceFileName,
    runtime: record.runtime,
    playUrl: playUrlFor(record.id, hostUrl),
  };
}

async function requireGame(id: string): Promise<LocalGame> {
  const record = GAME_ID_PATTERN.test(id) ? await db.games.get(id) : undefined;
  if (!record) throw new ApiError('not_found', 404, 'Dieses Spiel ist nicht installiert.');
  return record;
}

export async function listLocalGames(hostUrl: string): Promise<Game[]> {
  const records = await db.games.orderBy('title').toArray();
  return Promise.all(records.map((r) => toGame(r, hostUrl)));
}

export async function getLocalGame(id: string, hostUrl: string): Promise<Game> {
  return toGame(await requireGame(id), hostUrl);
}

export async function renameLocalGame(id: string, title: string, hostUrl: string): Promise<Game> {
  await requireGame(id);
  await db.games.update(id, { title: sanitizeTitle(title) });
  return getLocalGame(id, hostUrl);
}

export async function markLocalPlayed(id: string, hostUrl: string): Promise<Game> {
  await requireGame(id);
  await db.games.update(id, { lastPlayedAt: new Date().toISOString() });
  return getLocalGame(id, hostUrl);
}

export async function deleteLocalGame(id: string): Promise<void> {
  await requireGame(id);
  // Zuerst den Eintrag entfernen: Ab jetzt liefert RenOS keine Dateien dieses Spiels mehr aus.
  await db.games.delete(id);
  await db.covers.delete(id);
  await deleteSaves(id);
  forgetGameDirectory(id);
  const cached = coverUrls.get(id);
  if (cached) URL.revokeObjectURL(cached.url);
  coverUrls.delete(id);
  await removeGameDirectory(id);
}

export async function setLocalCover(id: string, image: Blob, hostUrl: string): Promise<Game> {
  const record = await requireGame(id);
  if (image.size === 0 || image.size > MAX_COVER_BYTES) throw new ApiError('image_invalid', 422);
  const type = detectImageType(new Uint8Array(await image.slice(0, 16).arrayBuffer()));
  if (!type) throw new ApiError('image_invalid', 422);
  await db.covers.put({ id, data: new Blob([await image.arrayBuffer()], { type: type.mime }) });
  await db.games.update(id, { coverVersion: record.coverVersion + 1 });
  return getLocalGame(id, hostUrl);
}

export async function removeLocalCover(id: string, hostUrl: string): Promise<Game> {
  await requireGame(id);
  await db.covers.delete(id);
  await db.games.update(id, { coverVersion: 0 });
  return getLocalGame(id, hostUrl);
}

export async function localStorageInfo(): Promise<StorageInfoResponse> {
  const records = await db.games.toArray();
  let quota: number | null = null;
  let usage = 0;
  try {
    const estimate = await navigator.storage.estimate();
    quota = estimate.quota ?? null;
    usage = estimate.usage ?? 0;
  } catch {
    /* nicht verfügbar */
  }
  return {
    gamesCount: records.length,
    gamesBytes: records.reduce((sum, r) => sum + r.sizeBytes, 0),
    diskFreeBytes: quota === null ? null : Math.max(0, quota - usage),
    diskTotalBytes: quota,
  };
}

/** Datei eines installierten Spiels – nur für Spiele mit Datenbankeintrag. */
export async function readInstalledGameFile(gameId: string, path: string): Promise<File | null> {
  if (!GAME_ID_PATTERN.test(gameId) || !(await db.games.get(gameId))) return null;
  return readGameFile(gameId, path);
}

/** Entfernt Spielordner ohne Datenbankeintrag (z. B. nach einem Abbruch während der Installation). */
export async function cleanupLocalGames(activeIds: Set<string> = new Set()): Promise<number> {
  let removed = 0;
  try {
    const known = new Set((await db.games.toCollection().primaryKeys()) as string[]);
    for (const name of await listGameDirectories()) {
      if (GAME_ID_PATTERN.test(name) && !known.has(name) && !activeIds.has(name)) {
        await removeGameDirectory(name);
        removed += 1;
      }
    }
  } catch {
    /* OPFS nicht verfügbar */
  }
  return removed;
}
