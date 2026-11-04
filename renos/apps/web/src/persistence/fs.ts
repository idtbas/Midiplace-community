import { t } from '@/i18n';
import { db, newId, type FsNode } from './db';

/**
 * Virtuelles Dateisystem von RenOS. Es bildet einen persönlichen Ordner nach, der vollständig
 * in IndexedDB liegt. Es besteht keine Verbindung zum Dateisystem des iPads; Dateien gelangen
 * nur über Import (Dateiauswahl / Drag & Drop) hinein und über Export (Download) hinaus.
 */

export const HOME_ID = 'home';
export const SPECIAL_FOLDERS = [
  { id: 'desktop', name: 'Schreibtisch' },
  { id: 'documents', name: 'Dokumente' },
  { id: 'pictures', name: 'Bilder' },
  { id: 'downloads', name: 'Downloads' },
  { id: 'saves', name: 'Spielstände' },
] as const;

/** Maximale Größe einer einzelnen importierten Datei. */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;

export class FsError extends Error {}

export async function initFileSystem(): Promise<void> {
  await db.transaction('rw', db.nodes, db.blobs, async () => {
    if (await db.nodes.get(HOME_ID)) {
      // Neue Systemordner (z. B. „Schreibtisch“) auch in bestehenden Installationen anlegen.
      const now = Date.now();
      for (const folder of SPECIAL_FOLDERS) if (!(await db.nodes.get(folder.id))) await db.nodes.add(folderNode(folder.id, HOME_ID, folder.name, now));
      return;
    }
    const now = Date.now();
    await db.nodes.add(folderNode(HOME_ID, null, t.files.home, now));
    for (const folder of SPECIAL_FOLDERS) await db.nodes.add(folderNode(folder.id, HOME_ID, folder.name, now));
    const welcome = new Blob(
      [
        'Willkommen bei RenOS!\n\n' +
          'Dies ist dein persönlicher Ordner. Alles hier wird lokal auf diesem Gerät gespeichert.\n' +
          'Über „Importieren“ holst du Dateien aus der iPad-Dateien-App, über „Exportieren“ gibst du sie wieder heraus.\n\n' +
          'Ren’Py-Spiele installierst du mit dem Installer – sie liegen auf deinem RenOS-Server.\n',
      ],
      { type: 'text/plain' },
    );
    const id = newId();
    await db.nodes.add({ ...fileNode(id, 'documents', 'Willkommen.txt', 'text/plain', welcome.size, now) });
    await db.blobs.add({ id, data: welcome });
  });
}

function folderNode(id: string, parentId: string | null, name: string, now: number): FsNode {
  return { id, parentId, name, kind: 'folder', mime: 'inode/directory', size: 0, createdAt: now, modifiedAt: now, trashed: 0, trashedAt: null, originalParentId: null };
}

function fileNode(id: string, parentId: string, name: string, mime: string, size: number, now: number): FsNode {
  return { id, parentId, name, kind: 'file', mime, size, createdAt: now, modifiedAt: now, trashed: 0, trashedAt: null, originalParentId: null };
}

export function isSpecialFolder(id: string): boolean {
  return id === HOME_ID || SPECIAL_FOLDERS.some((f) => f.id === id);
}

export function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return t.files.nameInvalid.empty;
  if (trimmed.includes('/')) return t.files.nameInvalid.slash;
  if (trimmed === '.' || trimmed === '..') return t.files.nameInvalid.dots;
  if (trimmed.length > 200) return t.files.nameInvalid.tooLong;
  return null;
}

export async function getNode(id: string): Promise<FsNode | undefined> {
  return db.nodes.get(id);
}

export async function listChildren(parentId: string): Promise<FsNode[]> {
  return db.nodes.where('[parentId+trashed]').equals([parentId, 0]).toArray();
}

export async function listTrash(): Promise<FsNode[]> {
  return db.nodes.where('trashed').equals(1).toArray();
}

