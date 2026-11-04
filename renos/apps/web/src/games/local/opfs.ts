import { GAME_ID_PATTERN, checkEntryPath } from '@renos/shared';

/**
 * Spieldateien im Origin Private File System (OPFS) von RenOS.
 *
 * Der Speicher gehört zum RenOS-Origin selbst (bei Home-Bildschirm-Web-Apps bis zu 60 % des Geräts),
 * nicht zum Spiele-Origin – dessen iframe-Speicher wäre auf 10 % davon begrenzt.
 * Layout: renos-games/<gameId>/<Pfad im Web-Build>
 */

export const GAMES_DIR = 'renos-games';

export function opfsSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

export async function gamesRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(GAMES_DIR, { create: true });
}

export async function gameDirectory(gameId: string, create = false): Promise<FileSystemDirectoryHandle> {
  if (!GAME_ID_PATTERN.test(gameId)) throw new Error('invalid game id');
  return (await gamesRoot()).getDirectoryHandle(gameId, { create });
}

export async function removeGameDirectory(gameId: string): Promise<void> {
  if (!GAME_ID_PATTERN.test(gameId)) return;
  try {
    await (await gamesRoot()).removeEntry(gameId, { recursive: true });
  } catch (error) {
    if ((error as DOMException)?.name !== 'NotFoundError') throw error;
  }
}

export async function listGameDirectories(): Promise<string[]> {
  const root = await gamesRoot();
  const names: string[] = [];
  // `keys()` ist in allen OPFS-Implementierungen vorhanden, aber nicht in jeder TS-DOM-Version typisiert.
  for await (const name of (root as unknown as { keys: () => AsyncIterable<string> }).keys()) names.push(name);
  return names;
}

const dirCache = new Map<string, FileSystemDirectoryHandle>();

/**
 * Liefert eine Spieldatei als `File` (auf Datenträger gestützt, wird nicht in den Speicher geladen).
 * Der Pfad wird mit denselben Regeln wie beim Entpacken geprüft.
 */
export async function readGameFile(gameId: string, relativePath: string): Promise<File | null> {
  const check = checkEntryPath(relativePath);
  if (!check.ok || check.isDirectory) return null;
  const segments = check.path.split('/');
  if (segments.some((s) => s.startsWith('.'))) return null;
  try {
    let dir = dirCache.get(gameId) ?? (await gameDirectory(gameId));
    dirCache.set(gameId, dir);
    for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment);
    const handle = await dir.getFileHandle(segments[segments.length - 1]!);
    return await handle.getFile();
  } catch {
    return null;
  }
}

export function forgetGameDirectory(gameId: string): void {
  dirCache.delete(gameId);
}
