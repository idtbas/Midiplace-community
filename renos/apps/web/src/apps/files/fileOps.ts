import { strToU8, zipSync, type Zippable } from 'fflate';
import { t } from '@/i18n';
import { downloadBlob, pickFiles } from '@/lib/download';
import type { FsNode } from '@/persistence/db';
import { EntryScanner, isJunkPath } from '@renos/shared';
import { isEncrypted, readCentralDirectory, readEntryChunks, type ZipEntry } from '@/games/local/zipReader';
import { FsError, createFile, createFolder, getNode, guessMime, listChildren, readBlob, uniqueName } from '@/persistence/fs';
import { notify } from '@/system/notifications';

/** Importiert Dateien (Dateiauswahl oder Drag & Drop) in einen Ordner. */
export async function importFiles(files: File[], targetId: string): Promise<number> {
  let ok = 0;
  for (const file of files) {
    try {
      await createFile(targetId, file.name, file, file.type || undefined);
      ok += 1;
    } catch (error) {
      notify({ kind: 'error', title: file.name, message: error instanceof FsError ? error.message : t.errors.generic });
      if (error instanceof FsError && error.message === t.files.quotaExceeded) break;
    }
  }
  if (ok > 0) notify({ kind: 'success', title: t.files.imported(ok), transient: true });
  return ok;
}

export async function pickAndImport(targetId: string): Promise<void> {
  const files = await pickFiles({ multiple: true });
  if (files.length) await importFiles(files, targetId);
}

async function addToZip(node: FsNode, into: Zippable): Promise<void> {
  if (node.kind === 'folder') {
    const folder: Zippable = {};
    into[node.name] = folder;
    for (const child of await listChildren(node.id)) await addToZip(child, folder);
    return;
  }
  const blob = await readBlob(node.id);
  into[node.name] = blob ? new Uint8Array(await blob.arrayBuffer()) : strToU8('');
}

/**
 * Exportiert eine Datei direkt bzw. Ordner und Mehrfachauswahl als ZIP-Archiv.
 * Auf dem iPad bietet Safari die Datei zum Sichern in der Dateien-App an.
 */
export async function exportNodes(ids: string[]): Promise<void> {
  const nodes = (await Promise.all(ids.map((id) => getNode(id)))).filter((n): n is FsNode => Boolean(n));
  if (nodes.length === 0) return;
  if (nodes.length === 1 && nodes[0]!.kind === 'file') {
    const blob = await readBlob(nodes[0]!.id);
    if (blob) downloadBlob(blob, nodes[0]!.name);
    return;
  }
  const tree: Zippable = {};
  for (const node of nodes) await addToZip(node, tree);
  const data = zipSync(tree, { level: 6 });
  const name = nodes.length === 1 ? `${nodes[0]!.name}.zip` : 'RenOS-Export.zip';
  downloadBlob(new Blob([data], { type: 'application/zip' }), name);
}

/** Komprimiert Dateien/Ordner zu einem ZIP-Archiv im angegebenen Ordner. */
export async function compressNodes(ids: string[], targetId: string): Promise<FsNode | null> {
  const nodes = (await Promise.all(ids.map((id) => getNode(id)))).filter((n): n is FsNode => Boolean(n));
  if (nodes.length === 0) return null;
  const tree: Zippable = {};
  for (const node of nodes) await addToZip(node, tree);
  const data = zipSync(tree, { level: 6 });
  const base = nodes.length === 1 ? nodes[0]!.name.replace(/\.[^.]+$/, '') || nodes[0]!.name : 'Archiv';
  const name = await uniqueName(targetId, `${base}.zip`);
  return createFile(targetId, name, new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), 'application/zip');
}

const EXTRACT_LIMITS = { maxEntries: 20_000, maxUncompressedBytes: 2 * 1024 * 1024 * 1024, maxCompressionRatio: 200 };

/**
 * Entpackt ein ZIP-Archiv aus Files in einen neuen Ordner daneben. Dieselben Sicherheitsregeln wie
 * beim Installieren: keine Pfade außerhalb des Zielordners, keine Links, Schutz vor Zip-Bombs.
 */
export async function extractZip(nodeId: string, onProgress?: (done: number, total: number) => void): Promise<{ folder: FsNode; files: number; skipped: number }> {
  const node = await getNode(nodeId);
  const blob = node ? await readBlob(nodeId) : undefined;
  if (!node || !blob || !node.parentId) throw new FsError('Archiv nicht gefunden.');
  let entries: ZipEntry[];
  try {
    entries = await readCentralDirectory(blob);
  } catch {
    throw new FsError('Die Datei ist kein gültiges ZIP-Archiv.');
  }
  const scanner = new EntryScanner(EXTRACT_LIMITS);
  if (!scanner.checkEntryCount(entries.length)) throw new FsError('Das Archiv enthält zu viele Dateien.');
  const accepted: Array<{ entry: ZipEntry; path: string; isDirectory: boolean }> = [];
  for (const entry of entries) {
    const scanned = scanner.accept({
      name: entry.name,
      externalFileAttributes: entry.externalFileAttributes,
      encrypted: isEncrypted(entry),
      compressionMethod: entry.method,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
    });
    if (scanned && !isJunkPath(scanned.path)) accepted.push({ entry, path: scanned.path, isDirectory: scanned.isDirectory });
  }
  scanner.finish();
  const fatal = scanner.issues.find((i) => i.severity === 'error' && ['too_large_uncompressed', 'suspicious_ratio', 'too_many_entries', 'encrypted_entry'].includes(i.code));
  if (fatal) throw new FsError(fatal.code === 'encrypted_entry' ? 'Verschlüsselte Archive werden nicht unterstützt.' : 'Das Archiv ist zu groß oder verdächtig stark komprimiert.');

  const folderName = await uniqueName(node.parentId, node.name.replace(/\.zip$/i, '') || 'Archiv');
  const folder = await createFolder(node.parentId, folderName);
  const dirs = new Map<string, string>([['', folder.id]]);
  const ensureDir = async (path: string): Promise<string> => {
    const known = dirs.get(path);
    if (known) return known;
    const slash = path.lastIndexOf('/');
    const parent = await ensureDir(slash >= 0 ? path.slice(0, slash) : '');
    const name = path.slice(slash + 1);
    const existing = (await listChildren(parent)).find((c) => c.kind === 'folder' && c.name === name);
    const id = existing ? existing.id : (await createFolder(parent, name)).id;
    dirs.set(path, id);
    return id;
  };
  let files = 0;
  const total = accepted.filter((a) => !a.isDirectory).length;
  for (const item of accepted) {
    const path = item.path.replace(/\/$/, '');
    if (item.isDirectory) {
      await ensureDir(path);
      continue;
    }
    const slash = path.lastIndexOf('/');
    const parent = await ensureDir(slash >= 0 ? path.slice(0, slash) : '');
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for await (const chunk of readEntryChunks(blob, item.entry)) parts.push(chunk.slice() as Uint8Array<ArrayBuffer>);
    const name = path.slice(slash + 1);
    await createFile(parent, await uniqueName(parent, name), new Blob(parts), guessMime(name));
    files += 1;
    onProgress?.(files, total);
  }
  return { folder, files, skipped: entries.length - accepted.length };
}
