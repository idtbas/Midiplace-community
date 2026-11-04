/**
 * Sicherheitsregeln und Klassifizierung für Spielarchive.
 *
 * Dieses Modul ist umgebungsneutral: Der Server (Node) und RenOS im Browser (lokale Installation
 * auf dem iPad) verwenden exakt dieselben Prüfungen.
 */
import type { AnalysisIssue, AnalysisIssueCode, ArchiveAnalysis, ArchiveCheck, ArchiveKind } from './index.js';
import { sanitizeTitle } from './text.js';

export interface ArchiveLimits {
  maxEntries: number;
  maxUncompressedBytes: number;
  maxCompressionRatio: number;
}

export const MAX_PATH_LENGTH = 1024;
export const MAX_SEGMENT_BYTES = 255;
export const MAX_DEPTH = 32;
export const MAX_ISSUES_PER_CODE = 5;
export const RATIO_MIN_BYTES = 1024 * 1024;
export const INDEX_HTML_MAX_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Pfade
// ---------------------------------------------------------------------------

export type PathCheck =
  | { ok: true; path: string; isDirectory: boolean }
  | { ok: false; code: Extract<AnalysisIssueCode, 'absolute_path' | 'path_traversal' | 'invalid_filename' | 'unsafe_path'> };

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function utf8Length(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Prüft einen Archivpfad. Jede Regel schützt vor einem konkreten Angriff:
 * absolute Pfade und `..` (Zip Slip), Steuerzeichen, leere Segmente, überlange Namen.
 */
export function checkEntryPath(rawName: string): PathCheck {
  if (rawName.length === 0 || rawName.length > MAX_PATH_LENGTH) return { ok: false, code: 'invalid_filename' };
  if (CONTROL_CHARS.test(rawName)) return { ok: false, code: 'invalid_filename' };
  if (rawName.includes('\\')) return { ok: false, code: 'unsafe_path' };
  if (rawName.startsWith('/') || /^[a-zA-Z]:/.test(rawName)) return { ok: false, code: 'absolute_path' };

  const name = rawName.normalize('NFC');
  const isDirectory = name.endsWith('/');
  const trimmed = isDirectory ? name.slice(0, -1) : name;
  if (trimmed.length === 0) return { ok: false, code: 'invalid_filename' };

  const segments = trimmed.split('/');
  if (segments.length > MAX_DEPTH) return { ok: false, code: 'unsafe_path' };
  for (const segment of segments) {
    if (segment === '..') return { ok: false, code: 'path_traversal' };
    if (segment === '' || segment === '.') return { ok: false, code: 'unsafe_path' };
    if (utf8Length(segment) > MAX_SEGMENT_BYTES) return { ok: false, code: 'invalid_filename' };
  }
  return { ok: true, path: segments.join('/'), isDirectory };
}

/** Dateien, die Betriebssysteme beim Packen hinzufügen; sie werden ignoriert. */
export function isJunkPath(p: string): boolean {
  if (p === '__MACOSX' || p.startsWith('__MACOSX/')) return true;
  const base = p.split('/').pop() ?? '';
  return base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini' || base.startsWith('._');
}

const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'dll', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs',
  'sh', 'so', 'dylib', 'apk', 'aab', 'ipa', 'jar', 'deb', 'rpm', 'appimage',
]);

