import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { db, newId, type FsNode, type Note } from './db';
import { HOME_ID, createFolder, isReachable, uniqueName } from './fs';
import { DEFAULT_SETTINGS, useSettings, type Settings } from '@/system/settings';

/**
 * Datensicherung der lokalen RenOS-Daten (Notizen, Dateien, Einstellungen) als ZIP-Datei.
 * iPadOS kann Websitedaten unter Umständen entfernen – eine regelmäßige Sicherung schützt davor.
 * Spiele und Spielstände sind nicht enthalten (Spiele liegen auf dem Server, Spielstände im Spiel-Origin).
 */

export const BACKUP_FORMAT = 'renos-backup';
export const BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 1024 * 1024 * 1024;

interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  settings: Partial<Settings>;
  notes: Note[];
  files: Array<Pick<FsNode, 'id' | 'parentId' | 'name' | 'kind' | 'mime' | 'createdAt' | 'modifiedAt'>>;
}

export async function createBackup(): Promise<Blob> {
  const nodes = await db.nodes.toArray();
  const reachable: FsNode[] = [];
  for (const node of nodes) if (node.id !== HOME_ID && (await isReachable(node.id))) reachable.push(node);
  const settings: Partial<Settings> = {};
  const state = useSettings.getState();
  // Die Geräte-PIN gehört zum Gerät und kommt nicht in Sicherungen.
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) if (key !== 'lockPinHash') (settings as Record<string, unknown>)[key] = state[key];

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    settings,
    notes: await db.notes.toArray(),
    files: reachable.map(({ id, parentId, name, kind, mime, createdAt, modifiedAt }) => ({ id, parentId, name, kind, mime, createdAt, modifiedAt })),
  };
  const zip: Zippable = { 'renos-backup.json': strToU8(JSON.stringify(manifest, null, 2)) };
  const files: Zippable = {};
  for (const node of reachable) {
    if (node.kind !== 'file') continue;
    const blob = await db.blobs.get(node.id);
    if (blob) files[node.id] = new Uint8Array(await blob.data.arrayBuffer());
  }
  zip.files = files;
  return new Blob([zipSync(zip, { level: 6 })], { type: 'application/zip' });
}

export interface RestoreResult {
  notes: number;
  files: number;
  folderName: string | null;
}

/**
 * Stellt eine Sicherung wieder her, ohne vorhandene Daten zu löschen:
 * Notizen werden ergänzt bzw. aktualisiert, Dateien in einem neuen Ordner abgelegt,
 * Einstellungen übernommen.
 */
export async function restoreBackup(file: Blob): Promise<RestoreResult> {
  if (file.size > MAX_BACKUP_BYTES) throw new Error('Die Sicherung ist zu groß.');
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error('Die Datei ist keine gültige RenOS-Sicherung.');
  }
  const raw = entries['renos-backup.json'];
  if (!raw) throw new Error('Die Datei ist keine gültige RenOS-Sicherung.');
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(strFromU8(raw)) as BackupManifest;
  } catch {
    throw new Error('Die Sicherung ist beschädigt.');
  }
  if (manifest.format !== BACKUP_FORMAT || typeof manifest.version !== 'number' || manifest.version > BACKUP_VERSION) {
    throw new Error('Dieses Sicherungsformat wird nicht unterstützt.');
  }

  let notes = 0;
  for (const note of Array.isArray(manifest.notes) ? manifest.notes : []) {
    if (typeof note?.id !== 'string' || typeof note.body !== 'string') continue;
    await db.notes.put({
      id: note.id,
      title: String(note.title ?? '').slice(0, 200),
      body: note.body,
      createdAt: Number(note.createdAt) || Date.now(),
      updatedAt: Number(note.updatedAt) || Date.now(),
    });
    notes += 1;
  }

  let files = 0;
  let folderName: string | null = null;
  const fileList = Array.isArray(manifest.files) ? manifest.files : [];
  if (fileList.length) {
    folderName = await uniqueName(HOME_ID, `Wiederhergestellt ${new Date().toLocaleDateString('de-DE')}`);
    const root = await createFolder(HOME_ID, folderName);
    const idMap = new Map<string, string>();
    // Ordnerstruktur in mehreren Durchgängen aufbauen (Eltern vor Kindern).
    const pending = [...fileList];
    for (let pass = 0; pass < 40 && pending.length; pass += 1) {
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const entry = pending[i]!;
        const parentKnown = !entry.parentId || entry.parentId === HOME_ID || idMap.has(entry.parentId) || !fileList.some((f) => f.id === entry.parentId);
        if (!parentKnown) continue;
        pending.splice(i, 1);
        const parent = entry.parentId && idMap.has(entry.parentId) ? idMap.get(entry.parentId)! : root.id;
        const name = await uniqueName(parent, String(entry.name || 'Datei').replace(/\//g, '-').slice(0, 200));
        const id = newId();
        idMap.set(entry.id, id);
        const now = Date.now();
        const node: FsNode = {
          id,
          parentId: parent,
          name,
          kind: entry.kind === 'folder' ? 'folder' : 'file',
          mime: entry.kind === 'folder' ? 'inode/directory' : String(entry.mime || 'application/octet-stream'),
          size: 0,
          createdAt: Number(entry.createdAt) || now,
          modifiedAt: Number(entry.modifiedAt) || now,
          trashed: 0,
          trashedAt: null,
          originalParentId: null,
        };
        if (node.kind === 'file') {
          const data = entries[`files/${entry.id}`] ?? new Uint8Array();
          node.size = data.byteLength;
          await db.transaction('rw', db.nodes, db.blobs, async () => {
            await db.blobs.put({ id, data: new Blob([data as BlobPart], { type: node.mime }) });
            await db.nodes.add(node);
          });
          files += 1;
        } else {
          await db.nodes.add(node);
        }
      }
    }
  }

  if (manifest.settings && typeof manifest.settings === 'object') {
    const allowed: Partial<Settings> = {};
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
      const value = (manifest.settings as Record<string, unknown>)[key];
      if (key === 'lockPinHash') continue;
      if (value !== undefined && typeof value === typeof DEFAULT_SETTINGS[key]) (allowed as Record<string, unknown>)[key] = value;
    }
    useSettings.getState().patch({ ...allowed, onboardingCompleted: true });
  }
  return { notes, files, folderName };
}

/** Löscht alle lokalen Daten von RenOS (Datenbank und gespeicherte Einstellungen). */
export async function wipeLocalData(): Promise<void> {
  db.close();
  await db.delete();
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('renos.')) localStorage.removeItem(key);
  } catch {
    /* ignorieren */
  }
}
