import path from 'node:path';
import type { AnalysisIssueCode } from '@renos/shared';

/**
 * Prüfung von Archivpfaden. Jede Regel hier schützt vor einem konkreten Angriff:
 * - absolute Pfade und Laufwerksbuchstaben → Schreiben außerhalb des Zielordners
 * - `..`-Segmente → Path Traversal / Zip Slip
 * - Steuerzeichen, leere Segmente, überlange Namen → ungültige oder verwirrende Dateinamen
 */

export const MAX_PATH_LENGTH = 1024;
export const MAX_SEGMENT_BYTES = 255;
export const MAX_DEPTH = 32;

export type PathCheck =
  | { ok: true; path: string; isDirectory: boolean }
  | { ok: false; code: Extract<AnalysisIssueCode, 'absolute_path' | 'path_traversal' | 'invalid_filename' | 'unsafe_path'> };

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

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
    if (Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_BYTES) return { ok: false, code: 'invalid_filename' };
  }
  return { ok: true, path: segments.join('/'), isDirectory };
}

/** Dateien, die von Betriebssystemen beim Packen hinzugefügt werden und ignoriert werden. */
export function isJunkPath(p: string): boolean {
  if (p === '__MACOSX' || p.startsWith('__MACOSX/')) return true;
  const base = p.split('/').pop() ?? '';
  return base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini' || base.startsWith('._');
}

const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.dll', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs',
  '.sh', '.so', '.dylib', '.apk', '.aab', '.ipa', '.jar', '.deb', '.rpm', '.appimage',
]);

/** Ausführbare Programme (z. B. Windows-EXE) werden niemals installiert. */
export function isExecutablePath(p: string): boolean {
  const lower = p.toLowerCase();
  if (/(^|\/)[^/]+\.app\//.test(lower)) return true;
  return EXECUTABLE_EXTENSIONS.has(path.posix.extname(lower));
}

/**
 * Löst einen bereits geprüften relativen Pfad sicher unterhalb von `root` auf.
 * Gibt null zurück, wenn das Ergebnis den Zielordner verlassen würde (doppelte Absicherung).
 */
export function resolveInside(root: string, relative: string): string | null {
  const target = path.resolve(root, ...relative.split('/'));
  const rel = path.relative(root, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
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
