/// <reference lib="webworker" />
/**
 * Installations-Worker: analysiert ein Spielarchiv und entpackt es in das OPFS von RenOS.
 * Läuft im Hintergrund, damit die Oberfläche auch bei mehreren Gigabyte flüssig bleibt.
 */
import {
  EntryScanner,
  INDEX_HTML_MAX_BYTES,
  emptyAnalysis,
  isExecutablePath,
  isIndexCandidate,
  isJunkPath,
  summarizeArchive,
  type ArchiveAnalysis,
  type ArchiveLimits,
} from '@renos/shared';
import { gameDirectory } from './opfs';
import { ZipFormatError, isEncrypted, readCentralDirectory, readEntryChunks, readEntryText, type ZipEntry } from './zipReader';

export type WorkerRequest =
  | { type: 'analyze'; id: number; file: File; limits: ArchiveLimits }
  | { type: 'install'; id: number; file: File; gameId: string; rootPrefix: string; limits: ArchiveLimits }
  | { type: 'cancel'; id: number };

export type WorkerErrorCode = 'archive_invalid' | 'insufficient_storage' | 'aborted' | 'storage_unavailable' | 'internal';

export type WorkerResponse =
  | { type: 'analysis'; id: number; analysis: ArchiveAnalysis }
  | { type: 'progress'; id: number; bytesWritten: number; filesWritten: number }
  | { type: 'installed'; id: number; bytesWritten: number; filesWritten: number }
  | { type: 'error'; id: number; code: WorkerErrorCode; detail?: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const cancelled = new Set<number>();

function post(message: WorkerResponse) {
  scope.postMessage(message);
}

function scan(entries: ZipEntry[], limits: ArchiveLimits) {
  const scanner = new EntryScanner(limits);
  const accepted: Array<{ entry: ZipEntry; path: string; isDirectory: boolean; size: number }> = [];
  if (!scanner.checkEntryCount(entries.length)) return { scanner, accepted };
  for (const entry of entries) {
    const scanned = scanner.accept({
      name: entry.name,
      externalFileAttributes: entry.externalFileAttributes,
      encrypted: isEncrypted(entry),
      compressionMethod: entry.method,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
    });
    if (scanned) accepted.push({ entry, ...scanned });
  }
  scanner.finish();
  return { scanner, accepted };
}

async function analyze(file: File, limits: ArchiveLimits): Promise<ArchiveAnalysis> {
  let entries: ZipEntry[];
  try {
    entries = await readCentralDirectory(file);
  } catch {
    return emptyAnalysis('not_a_zip', file.size);
  }
  const { scanner, accepted } = scan(entries, limits);
  const files = new Map<string, number>();
  const indexHtml = new Map<string, string>();
  let directoryCount = 0;
  for (const item of accepted) {
    if (item.isDirectory) {
      directoryCount += 1;
      continue;
    }
    if (isJunkPath(item.path)) continue;
    files.set(item.path, item.size);
    if (isIndexCandidate(item.path)) {
      try {
        indexHtml.set(item.path, await readEntryText(file, item.entry, INDEX_HTML_MAX_BYTES));
      } catch {
        return emptyAnalysis('not_a_zip', file.size);
      }
    }
  }
  return summarizeArchive({
    files,
    directoryCount,
    indexHtml,
    fileName: file.name,
    compressedBytes: file.size,
    declaredUncompressed: scanner.declaredUncompressed,
    issues: scanner.issues,
  });
}

interface SyncHandle {
  write(buffer: BufferSource, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

/**
 * Schreibt Abschnitte in eine OPFS-Datei – bevorzugt über einen synchronen Zugriff (schnell, Safari ≥ 16.4),
 * sonst über einen schreibbaren Stream. Jeder Abschnitt wird vor dem nächsten vollständig geschrieben.
 */
async function writeChunks(handle: FileSystemFileHandle, chunks: AsyncIterable<Uint8Array>, onChunk: (n: number) => void): Promise<void> {
  const createSync = (handle as unknown as { createSyncAccessHandle?: () => Promise<SyncHandle> }).createSyncAccessHandle;
  if (typeof createSync === 'function') {
    const access = await createSync.call(handle);
    try {
      access.truncate(0);
      let offset = 0;
      for await (const chunk of chunks) {
        let written = 0;
        while (written < chunk.byteLength) written += access.write(chunk.subarray(written) as Uint8Array<ArrayBuffer>, { at: offset + written });
        offset += chunk.byteLength;
        onChunk(chunk.byteLength);
      }
      access.flush();
    } finally {
      access.close();
    }
    return;
  }
  const writable = await (handle as unknown as { createWritable: () => Promise<FileSystemWritableFileStream> }).createWritable();
  try {
    for await (const chunk of chunks) {
      // Kopie, weil der Lesepuffer im nächsten Schritt wiederverwendet wird.
      await writable.write(chunk.slice());
      onChunk(chunk.byteLength);
    }
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

async function install(id: number, file: File, gameId: string, rootPrefix: string, limits: ArchiveLimits): Promise<void> {
  const entries = await readCentralDirectory(file);
  const { scanner, accepted } = scan(entries, limits);
  const firstError = scanner.firstError();
  if (firstError) throw new ZipFormatError(firstError);

  const root = await gameDirectory(gameId, true);
  const dirs = new Map<string, FileSystemDirectoryHandle>([['', root]]);
  const ensureDir = async (relativeDir: string): Promise<FileSystemDirectoryHandle> => {
    const cached = dirs.get(relativeDir);
    if (cached) return cached;
    const slash = relativeDir.lastIndexOf('/');
    const parent = await ensureDir(slash >= 0 ? relativeDir.slice(0, slash) : '');
    const handle = await parent.getDirectoryHandle(relativeDir.slice(slash + 1), { create: true });
    dirs.set(relativeDir, handle);
    return handle;
  };

  let bytesWritten = 0;
  let filesWritten = 0;
  let lastReport = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (force || now - lastReport > 120) {
      lastReport = now;
      post({ type: 'progress', id, bytesWritten, filesWritten });
    }
  };

  for (const item of accepted) {
    if (cancelled.has(id)) throw new DOMException('cancelled', 'AbortError');
    if (isJunkPath(item.path)) continue;
    if (rootPrefix && !item.path.startsWith(rootPrefix)) continue;
    const relative = rootPrefix ? item.path.slice(rootPrefix.length) : item.path;
    if (!relative) continue;
    if (item.isDirectory) {
      await ensureDir(relative);
      continue;
    }
    if (isExecutablePath(relative)) continue;
    const slash = relative.lastIndexOf('/');
    const dir = await ensureDir(slash >= 0 ? relative.slice(0, slash) : '');
    const handle = await dir.getFileHandle(relative.slice(slash + 1), { create: true });
    await writeChunks(handle, readEntryChunks(file, item.entry), (n) => {
      bytesWritten += n;
      if (bytesWritten > limits.maxUncompressedBytes) throw new ZipFormatError('too_large_uncompressed');
      report();
    });
    filesWritten += 1;
  }
  report(true);
  post({ type: 'installed', id, bytesWritten, filesWritten });
}

function errorCode(error: unknown): WorkerErrorCode {
  const name = (error as { name?: string })?.name ?? '';
  if (name === 'AbortError') return 'aborted';
  if (name === 'QuotaExceededError' || /quota/i.test(String((error as Error)?.message))) return 'insufficient_storage';
  if (name === 'SecurityError' || name === 'NotAllowedError') return 'storage_unavailable';
  if (error instanceof ZipFormatError || error instanceof TypeError) return 'archive_invalid';
  return 'internal';
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type === 'cancel') {
    cancelled.add(msg.id);
    return;
  }
  if (msg.type === 'analyze') {
    analyze(msg.file, msg.limits).then(
      (analysis) => post({ type: 'analysis', id: msg.id, analysis }),
      (error: unknown) => post({ type: 'error', id: msg.id, code: errorCode(error), detail: String((error as Error)?.message ?? error) }),
    );
    return;
  }
  install(msg.id, msg.file, msg.gameId, msg.rootPrefix, msg.limits).catch((error: unknown) =>
    post({ type: 'error', id: msg.id, code: errorCode(error), detail: String((error as Error)?.message ?? error) }),
  );
};
