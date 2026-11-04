import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import type { AnalysisIssue, AnalysisIssueCode, ArchiveAnalysis, ArchiveCheck, ArchiveKind } from '@renos/shared';
import { sanitizeTitle } from '@renos/shared';
import { checkEntryPath, isExecutablePath, isJunkPath, resolveInside, unixFileType } from './paths.js';

export interface ArchiveLimits {
  maxEntries: number;
  maxUncompressedBytes: number;
  maxCompressionRatio: number;
}

/** Ein geprüfter Archiveintrag. */
interface ScannedEntry {
  entry: Entry;
  path: string;
  isDirectory: boolean;
}

class ArchiveError extends Error {
  constructor(readonly code: AnalysisIssueCode) {
    super(code);
  }
}

const MAX_ISSUES_PER_CODE = 5;
const RATIO_MIN_BYTES = 1024 * 1024;
const INDEX_HTML_MAX_BYTES = 512 * 1024;

function openZip(file: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      file,
      { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true, strictFileNames: false },
      (error, zip) => (error || !zip ? reject(error ?? new Error('zip')) : resolve(zip)),
    );
  });
}

function decodeName(entry: Entry): string {
  const raw = entry.fileName as unknown as Buffer;
  return yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, raw, entry.extraFields, false);
}

function openReadStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => (error || !stream ? reject(error ?? new Error('stream')) : resolve(stream)));
  });
}

/**
 * Liest alle Einträge des Archivs nacheinander und ruft `onEntry` für jeden gültigen Eintrag auf.
 * Strukturelle Probleme (Pfade, Symlinks, Verschlüsselung …) werden als Issues gesammelt.
 */
async function walkArchive(
  file: string,
  limits: ArchiveLimits,
  issues: AnalysisIssue[],
  onEntry: (zip: ZipFile, scanned: ScannedEntry) => Promise<void> | void,
): Promise<{ entryCount: number; declaredUncompressed: number }> {
  let zip: ZipFile;
  try {
    zip = await openZip(file);
  } catch {
    throw new ArchiveError('not_a_zip');
  }

  const counts = new Map<AnalysisIssueCode, number>();
  const addIssue = (code: AnalysisIssueCode, severity: AnalysisIssue['severity'], p?: string) => {
    const n = counts.get(code) ?? 0;
    counts.set(code, n + 1);
    if (n < MAX_ISSUES_PER_CODE) issues.push(p === undefined ? { code, severity } : { code, severity, path: p.slice(0, 200) });
  };

  if (zip.entryCount > limits.maxEntries) {
    zip.close();
    addIssue('too_many_entries', 'error');
    return { entryCount: zip.entryCount, declaredUncompressed: 0 };
  }

  const seenFiles = new Set<string>();
  const seenDirs = new Set<string>();
  let declaredUncompressed = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', (error: Error) => reject(error));
      zip.on('end', () => resolve());
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          let name: string;
          try {
            name = decodeName(entry);
          } catch {
            addIssue('invalid_filename', 'error');
            zip.readEntry();
            return;
          }
          const check = checkEntryPath(name);
          if (!check.ok) {
            addIssue(check.code, 'error', name);
            zip.readEntry();
            return;
          }
          const type = unixFileType(entry.externalFileAttributes);
          if (type === 'symlink') {
            addIssue('symlink', 'error', check.path);
            zip.readEntry();
            return;
          }
          if (type === 'special') {
            addIssue('unsafe_path', 'error', check.path);
            zip.readEntry();
            return;
          }
          const isDirectory = check.isDirectory || type === 'directory';
          if (!isDirectory) {
            if (entry.isEncrypted()) {
              addIssue('encrypted_entry', 'error', check.path);
              zip.readEntry();
              return;
            }
            if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
              addIssue('unsupported_compression', 'error', check.path);
              zip.readEntry();
              return;
            }
            declaredUncompressed += entry.uncompressedSize;
            if (
              entry.uncompressedSize > RATIO_MIN_BYTES &&
              entry.uncompressedSize / Math.max(entry.compressedSize, 1) > limits.maxCompressionRatio
            ) {
              addIssue('suspicious_ratio', 'error', check.path);
            }
          }
          // Doppelte Einträge (auch nur in Groß-/Kleinschreibung verschieden) und Konflikte zwischen
          // Datei und Ordner gleichen Namens würden beim Entpacken zu Überschreibungen führen.
          const key = check.path.toLowerCase();
          if (isDirectory) {
            if (seenFiles.has(key)) {
              addIssue('duplicate_entry', 'error', check.path);
              zip.readEntry();
              return;
            }
            seenDirs.add(key);
          } else {
            if (seenFiles.has(key) || seenDirs.has(key)) {
              addIssue('duplicate_entry', 'error', check.path);
              zip.readEntry();
              return;
            }
            const segments = key.split('/');
            for (let i = 1; i < segments.length; i += 1) {
              const parent = segments.slice(0, i).join('/');
              if (seenFiles.has(parent)) {
                addIssue('duplicate_entry', 'error', check.path);
                zip.readEntry();
                return;
              }
              seenDirs.add(parent);
            }
            seenFiles.add(key);
          }
          try {
            await onEntry(zip, { entry, path: check.path, isDirectory });
            zip.readEntry();
          } catch (error) {
            reject(error);
          }
        })();
      });
      zip.readEntry();
    });
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    // yauzl meldet beschädigte Archive (z. B. falsche Größenangaben) als Fehler.
    throw new ArchiveError('not_a_zip');
  } finally {
    zip.close();
  }

  if (declaredUncompressed > limits.maxUncompressedBytes) addIssue('too_large_uncompressed', 'error');
  return { entryCount: zip.entryCount, declaredUncompressed };
}

