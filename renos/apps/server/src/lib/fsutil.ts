import { mkdir, readdir, rm, statfs } from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o750 });
}

/**
 * Löscht einen Ordner rekursiv – aber nur, wenn er innerhalb von `allowedRoot` liegt.
 * Schützt davor, durch einen Programmfehler Dateien außerhalb des Datenverzeichnisses zu löschen.
 */
export async function removeInside(allowedRoot: string, target: string): Promise<void> {
  const rel = path.relative(allowedRoot, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to delete outside of ${allowedRoot}: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export async function diskSpace(dir: string): Promise<{ free: number; total: number } | null> {
  try {
    const stats = await statfs(dir);
    return { free: Number(stats.bavail) * Number(stats.bsize), total: Number(stats.blocks) * Number(stats.bsize) };
  } catch {
    return null;
  }
}
