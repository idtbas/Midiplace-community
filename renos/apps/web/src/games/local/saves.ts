import { GAME_ID_PATTERN } from '@renos/shared';
import { db, type SaveRecord } from '@/persistence/db';

/**
 * Spielstände der Spiele im eingebauten Spiele-Host.
 *
 * Das Spiel läuft in einem anonymen Origin ohne eigenen Speicher; seine IndexedDB-Nachbildung
 * schickt Änderungen an RenOS. Hier werden sie – getrennt pro Spiel – geprüft und gespeichert.
 * Alles, was aus dem Spiel kommt, ist nicht vertrauenswürdig: Größen, Namen und Anzahl sind begrenzt.
 */

export const SAVE_LIMITS = {
  maxNameLength: 256,
  maxKeyLength: 1024,
  maxRecordBytes: 64 * 1024 * 1024,
  maxGameBytes: 1024 * 1024 * 1024,
  maxRecords: 50_000,
  maxBatch: 10_000,
};

export interface SaveEntry {
  db: string;
  store: string;
  key: string | number;
  value: unknown;
}

export interface SaveDeletion {
  db: string;
  store: string;
  key: string | number;
}

export type SaveResult = { ok: true } | { ok: false; reason: string };

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= SAVE_LIMITS.maxNameLength;
}

function validKey(value: unknown): value is string | number {
  return (typeof value === 'string' && value.length <= SAVE_LIMITS.maxKeyLength) || (typeof value === 'number' && Number.isFinite(value));
}

/** Ungefähre Größe eines Werts (Binärdaten und Texte zählen, Struktur nur grob). Null bei nicht speicherbaren Werten. */
export function estimateSize(value: unknown, depth = 0): number | null {
  if (depth > 8) return null;
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return 8;
  if (typeof value === 'string') return value.length * 2;
  if (value instanceof Date) return 8;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (value instanceof Blob) return value.size;
  if (Array.isArray(value)) {
    if (value.length > 100_000) return null;
    let total = 16;
    for (const item of value) {
      const size = estimateSize(item, depth + 1);
      if (size === null) return null;
      total += size;
    }
    return total;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = Object.keys(value);
    if (keys.length > 1000) return null;
    let total = 16;
    for (const key of keys) {
      const size = estimateSize((value as Record<string, unknown>)[key], depth + 1);
      if (size === null) return null;
      total += key.length * 2 + size;
    }
    return total;
  }
  return null;
}

/** Alle Spielstand-Datensätze eines Spiels (für den Start im Spiele-Host). */
export async function loadSaves(gameId: string): Promise<SaveEntry[]> {
  if (!GAME_ID_PATTERN.test(gameId)) return [];
  const records = await db.saves.where('gameId').equals(gameId).toArray();
  return records.map(({ db: name, store, key, value }) => ({ db: name, store, key, value }));
}

/**
 * Übernimmt Änderungen aus dem Spiel. Alles oder nichts: Ist ein Eintrag ungültig oder würde ein
 * Limit überschritten, wird nichts gespeichert.
 */
export async function applySaveChanges(gameId: string, put: unknown, del: unknown): Promise<SaveResult> {
  if (!GAME_ID_PATTERN.test(gameId)) return { ok: false, reason: 'Unbekanntes Spiel.' };
  if (!Array.isArray(put) || !Array.isArray(del) || put.length + del.length > SAVE_LIMITS.maxBatch) {
    return { ok: false, reason: 'Ungültige Spielstand-Änderung.' };
  }
  const puts: SaveRecord[] = [];
  for (const raw of put as unknown[]) {
    const entry = raw as Partial<SaveEntry> | null;
    if (!entry || !validName(entry.db) || !validName(entry.store) || !validKey(entry.key)) return { ok: false, reason: 'Ungültiger Spielstand-Eintrag.' };
    const size = estimateSize(entry.value);
    if (size === null) return { ok: false, reason: 'Ungültiger Spielstand-Inhalt.' };
    if (size > SAVE_LIMITS.maxRecordBytes) return { ok: false, reason: 'Ein Spielstand ist zu groß.' };
    puts.push({ gameId, db: entry.db, store: entry.store, key: entry.key, value: entry.value, size });
  }
  const dels: [string, string, string, string | number][] = [];
  for (const raw of del as unknown[]) {
    const entry = raw as Partial<SaveDeletion> | null;
    if (!entry || !validName(entry.db) || !validName(entry.store) || !validKey(entry.key)) return { ok: false, reason: 'Ungültiger Spielstand-Eintrag.' };
    dels.push([gameId, entry.db, entry.store, entry.key]);
  }

  try {
    await db.transaction('rw', db.games, db.saves, async () => {
      if (!(await db.games.get(gameId))) throw new SaveError('Dieses Spiel ist nicht mehr installiert.');
      // Spätere Einträge zum selben Schlüssel gewinnen (wie in IndexedDB).
      const latest = new Map<string, SaveRecord>();
      for (const record of puts) latest.set(JSON.stringify([record.db, record.store, record.key]), record);
      const existing = await db.saves.where('gameId').equals(gameId).toArray();
      const sizes = new Map(existing.map((r) => [JSON.stringify([r.db, r.store, r.key]), r.size]));
      for (const [, db_, store, key] of dels) sizes.delete(JSON.stringify([db_, store, key]));
      for (const [id, record] of latest) sizes.set(id, record.size);
      let total = 0;
      for (const size of sizes.values()) total += size;
      if (sizes.size > SAVE_LIMITS.maxRecords || total > SAVE_LIMITS.maxGameBytes) throw new SaveError('Der Speicherplatz für Spielstände dieses Spiels ist voll.');
      if (dels.length) await db.saves.bulkDelete(dels);
      if (latest.size) await db.saves.bulkPut([...latest.values()]);
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof SaveError) return { ok: false, reason: error.message };
    return { ok: false, reason: 'Der Spielstand konnte nicht gespeichert werden (Speicher voll?).' };
  }
}

class SaveError extends Error {}

export interface SaveStats {
  count: number;
  bytes: number;
}

export async function saveStats(gameId: string): Promise<SaveStats> {
  if (!GAME_ID_PATTERN.test(gameId)) return { count: 0, bytes: 0 };
  let count = 0;
  let bytes = 0;
  await db.saves.where('gameId').equals(gameId).each((r) => {
    count += 1;
    bytes += r.size;
  });
  return { count, bytes };
}

export async function deleteSaves(gameId: string): Promise<void> {
  if (!GAME_ID_PATTERN.test(gameId)) return;
  await db.saves.where('gameId').equals(gameId).delete();
}

/**
 * Übernimmt die Spielstände eines anderen Spiels (z. B. nach dem Installieren einer neuen Version).
 * Vorhandene Spielstände des Ziels werden ersetzt.
 */
export async function copySaves(fromGameId: string, toGameId: string): Promise<number> {
  if (!GAME_ID_PATTERN.test(fromGameId) || !GAME_ID_PATTERN.test(toGameId) || fromGameId === toGameId) return 0;
  return db.transaction('rw', db.saves, async () => {
    const source = await db.saves.where('gameId').equals(fromGameId).toArray();
    await db.saves.where('gameId').equals(toGameId).delete();
    await db.saves.bulkPut(source.map((r) => ({ ...r, gameId: toGameId })));
    return source.length;
  });
}