async function readEntryText(zip: ZipFile, entry: Entry, maxBytes: number): Promise<string> {
  if (entry.uncompressedSize > maxBytes) return '';
  const stream = await openReadStream(zip, entry);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function titleFromHtml(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match?.[1]) return null;
  const title = sanitizeTitle(decodeHtmlEntities(match[1]), '');
  if (!title || /^ren'?py web game$/i.test(title)) return null;
  return title;
}

function titleFromFileName(fileName: string): string | null {
  const base = fileName.replace(/\.zip$/i, '').replace(/[-_]web$/i, '').replace(/[-_]+/g, ' ');
  const title = sanitizeTitle(base, '');
  return title || null;
}

/**
 * Bestimmt den Ordner, in dem der Web-Build liegt: entweder die Archivwurzel oder genau ein
 * gemeinsamer übergeordneter Ordner (z. B. `MeinSpiel-1.0-web/`).
 */
function findRootPrefix(files: Set<string>): string {
  if (files.has('index.html')) return '';
  const topLevel = new Set<string>();
  for (const f of files) topLevel.add(f.includes('/') ? f.slice(0, f.indexOf('/') + 1) : f);
  if (topLevel.size === 1) {
    const [only] = [...topLevel];
    if (only && only.endsWith('/')) return only;
  }
  return '';
}

export interface AnalyzeResult {
  analysis: ArchiveAnalysis;
}

/** Analysiert ein ZIP-Archiv, ohne Dateien zu entpacken. */
export async function analyzeArchive(file: string, fileName: string, compressedBytes: number, limits: ArchiveLimits): Promise<ArchiveAnalysis> {
  const issues: AnalysisIssue[] = [];
  const files = new Set<string>();
  const fileSizes = new Map<string, number>();
  let directoryCount = 0;
  let indexHtml = '';
  let indexCandidates: string[] = [];
  const executables: string[] = [];

  let walk: { entryCount: number; declaredUncompressed: number };
  try {
    walk = await walkArchive(file, limits, issues, async (zip, scanned) => {
      if (scanned.isDirectory) {
        directoryCount += 1;
        return;
      }
      if (isJunkPath(scanned.path)) return;
      files.add(scanned.path);
      fileSizes.set(scanned.path, scanned.entry.uncompressedSize);
      if (isExecutablePath(scanned.path)) executables.push(scanned.path);
      // index.html der Wurzel oder des ersten Unterordners für die Titelerkennung lesen.
      const depth = scanned.path.split('/').length;
      if (scanned.path.endsWith('index.html') && depth <= 2) {
        indexCandidates.push(scanned.path);
        const text = await readEntryText(zip, scanned.entry, INDEX_HTML_MAX_BYTES);
        if (depth === 1 || !indexHtml) indexHtml = text;
      }
    });
  } catch (error) {
    const code = error instanceof ArchiveError ? error.code : 'not_a_zip';
    return emptyAnalysis(code, compressedBytes);
  }

  // Nicht unterstützte Dateien sind für Web-Builds irrelevant und werden nie installiert.
  const rootPrefix = findRootPrefix(files);
  const rel = (p: string) => (rootPrefix && p.startsWith(rootPrefix) ? p.slice(rootPrefix.length) : rootPrefix ? null : p);
  const inRoot = new Set<string>();
  for (const f of files) {
    const r = rel(f);
    if (r !== null) inRoot.add(r);
  }
  indexCandidates = indexCandidates.filter((c) => c === `${rootPrefix}index.html`);

  const hasEntry = inRoot.has('index.html');
  const hasRuntime = inRoot.has('renpy.js') && inRoot.has('renpy.wasm');
  const legacy = inRoot.has('pythonhome.data') || inRoot.has('pythonhome-data.js');
  const hasGameData = inRoot.has('game.zip') || inRoot.has('game.data');
  const presplash = ['web-presplash.jpg', 'web-presplash.png', 'web-presplash.webp'].find((p) => inRoot.has(p)) ?? null;

  const allLower = [...files].map((f) => f.toLowerCase());
  const hasRpy = allLower.some((f) => /(^|\/)game\/.*\.(rpy|rpyc|rpa|rpym)$/.test(f));
  const hasEngineDir = allLower.some((f) => /(^|\/)renpy\/[^/]+\.(py|pyc|pyo)$/.test(f) || /(^|\/)renpy\/common\//.test(f));
  const hasDesktopLauncher = allLower.some(
    (f) =>
      /(^|\/)lib\/py\d?-(windows|linux|mac)/.test(f) ||
      /\.exe$/.test(f) ||
      /(^|\/)[^/]+\.app\/contents\//.test(f) ||
      /(^|\/)[^/]+\.sh$/.test(f),
  );

  let kind: ArchiveKind;
  if (hasEntry && hasRuntime) kind = 'renpy-web';
  else if (hasRpy && (hasDesktopLauncher || hasEngineDir)) kind = 'renpy-desktop';
  else if (hasRpy) kind = 'renpy-project';
  else kind = 'unknown';

  if (files.size === 0) issues.push({ code: 'empty_archive', severity: 'error' });
  if (kind === 'renpy-web') {
    if (!hasGameData) issues.push({ code: 'missing_game_data', severity: 'error' });
    if (executables.length > 0) {
      for (const exe of executables.slice(0, MAX_ISSUES_PER_CODE)) {
        issues.push({ code: 'executable_content', severity: 'warning', path: exe });
      }
    }
  } else if (kind === 'unknown' && files.size > 0) {
    if (!hasEntry) issues.push({ code: 'missing_entry_point', severity: 'info' });
    if (!hasRuntime) issues.push({ code: 'missing_runtime', severity: 'info' });
    const onlyZip = files.size === 1 && allLower[0]?.endsWith('.zip');
    if (onlyZip) issues.push({ code: 'nested_archive_only', severity: 'info', path: [...files][0] ?? '' });
  }

  let uncompressedInRoot = 0;
  let filesInRoot = 0;
  for (const f of files) {
    if (rel(f) === null || isExecutablePath(f)) continue;
    uncompressedInRoot += fileSizes.get(f) ?? 0;
    filesInRoot += 1;
  }

  const hasError = issues.some((i) => i.severity === 'error');
  const pathCodes: AnalysisIssueCode[] = ['unsafe_path', 'absolute_path', 'path_traversal', 'invalid_filename', 'duplicate_entry', 'symlink'];
  const checks: ArchiveCheck[] = [
    { id: 'format', ok: !issues.some((i) => ['encrypted_entry', 'unsupported_compression', 'empty_archive'].includes(i.code)) },
    { id: 'size', ok: !issues.some((i) => i.code === 'too_large_uncompressed' || i.code === 'suspicious_ratio') },
    { id: 'entries', ok: !issues.some((i) => i.code === 'too_many_entries') },
    { id: 'paths', ok: !issues.some((i) => pathCodes.includes(i.code)) },
    { id: 'entry_point', ok: hasEntry },
    { id: 'runtime', ok: hasRuntime },
    { id: 'game_data', ok: hasGameData },
  ];

  return {
    kind,
    installable: kind === 'renpy-web' && !hasError,
    rootPrefix,
    entryPoint: hasEntry ? 'index.html' : null,
    fileCount: kind === 'renpy-web' ? filesInRoot : files.size,
    directoryCount,
    compressedBytes,
    uncompressedBytes: kind === 'renpy-web' ? uncompressedInRoot : walk.declaredUncompressed,
    detectedTitle: (indexHtml ? titleFromHtml(indexHtml) : null) ?? (rootPrefix ? titleFromFileName(rootPrefix.slice(0, -1)) : null) ?? titleFromFileName(fileName),
    presplash,
    runtime: hasRuntime ? (legacy ? 'legacy' : 'wasm') : null,
    checks,
    issues,
  };
}

function emptyAnalysis(code: AnalysisIssueCode, compressedBytes: number): ArchiveAnalysis {
  return {
    kind: 'unknown',
    installable: false,
    rootPrefix: '',
    entryPoint: null,
    fileCount: 0,
    directoryCount: 0,
    compressedBytes,
    uncompressedBytes: 0,
    detectedTitle: null,
    presplash: null,
    runtime: null,
    checks: [
      { id: 'format', ok: false },
      { id: 'size', ok: code !== 'too_large_uncompressed' },
      { id: 'entries', ok: code !== 'too_many_entries' },
      { id: 'paths', ok: true },
      { id: 'entry_point', ok: false },
      { id: 'runtime', ok: false },
      { id: 'game_data', ok: false },
    ],
    issues: [{ code, severity: 'error' }],
  };
}

export interface ExtractProgress {
  bytesWritten: number;
  filesWritten: number;
}

/**
 * Entpackt die Dateien unterhalb von `rootPrefix` in `destination` (einen frischen, leeren Staging-Ordner).
 * Alle Prüfungen der Analyse werden erneut angewendet; zusätzlich wird die tatsächliche Datenmenge gezählt,
 * sodass gefälschte Größenangaben (Zip-Bombs) den Vorgang abbrechen.
 */
export async function extractArchive(
  file: string,
  destination: string,
  rootPrefix: string,
  limits: ArchiveLimits,
  onProgress: (progress: ExtractProgress) => void,
  signal?: AbortSignal,
): Promise<ExtractProgress> {
  const issues: AnalysisIssue[] = [];
  const progress: ExtractProgress = { bytesWritten: 0, filesWritten: 0 };
  let lastReport = 0;

  await walkArchive(file, limits, issues, async (zip, scanned) => {
    if (signal?.aborted) throw new Error('aborted');
    if (issues.some((i) => i.severity === 'error')) throw new ArchiveError(issues[0]!.code);
    if (isJunkPath(scanned.path)) return;
    if (rootPrefix && !scanned.path.startsWith(rootPrefix)) return;
    const relative = rootPrefix ? scanned.path.slice(rootPrefix.length) : scanned.path;
    if (!relative) return;

    const target = resolveInside(destination, relative);
    if (!target) throw new ArchiveError('path_traversal');

    if (scanned.isDirectory) {
      await mkdir(target, { recursive: true, mode: 0o755 });
      return;
    }
    if (isExecutablePath(relative)) return;

    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    const declared = scanned.entry.uncompressedSize;
    let entryBytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        entryBytes += chunk.length;
        progress.bytesWritten += chunk.length;
        if (entryBytes > declared) return callback(new ArchiveError('suspicious_ratio'));
        if (progress.bytesWritten > limits.maxUncompressedBytes) return callback(new ArchiveError('too_large_uncompressed'));
        const now = Date.now();
        if (now - lastReport > 100) {
          lastReport = now;
          onProgress({ ...progress });
        }
        callback(null, chunk);
      },
    });
    const source = await openReadStream(zip, scanned.entry);
    // `wx`: niemals eine vorhandene Datei überschreiben.
    await pipeline(source, counter, createWriteStream(target, { flags: 'wx', mode: 0o644 }), signal ? { signal } : {});
    progress.filesWritten += 1;
  });

  if (issues.some((i) => i.severity === 'error')) throw new ArchiveError(issues[0]!.code);
  onProgress({ ...progress });
  return progress;
}

export { ArchiveError };
