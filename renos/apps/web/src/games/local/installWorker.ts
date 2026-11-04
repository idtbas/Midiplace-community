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
import { convertDesktopBuild, gameBytes, type ConvertReport } from './convert';
import { chooseGameRoot, detectPlatforms, detectPython, parseEngineVersion } from './desktop';
import { gameDirectory } from './opfs';
import { directoryMaker, writeChunks } from './opfsWrite';
import { downloadRuntime } from './runtimeDownload';
import type { RuntimeManifest } from './runtimes';
import { ZipFormatError, isEncrypted, readCentralDirectory, readEntryChunks, readEntryText, type ZipEntry } from './zipReader';

export type WorkerRequest =
  | { type: 'analyze'; id: number; file: File; limits: ArchiveLimits }
  | { type: 'install'; id: number; file: File; gameId: string; rootPrefix: string; limits: ArchiveLimits }
  | { type: 'convert'; id: number; file: File; gameId: string; root: string; title: string; runtimeId: string; limits: ArchiveLimits }
  | { type: 'runtime'; id: number; runtimeId: string; baseUrl: string }
  | { type: 'cancel'; id: number };

export type WorkerErrorCode = 'archive_invalid' | 'insufficient_storage' | 'aborted' | 'storage_unavailable' | 'runtime_unavailable' | 'runtime_corrupt' | 'internal';

