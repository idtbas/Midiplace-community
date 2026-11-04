import path from 'node:path';

// Die eigentlichen Regeln sind gemeinsam mit dem Browser (lokale Installation) in @renos/shared definiert.
export { MAX_DEPTH, MAX_PATH_LENGTH, MAX_SEGMENT_BYTES, checkEntryPath, isExecutablePath, isJunkPath, unixFileType, type PathCheck } from '@renos/shared';

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
