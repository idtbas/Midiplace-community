import { strToU8, zipSync, type Zippable } from 'fflate';
import { t } from '@/i18n';
import { downloadBlob, pickFiles } from '@/lib/download';
import type { FsNode } from '@/persistence/db';
import { FsError, createFile, getNode, listChildren, readBlob } from '@/persistence/fs';
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