/** Ausführbare Programme (z. B. Windows-EXE) werden niemals installiert. */
export function isExecutablePath(p: string): boolean {
  const lower = p.toLowerCase();
  if (/(^|\/)[^/]+\.app\//.test(lower)) return true;
  const base = lower.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 && EXECUTABLE_EXTENSIONS.has(base.slice(dot + 1));
}

/** Unix-Dateityp aus den externen Attributen eines ZIP-Eintrags. */
export function unixFileType(externalFileAttributes: number): 'file' | 'directory' | 'symlink' | 'special' | 'unknown' {
  const mode = (externalFileAttributes >>> 16) & 0o170000;
  if (mode === 0) return 'unknown';
  if (mode === 0o100000) return 'file';
  if (mode === 0o040000) return 'directory';
  if (mode === 0o120000) return 'symlink';
  return 'special';
}

// ---------------------------------------------------------------------------
// Eintrags-Scanner
// ---------------------------------------------------------------------------

export interface RawEntry {
  name: string;
  externalFileAttributes: number;
  encrypted: boolean;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
}

export interface ScannedEntry {
  path: string;
  isDirectory: boolean;
  size: number;
}

/**
 * Prüft die Einträge eines Archivs nacheinander und sammelt Befunde.
 * `accept` liefert einen bereinigten Eintrag oder null (Eintrag verworfen, Befund notiert).
 */
export class EntryScanner {
  readonly issues: AnalysisIssue[] = [];
  declaredUncompressed = 0;
  private readonly counts = new Map<AnalysisIssueCode, number>();
  private readonly seenFiles = new Set<string>();
  private readonly seenDirs = new Set<string>();

  constructor(private readonly limits: ArchiveLimits) {}

  addIssue(code: AnalysisIssueCode, severity: AnalysisIssue['severity'], path?: string): void {
    const n = this.counts.get(code) ?? 0;
    this.counts.set(code, n + 1);
    if (n < MAX_ISSUES_PER_CODE) this.issues.push(path === undefined ? { code, severity } : { code, severity, path: path.slice(0, 200) });
  }

  hasErrors(): boolean {
    return this.issues.some((i) => i.severity === 'error');
  }

  firstError(): AnalysisIssueCode | null {
    return this.issues.find((i) => i.severity === 'error')?.code ?? null;
  }

  /** Prüft die Anzahl der Einträge vorab (aus dem Inhaltsverzeichnis). */
  checkEntryCount(count: number): boolean {
    if (count > this.limits.maxEntries) {
      this.addIssue('too_many_entries', 'error');
      return false;
    }
    return true;
  }

  accept(raw: RawEntry): ScannedEntry | null {
    const check = checkEntryPath(raw.name);
    if (!check.ok) {
      this.addIssue(check.code, 'error', raw.name);
      return null;
    }
    const type = unixFileType(raw.externalFileAttributes);
    if (type === 'symlink') {
      this.addIssue('symlink', 'error', check.path);
      return null;
    }
    if (type === 'special') {
      this.addIssue('unsafe_path', 'error', check.path);
      return null;
    }
    const isDirectory = check.isDirectory || type === 'directory';
    if (!isDirectory) {
      if (raw.encrypted) {
        this.addIssue('encrypted_entry', 'error', check.path);
        return null;
      }
      if (raw.compressionMethod !== 0 && raw.compressionMethod !== 8) {
        this.addIssue('unsupported_compression', 'error', check.path);
        return null;
      }
      this.declaredUncompressed += raw.uncompressedSize;
      if (raw.uncompressedSize > RATIO_MIN_BYTES && raw.uncompressedSize / Math.max(raw.compressedSize, 1) > this.limits.maxCompressionRatio) {
        this.addIssue('suspicious_ratio', 'error', check.path);
      }
    }
    // Doppelte Einträge (auch nur in Groß-/Kleinschreibung verschieden) und Konflikte zwischen
    // Datei und Ordner gleichen Namens würden beim Entpacken zu Überschreibungen führen.
    const key = check.path.toLowerCase();
    if (isDirectory) {
      if (this.seenFiles.has(key)) {
        this.addIssue('duplicate_entry', 'error', check.path);
        return null;
      }
      this.seenDirs.add(key);
    } else {
      if (this.seenFiles.has(key) || this.seenDirs.has(key)) {
        this.addIssue('duplicate_entry', 'error', check.path);
        return null;
      }
      const segments = key.split('/');
      for (let i = 1; i < segments.length; i += 1) {
        const parent = segments.slice(0, i).join('/');
        if (this.seenFiles.has(parent)) {
          this.addIssue('duplicate_entry', 'error', check.path);
          return null;
        }
        this.seenDirs.add(parent);
      }
      this.seenFiles.add(key);
    }
    return { path: check.path, isDirectory, size: isDirectory ? 0 : raw.uncompressedSize };
  }

  finish(): void {
    if (this.declaredUncompressed > this.limits.maxUncompressedBytes) this.addIssue('too_large_uncompressed', 'error');
  }
}

// ---------------------------------------------------------------------------
// Klassifizierung
// ---------------------------------------------------------------------------

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

export function titleFromFileName(fileName: string): string | null {
  const base = fileName.replace(/\.zip$/i, '').replace(/[-_]web$/i, '').replace(/[-_]+/g, ' ');
  const title = sanitizeTitle(base, '');
  return title || null;
}

/** Wurzel des Web-Builds: Archivwurzel oder genau ein gemeinsamer übergeordneter Ordner. */
export function findRootPrefix(files: Iterable<string>): string {
  const list = [...files];
  if (list.includes('index.html')) return '';
  const topLevel = new Set<string>();
  for (const f of list) topLevel.add(f.includes('/') ? f.slice(0, f.indexOf('/') + 1) : f);
  if (topLevel.size === 1) {
    const [only] = [...topLevel];
    if (only && only.endsWith('/')) return only;
  }
  return '';
}

/** Soll diese Datei gelesen werden, um den Titel zu ermitteln? */
export function isIndexCandidate(path: string): boolean {
  return path.endsWith('index.html') && path.split('/').length <= 2;
}

export interface ArchiveSummaryInput {
  /** Gültige Dateien (ohne Junk) mit entpackter Größe. */
  files: Map<string, number>;
  directoryCount: number;
  /** Inhalt der index.html (Wurzel oder erster Unterordner), falls gelesen. */
  indexHtml: Map<string, string>;
  fileName: string;
  compressedBytes: number;
  declaredUncompressed: number;
  issues: AnalysisIssue[];
}

export function summarizeArchive(input: ArchiveSummaryInput): ArchiveAnalysis {
  const { files, issues } = input;
  const rootPrefix = findRootPrefix(files.keys());
  const rel = (p: string): string | null => (rootPrefix ? (p.startsWith(rootPrefix) ? p.slice(rootPrefix.length) : null) : p);
  const inRoot = new Set<string>();
  for (const f of files.keys()) {
    const r = rel(f);
    if (r !== null) inRoot.add(r);
  }

  const hasEntry = inRoot.has('index.html');
  const hasRuntime = inRoot.has('renpy.js') && inRoot.has('renpy.wasm');
  const legacy = inRoot.has('pythonhome.data') || inRoot.has('pythonhome-data.js');
  const hasGameData = inRoot.has('game.zip') || inRoot.has('game.data');
  const presplash = ['web-presplash.jpg', 'web-presplash.png', 'web-presplash.webp'].find((p) => inRoot.has(p)) ?? null;

  const allLower = [...files.keys()].map((f) => f.toLowerCase());
  const hasRpy = allLower.some((f) => /(^|\/)game\/.*\.(rpy|rpyc|rpa|rpym)$/.test(f));
  const hasEngineDir = allLower.some((f) => /(^|\/)renpy\/[^/]+\.(py|pyc|pyo)$/.test(f) || /(^|\/)renpy\/common\//.test(f));
  const hasDesktopLauncher = allLower.some(
    (f) => /(^|\/)lib\/py\d?-(windows|linux|mac)/.test(f) || /\.exe$/.test(f) || /(^|\/)[^/]+\.app\/contents\//.test(f) || /(^|\/)[^/]+\.sh$/.test(f),
  );

  let kind: ArchiveKind;
  if (hasEntry && hasRuntime) kind = 'renpy-web';
  else if (hasRpy && (hasDesktopLauncher || hasEngineDir)) kind = 'renpy-desktop';
  else if (hasRpy) kind = 'renpy-project';
  else kind = 'unknown';

  const executables = [...files.keys()].filter(isExecutablePath);
  if (files.size === 0) issues.push({ code: 'empty_archive', severity: 'error' });
  if (kind === 'renpy-web') {
    if (!hasGameData) issues.push({ code: 'missing_game_data', severity: 'error' });
    for (const exe of executables.slice(0, MAX_ISSUES_PER_CODE)) issues.push({ code: 'executable_content', severity: 'warning', path: exe });
  } else if (kind === 'unknown' && files.size > 0) {
    if (!hasEntry) issues.push({ code: 'missing_entry_point', severity: 'info' });
    if (!hasRuntime) issues.push({ code: 'missing_runtime', severity: 'info' });
    if (files.size === 1 && allLower[0]?.endsWith('.zip')) issues.push({ code: 'nested_archive_only', severity: 'info', path: [...files.keys()][0] ?? '' });
  }

  let uncompressedInRoot = 0;
  let filesInRoot = 0;
  for (const [f, size] of files) {
    if (rel(f) === null || isExecutablePath(f)) continue;
    uncompressedInRoot += size;
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

  const indexHtml = input.indexHtml.get(`${rootPrefix}index.html`) ?? [...input.indexHtml.values()][0] ?? '';
  return {
    kind,
    installable: kind === 'renpy-web' && !hasError,
    rootPrefix,
    entryPoint: hasEntry ? 'index.html' : null,
    fileCount: kind === 'renpy-web' ? filesInRoot : files.size,
    directoryCount: input.directoryCount,
    compressedBytes: input.compressedBytes,
    uncompressedBytes: kind === 'renpy-web' ? uncompressedInRoot : input.declaredUncompressed,
    detectedTitle:
      (indexHtml ? titleFromHtml(indexHtml) : null) ??
      (rootPrefix ? titleFromFileName(rootPrefix.slice(0, -1)) : null) ??
      titleFromFileName(input.fileName),
    presplash,
    runtime: hasRuntime ? (legacy ? 'legacy' : 'wasm') : null,
    checks,
    issues,
  };
}

export function emptyAnalysis(code: AnalysisIssueCode, compressedBytes: number): ArchiveAnalysis {
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

/** MIME-Typen für Spieldateien (`.wasm` muss `application/wasm` sein). */
export const GAME_MIME_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  wasm: 'application/wasm',
  data: 'application/octet-stream',
  zip: 'application/zip',
  symbols: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

export function gameMimeType(path: string): string {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return (dot >= 0 && GAME_MIME_TYPES[base.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}
