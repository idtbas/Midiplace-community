import Dexie, { type EntityTable } from 'dexie';

/**
 * Lokale Datenbank von RenOS (IndexedDB über Dexie).
 * Enthält ausschließlich persönliche Daten dieses Geräts: virtuelle Dateien, Notizen und
 * größere Einstellungswerte (z. B. ein eigenes Hintergrundbild). Spiele liegen auf dem Server.
 */

export type NodeKind = 'folder' | 'file';

export interface FsNode {
  id: string;
  parentId: string | null;
  name: string;
  kind: NodeKind;
  mime: string;
  size: number;
  createdAt: number;
  modifiedAt: number;
  /** 1 = direkt in den Papierkorb gelegt (IndexedDB indiziert keine Booleans). */
  trashed: 0 | 1;
  trashedAt: number | null;
  originalParentId: string | null;
}

export interface FsBlob {
  id: string;
  data: Blob;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface KvEntry {
  key: string;
  value: unknown;
}

export class RenosDB extends Dexie {
  nodes!: EntityTable<FsNode, 'id'>;
  blobs!: EntityTable<FsBlob, 'id'>;
  notes!: EntityTable<Note, 'id'>;
  kv!: EntityTable<KvEntry, 'key'>;

  constructor(name = 'renos') {
    super(name);
    this.version(1).stores({
      nodes: 'id, parentId, [parentId+trashed], trashed, name, modifiedAt',
      blobs: 'id',
      notes: 'id, updatedAt, title',
      kv: 'key',
    });
  }
}

export const db = new RenosDB();

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const entry = await db.kv.get(key);
  return entry?.value as T | undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value });
}

export async function kvDelete(key: string): Promise<void> {
  await db.kv.delete(key);
}