export type WorkerResponse =
  | { type: 'analysis'; id: number; analysis: ArchiveAnalysis }
  | { type: 'progress'; id: number; bytesWritten: number; filesWritten: number }
  | { type: 'installed'; id: number; bytesWritten: number; filesWritten: number }
  | { type: 'converted'; id: number; report: ConvertReport }
  | { type: 'runtime-progress'; id: number; bytes: number; total: number }
  | { type: 'stage'; id: number; stage: 'scan'; done: number; total: number }
  | { type: 'runtime-ready'; id: number; manifest: RuntimeManifest }
  | { type: 'error'; id: number; code: WorkerErrorCode; detail?: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const cancelled = new Set<number>();

function post(message: WorkerResponse) {
  scope.postMessage(message);
}

type AcceptedItem = { entry: ZipEntry; path: string; isDirectory: boolean; size: number };

function scan(entries: ZipEntry[], limits: ArchiveLimits) {
  const scanner = new EntryScanner(limits);
  const accepted: AcceptedItem[] = [];
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
  const analysis = summarizeArchive({
    files,
    directoryCount,
    indexHtml,
    fileName: file.name,
    compressedBytes: file.size,
    declaredUncompressed: scanner.declaredUncompressed,
    issues: scanner.issues,
  });
  if (analysis.kind === 'renpy-desktop' || analysis.kind === 'renpy-project') {
    await describeConversion(file, analysis, accepted.filter((a) => !isJunkPath(a.path)));
  }
  return analysis;
}

const SMALL_TEXT = 256 * 1024;

/** Desktop-Build oder Projektordner: Spielordner, Engine-Version und Python-Generation bestimmen. */
async function describeConversion(file: File, analysis: ArchiveAnalysis, accepted: AcceptedItem[]): Promise<void> {
  const paths = accepted.filter((a) => !a.isDirectory).map((a) => a.path);
  const root = chooseGameRoot(paths);
  if (root === null) return;
  const byPath = new Map(accepted.map((a) => [a.path, a]));
  const text = async (path: string) => {
    const item = byPath.get(path);
    if (!item || item.isDirectory || item.size > SMALL_TEXT) return null;
    try {
      return await readEntryText(file, item.entry, SMALL_TEXT);
    } catch {
      return null;
    }
  };
  const { version, major } = parseEngineVersion(await text(`${root}renpy/vc_version.py`), await text(`${root}renpy/__init__.py`));
  const stats = gameBytes(accepted, root);
  const options = await text(`${root}game/options.rpy`);
  const configName = options && /config\.name\s*=\s*_?\(?\s*(?:u)?(["'])(.+?)\1/.exec(options);
  analysis.conversion = {
    root,
    engineVersion: version,
    python: detectPython(paths, root, major),
    platforms: detectPlatforms(paths, root),
    gameFiles: stats.files,
    gameBytes: stats.bytes,
    archives: stats.archives,
    archiveBytes: stats.archiveBytes,
  };
  analysis.installable = !analysis.issues.some((i) => i.severity === 'error');
  analysis.rootPrefix = root;
  analysis.fileCount = stats.files;
  analysis.uncompressedBytes = stats.bytes;
  const fromFolder = root
    .replace(/\/$/, '')
    .split('/')
    .filter((p) => p && !/^(contents|resources|autorun)$/i.test(p))
    .map((p) => p.replace(/\.app$/i, ''))[0];
  const cleaned = (fromFolder ?? '')
    .replace(/[-_ ]?(\d+(\.\d+)*[a-z]?)?[-_ ]?(pc|win|windows|linux|mac|market|dists?)?$/i, '')
    .replace(/[-_]+/g, ' ')
    // „TheQuestion“ → „The Question“ (Ordnernamen von Ren'Py-Builds sind oft zusammengeschrieben).
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  if (configName?.[2]) analysis.detectedTitle = configName[2].slice(0, 120);
  else if (cleaned) analysis.detectedTitle = cleaned.slice(0, 120);
}

async function install(id: number, file: File, gameId: string, rootPrefix: string, limits: ArchiveLimits): Promise<void> {
  const entries = await readCentralDirectory(file);
  const { scanner, accepted } = scan(entries, limits);
  const firstError = scanner.firstError();
  if (firstError) throw new ZipFormatError(firstError);

  const root = await gameDirectory(gameId, true);
  const { ensureDir } = directoryMaker(root);

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

async function convert(msg: Extract<WorkerRequest, { type: 'convert' }>): Promise<void> {
  const entries = await readCentralDirectory(msg.file);
  const { scanner, accepted } = scan(entries, msg.limits);
  const firstError = scanner.firstError();
  if (firstError) throw new ZipFormatError(firstError);
  const report = await convertDesktopBuild({
    file: msg.file,
    accepted: accepted.filter((a) => !isJunkPath(a.path)),
    gameId: msg.gameId,
    root: msg.root,
    title: msg.title,
    runtimeId: msg.runtimeId,
    maxBytes: msg.limits.maxUncompressedBytes,
    isCancelled: () => cancelled.has(msg.id),
    progress: (bytesWritten, filesWritten) => post({ type: 'progress', id: msg.id, bytesWritten, filesWritten }),
    stage: (stage, done, total) => post({ type: 'stage', id: msg.id, stage, done, total }),
  });
  post({ type: 'converted', id: msg.id, report });
}

function errorCode(error: unknown): WorkerErrorCode {
  const name = (error as { name?: string })?.name ?? '';
  const message = String((error as Error)?.message ?? '');
  if (message === 'runtime_unavailable' || message === 'runtime_invalid' || message === 'runtime_missing') return 'runtime_unavailable';
  if (message === 'runtime_corrupt') return 'runtime_corrupt';
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
  const fail = (error: unknown) => post({ type: 'error', id: msg.id, code: errorCode(error), detail: String((error as Error)?.message ?? error) });
  if (msg.type === 'runtime') {
    downloadRuntime(msg.runtimeId, msg.baseUrl, () => cancelled.has(msg.id), (bytes, total) => post({ type: 'runtime-progress', id: msg.id, bytes, total })).then(
      (manifest) => post({ type: 'runtime-ready', id: msg.id, manifest }),
      fail,
    );
    return;
  }
  if (msg.type === 'convert') {
    convert(msg).catch(fail);
    return;
  }
  install(msg.id, msg.file, msg.gameId, msg.rootPrefix, msg.limits).catch(fail);
};
