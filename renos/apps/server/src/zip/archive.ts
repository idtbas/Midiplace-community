import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import {
  EntryScanner,
  INDEX_HTML_MAX_BYTES,
  emptyAnalysis,
  isExecutablePath,
  isIndexCandidate,
  isJunkPath,
  summarizeArchive,
  type AnalysisIssueCode,
  type ArchiveAnalysis,
  type ArchiveLimits,
  type ScannedEntry,
} from '@renos/shared';
import { resolveInside } from './paths.js';

export { titleFromHtml } from '@renos/shared';
export type { ArchiveLimits };

class ArchiveError extends Error {
  constructor(readonly code: AnalysisIssueCode) {
    super(code);
  }
}

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
 * Liest alle Einträge nacheinander und prüft sie mit dem gemeinsamen `EntryScanner`
 * (Pfade, Symlinks, Verschlüsselung, Kompression, Zip-Bomb-Verhältnis, Duplikate).
 */
async function walkArchive(
  file: string,
  scanner: EntryScanner,
  onEntry: (zip: ZipFile, entry: Entry, scanned: ScannedEntry) => Promise<void> | void,
): Promise<void> {
  let zip: ZipFile;
  try {
    zip = await openZip(file);
  } catch {
    throw new ArchiveError('not_a_zip');
  }
  if (!scanner.checkEntryCount(zip.entryCount)) {
    zip.close();
    return;
  }
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
            scanner.addIssue('invalid_filename', 'error');
            zip.readEntry();
            return;
          }
          const scanned = scanner.accept({
            name,
            externalFileAttributes: entry.externalFileAttributes,
            encrypted: entry.isEncrypted(),
            compressionMethod: entry.compressionMethod,
            compressedSize: entry.compressedSize,
            uncompressedSize: entry.uncompressedSize,
          });
          if (!scanned) {
            zip.readEntry();
            return;
          }
          try {
            await onEntry(zip, entry, scanned);
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
  scanner.finish();
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

/** Analysiert ein ZIP-Archiv, ohne Dateien zu entpacken. */
export async function analyzeArchive(file: string, fileName: string, compressedBytes: number, limits: ArchiveLimits): Promise<ArchiveAnalysis> {
  const scanner = new EntryScanner(limits);
  const files = new Map<string, number>();
  const indexHtml = new Map<string, string>();
  let directoryCount = 0;
  try {
    await walkArchive(file, scanner, async (zip, entry, scanned) => {
      if (scanned.isDirectory) {
        directoryCount += 1;
        return;
      }
      if (isJunkPath(scanned.path)) return;
      files.set(scanned.path, scanned.size);
      if (isIndexCandidate(scanned.path)) indexHtml.set(scanned.path, await readEntryText(zip, entry, INDEX_HTML_MAX_BYTES));
    });
  } catch (error) {
    return emptyAnalysis(error instanceof ArchiveError ? error.code : 'not_a_zip', compressedBytes);
  }
  return summarizeArchive({
    files,
    directoryCount,
    indexHtml,
    fileName,
    compressedBytes,
    declaredUncompressed: scanner.declaredUncompressed,
    issues: scanner.issues,
  });
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
  const scanner = new EntryScanner(limits);
  const progress: ExtractProgress = { bytesWritten: 0, filesWritten: 0 };
  let lastReport = 0;

  await walkArchive(file, scanner, async (zip, entry, scanned) => {
    if (signal?.aborted) throw new Error('aborted');
    const firstError = scanner.firstError();
    if (firstError) throw new ArchiveError(firstError);
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
    const declared = entry.uncompressedSize;
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
    const source = await openReadStream(zip, entry);
    // `wx`: niemals eine vorhandene Datei überschreiben.
    await pipeline(source, counter, createWriteStream(target, { flags: 'wx', mode: 0o644 }), signal ? { signal } : {});
    progress.filesWritten += 1;
  });

  const firstError = scanner.firstError();
  if (firstError) throw new ArchiveError(firstError);
  onProgress({ ...progress });
  return progress;
}

export { ArchiveError };