/** Pfad vom persönlichen Ordner bis zum Knoten (inklusive). */
export async function getAncestors(id: string): Promise<FsNode[]> {
  const chain: FsNode[] = [];
  let current = await db.nodes.get(id);
  let guard = 0;
  while (current && guard < 64) {
    chain.unshift(current);
    current = current.parentId ? await db.nodes.get(current.parentId) : undefined;
    guard += 1;
  }
  return chain;
}

/** Ist der Knoten erreichbar (weder er noch ein Vorfahr liegt im Papierkorb)? */
export async function isReachable(id: string): Promise<boolean> {
  const chain = await getAncestors(id);
  return chain.length > 0 && chain[0]?.id === HOME_ID && chain.every((n) => n.trashed === 0);
}

async function nameTaken(parentId: string, name: string, exceptId?: string): Promise<boolean> {
  const lower = name.trim().toLowerCase();
  const siblings = await listChildren(parentId);
  return siblings.some((s) => s.id !== exceptId && s.name.toLowerCase() === lower);
}

/** Liefert einen freien Namen im Ordner: „Datei.txt“ → „Datei (2).txt“. */
export async function uniqueName(parentId: string, desired: string): Promise<string> {
  const siblings = new Set((await listChildren(parentId)).map((s) => s.name.toLowerCase()));
  if (!siblings.has(desired.toLowerCase())) return desired;
  const dot = desired.lastIndexOf('.');
  const hasExt = dot > 0 && dot > desired.length - 8;
  const base = hasExt ? desired.slice(0, dot) : desired;
  const ext = hasExt ? desired.slice(dot) : '';
  for (let i = 2; i < 10_000; i += 1) {
    const candidate = `${base} (${i})${ext}`;
    if (!siblings.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${newId().slice(0, 6)}${ext}`;
}

export async function createFolder(parentId: string, name: string): Promise<FsNode> {
  const error = validateName(name);
  if (error) throw new FsError(error);
  if (await nameTaken(parentId, name)) throw new FsError(t.files.nameInvalid.exists);
  const node = folderNode(newId(), parentId, name.trim(), Date.now());
  await db.nodes.add(node);
  await touch(parentId);
  return node;
}

export async function createFile(parentId: string, name: string, data: Blob, mime?: string): Promise<FsNode> {
  const error = validateName(name);
  if (error) throw new FsError(error);
  if (data.size > MAX_FILE_BYTES) throw new FsError(t.files.importTooLarge(name));
  await ensureQuota(data.size);
  const finalName = await uniqueName(parentId, name.trim());
  const id = newId();
  const node = fileNode(id, parentId, finalName, mime || data.type || guessMime(finalName), data.size, Date.now());
  try {
    await db.transaction('rw', db.nodes, db.blobs, async () => {
      await db.blobs.add({ id, data });
      await db.nodes.add(node);
    });
  } catch (error) {
    if (error instanceof Error && /quota/i.test(error.name + error.message)) throw new FsError(t.files.quotaExceeded);
    throw error;
  }
  await touch(parentId);
  return node;
}

/** Überschreibt den Inhalt einer vorhandenen Datei. */
export async function writeFile(id: string, data: Blob): Promise<void> {
  await db.transaction('rw', db.nodes, db.blobs, async () => {
    await db.blobs.put({ id, data });
    await db.nodes.update(id, { size: data.size, modifiedAt: Date.now() });
  });
}

async function ensureQuota(bytes: number): Promise<void> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota && estimate.usage !== undefined && estimate.usage + bytes > estimate.quota * 0.95) {
      throw new FsError(t.files.quotaExceeded);
    }
  } catch (error) {
    if (error instanceof FsError) throw error;
  }
}

async function touch(id: string): Promise<void> {
  await db.nodes.update(id, { modifiedAt: Date.now() });
}

export async function renameNode(id: string, name: string): Promise<void> {
  const node = await db.nodes.get(id);
  if (!node || !node.parentId) throw new FsError(t.files.nameInvalid.dots);
  if (isSpecialFolder(id)) throw new FsError(t.files.nameInvalid.dots);
  const error = validateName(name);
  if (error) throw new FsError(error);
  if (await nameTaken(node.parentId, name, id)) throw new FsError(t.files.nameInvalid.exists);
  await db.nodes.update(id, { name: name.trim(), modifiedAt: Date.now() });
}

export async function trashNodes(ids: string[]): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.nodes, async () => {
    for (const id of ids) {
      if (isSpecialFolder(id)) continue;
      const node = await db.nodes.get(id);
      if (!node || node.trashed) continue;
      await db.nodes.update(id, { trashed: 1, trashedAt: now, originalParentId: node.parentId });
    }
  });
}

/** Stellt Elemente wieder her. Fehlt der ursprüngliche Ordner, landen sie im persönlichen Ordner. */
export async function restoreNodes(ids: string[]): Promise<void> {
  for (const id of ids) {
    const node = await db.nodes.get(id);
    if (!node || !node.trashed) continue;
    let parent = node.originalParentId ?? HOME_ID;
    if (!(await isReachable(parent))) parent = HOME_ID;
    const name = await uniqueName(parent, node.name);
    await db.nodes.update(id, { trashed: 0, trashedAt: null, originalParentId: null, parentId: parent, name });
  }
}

async function collectDescendants(id: string, into: string[]): Promise<void> {
  const children = await db.nodes.where('parentId').equals(id).toArray();
  for (const child of children) {
    into.push(child.id);
    if (child.kind === 'folder') await collectDescendants(child.id, into);
  }
}

export async function deleteNodes(ids: string[]): Promise<void> {
  const all: string[] = [];
  for (const id of ids) {
    if (isSpecialFolder(id)) continue;
    all.push(id);
    await collectDescendants(id, all);
  }
  await db.transaction('rw', db.nodes, db.blobs, async () => {
    await db.nodes.bulkDelete(all);
    await db.blobs.bulkDelete(all);
  });
}

export async function emptyTrash(): Promise<number> {
  const trashed = await listTrash();
  await deleteNodes(trashed.map((n) => n.id));
  return trashed.length;
}

/** Verschiebt Elemente in einen anderen Ordner (nicht in sich selbst oder Unterordner). */
export async function moveNodes(ids: string[], targetId: string): Promise<void> {
  const ancestors = (await getAncestors(targetId)).map((n) => n.id);
  for (const id of ids) {
    if (isSpecialFolder(id)) continue;
    if (ancestors.includes(id)) throw new FsError(t.files.moveIntoSelf);
    const node = await db.nodes.get(id);
    if (!node || node.parentId === targetId) continue;
    const name = await uniqueName(targetId, node.name);
    await db.nodes.update(id, { parentId: targetId, name, modifiedAt: Date.now() });
  }
  await touch(targetId);
}

/** Kopiert Elemente rekursiv in einen Ordner. */
export async function copyNodes(ids: string[], targetId: string): Promise<void> {
  const ancestors = (await getAncestors(targetId)).map((n) => n.id);
  for (const id of ids) {
    if (ancestors.includes(id)) throw new FsError(t.files.moveIntoSelf);
    await copyRecursive(id, targetId);
  }
  await touch(targetId);
}

async function copyRecursive(id: string, targetId: string): Promise<void> {
  const node = await db.nodes.get(id);
  if (!node) return;
  const now = Date.now();
  const copyId = newId();
  const name = await uniqueName(targetId, node.name);
  if (node.kind === 'folder') {
    await db.nodes.add({ ...folderNode(copyId, targetId, name, now) });
    for (const child of await listChildren(id)) await copyRecursive(child.id, copyId);
  } else {
    const blob = await db.blobs.get(id);
    if (blob) await ensureQuota(blob.data.size);
    await db.transaction('rw', db.nodes, db.blobs, async () => {
      if (blob) await db.blobs.add({ id: copyId, data: blob.data });
      await db.nodes.add({ ...fileNode(copyId, targetId, name, node.mime, node.size, now) });
    });
  }
}

export async function readBlob(id: string): Promise<Blob | undefined> {
  return (await db.blobs.get(id))?.data;
}

/** Durchsucht alle erreichbaren Dateien und Ordner nach Namen. */
export async function searchNodes(query: string, limit = 200): Promise<FsNode[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matches = await db.nodes.filter((n) => n.trashed === 0 && n.id !== HOME_ID && n.name.toLowerCase().includes(q)).limit(limit * 2).toArray();
  const out: FsNode[] = [];
  for (const node of matches) {
    if (await isReachable(node.id)) out.push(node);
    if (out.length >= limit) break;
  }
  return out;
}

/** Löst einen Pfad (z. B. „~/Dokumente“, „../Bilder“, „/home/user“) relativ zu einem Ordner auf. */
export async function resolvePath(path: string, cwdId: string): Promise<FsNode | null> {
  let current: FsNode | undefined;
  let rest = path.trim();
  if (rest === '' || rest === '~') return (await db.nodes.get(HOME_ID)) ?? null;
  if (rest.startsWith('~/')) {
    current = await db.nodes.get(HOME_ID);
    rest = rest.slice(2);
  } else if (rest.startsWith('/')) {
    // Absolute Pfade: /home/<name>/… entspricht dem persönlichen Ordner.
    const parts = rest.split('/').filter(Boolean);
    if (parts[0] !== 'home') return null;
    current = await db.nodes.get(HOME_ID);
    rest = parts.slice(2).join('/');
    if (parts.length === 1) return null;
  } else {
    current = await db.nodes.get(cwdId);
  }
  for (const part of rest.split('/').filter(Boolean)) {
    if (!current) return null;
    if (part === '.') continue;
    if (part === '..') {
      current = current.parentId ? await db.nodes.get(current.parentId) : current;
      continue;
    }
    if (current.kind !== 'folder') return null;
    const children = await listChildren(current.id);
    current = children.find((c) => c.name === part) ?? children.find((c) => c.name.toLowerCase() === part.toLowerCase());
  }
  return current && current.trashed === 0 ? current : null;
}

export async function displayPath(id: string, userName: string): Promise<string> {
  const chain = await getAncestors(id);
  const names = chain.slice(1).map((n) => n.name);
  return ['/home', userName, ...names].join('/');
}

export async function usage(): Promise<{ files: number; folders: number; bytes: number }> {
  let files = 0;
  let folders = 0;
  let bytes = 0;
  await db.nodes.each((n) => {
    if (n.kind === 'file') {
      files += 1;
      bytes += n.size;
    } else folders += 1;
  });
  return { files, folders, bytes };
}

const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  log: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  rpy: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
};

export function guessMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export function isTextFile(node: Pick<FsNode, 'name' | 'mime'>): boolean {
  return node.mime.startsWith('text/') || node.mime === 'application/json' || /\.(txt|md|log|json|csv|rpy|ini|cfg)$/i.test(node.name);
}

export function isImageFile(node: Pick<FsNode, 'name' | 'mime'>): boolean {
  // SVG wird bewusst nicht als Bild angezeigt (könnte aktive Inhalte enthalten).
  return /^image\/(png|jpeg|webp|gif)$/.test(node.mime);
}

export function isZipFile(node: Pick<FsNode, 'name' | 'mime'>): boolean {
  return /\.zip$/i.test(node.name);
}

export function kindLabel(node: Pick<FsNode, 'name' | 'mime' | 'kind'>): string {
  if (node.kind === 'folder') return t.files.kindFolder;
  if (isZipFile(node)) return 'ZIP-Archiv';
  if (isImageFile(node)) return 'Bild';
  if (isTextFile(node)) return 'Textdokument';
  if (node.mime.startsWith('audio/')) return 'Audio';
  if (node.mime.startsWith('video/')) return 'Video';
  if (node.mime === 'application/pdf') return 'PDF-Dokument';
  const ext = node.name.split('.').pop();
  return ext && ext !== node.name ? `${ext.toUpperCase()}-Datei` : 'Datei';
}
