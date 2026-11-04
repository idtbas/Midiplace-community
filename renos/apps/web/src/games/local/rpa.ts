import { checkEntryPath } from '@renos/shared';
import { PickleError, PyBytes, PyDict, PyTuple, unpickle, type PyValue } from './pickle';

/**
 * Ren'Py-Archive (.rpa) lesen – nur das Inhaltsverzeichnis. Die Dateien selbst bleiben im Archiv und
 * werden bei Bedarf als Ausschnitt (`Blob.slice`) geliefert, ohne Kopie und ohne zusätzlichen Speicher.
 *
 * Formate wie in renpy/loader.py: RPA-3.0 (mit Schlüssel), RPA-2.0, RPA-1.0 (Index in .rpi-Datei).
 */

export interface RpaMember {
  /** Datenabschnitte im Archiv (meist genau einer). */
  segments: Array<{ offset: number; length: number }>;
  /** Bytes, die vor den Daten stehen (RPA-3.0 erlaubt einen Präfix). */
  prefix: Uint8Array;
  size: number;
}

export type RpaIndex = Map<string, RpaMember>;

export class RpaError extends Error {
  constructor(
    message: string,
    readonly header?: string,
  ) {
    super(message);
  }
}

const MAX_INDEX_BYTES = 256 * 1024 * 1024;

async function inflateZlib(blob: Blob): Promise<Uint8Array> {
  const stream = blob.stream().pipeThrough(new DecompressionStream('deflate') as unknown as TransformStream<Uint8Array, Uint8Array>);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_INDEX_BYTES) throw new RpaError('Archivindex zu groß');
      parts.push(value);
    }
  } catch (error) {
    // Daten hinter dem Ende des zlib-Stroms (z. B. angehängte Signaturen) sind unschädlich.
    if (error instanceof RpaError || !parts.length) throw error instanceof RpaError ? error : new RpaError('Archivindex beschädigt');
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function toBigInt(v: PyValue): bigint {
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'bigint') return v;
  throw new RpaError('ungültiger Archiveintrag');
}

function toText(v: PyValue): string {
  if (typeof v === 'string') return v;
  if (v instanceof PyBytes) return v.text();
  throw new RpaError('ungültiger Dateiname im Archiv');
}

function toPrefix(v: PyValue | undefined): Uint8Array {
  if (v === undefined || v === null) return new Uint8Array(0);
  if (v instanceof PyBytes) return v.data;
  if (typeof v === 'string') return Uint8Array.from(v, (c) => c.charCodeAt(0) & 0xff);
  throw new RpaError('ungültiger Präfix im Archiv');
}

/** Normalisiert einen Pfad aus dem Archiv; null bei unsicheren Pfaden. */
export function normalizeMemberPath(name: string): string | null {
  const cleaned = name.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  const check = checkEntryPath(cleaned);
  if (!check.ok || check.isDirectory) return null;
  return check.path;
}

/** Wandelt den entpackten Index (Pickle) in eine Tabelle um. Ungültige Einträge werden gezählt, nicht übernommen. */
export function buildIndex(value: PyValue, key: bigint, archiveSize: number): { index: RpaIndex; skipped: number } {
  if (!(value instanceof PyDict)) throw new RpaError('Archivindex hat ein unerwartetes Format');
  const index: RpaIndex = new Map();
  let skipped = 0;
  for (const [rawName, rawEntries] of value.entries) {
    const path = normalizeMemberPath(toText(rawName));
    const list = Array.isArray(rawEntries) ? rawEntries : rawEntries instanceof PyTuple ? [rawEntries] : null;
    if (!path || !list?.length) {
      skipped += 1;
      continue;
    }
    const segments: RpaMember['segments'] = [];
    let prefix: Uint8Array = new Uint8Array(0);
    let valid = true;
    for (const [i, item] of list.entries()) {
      const parts = item instanceof PyTuple ? item.items : Array.isArray(item) ? item : null;
      if (!parts || parts.length < 2) {
        valid = false;
        break;
      }
      const offset = Number(toBigInt(parts[0]!) ^ key);
      const length = Number(toBigInt(parts[1]!) ^ key);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > archiveSize) {
        valid = false;
        break;
      }
      if (i === 0) prefix = toPrefix(parts[2]);
      segments.push({ offset, length });
    }
    if (!valid) {
      skipped += 1;
      continue;
    }
    const size = prefix.byteLength + segments.reduce((sum, s) => sum + s.length, 0);
    index.set(path, { segments, prefix, size });
  }
  return { index, skipped };
}

export interface RpaReadResult {
  index: RpaIndex;
  skipped: number;
  format: 'RPA-3.0' | 'RPA-2.0' | 'RPA-1.0';
}

/**
 * Liest das Inhaltsverzeichnis eines Archivs. `rpi` ist die Indexdatei bei RPA-1.0 (dann ist `archive`
 * die zugehörige .rpa-Datei ohne eigenen Header).
 */
export async function readRpaIndex(archive: Blob, rpi?: Blob): Promise<RpaReadResult> {
  try {
    if (rpi) {
      const { index, skipped } = buildIndex(unpickle(await inflateZlib(rpi)), 0n, archive.size);
      return { index, skipped, format: 'RPA-1.0' };
    }
    const head = new Uint8Array(await archive.slice(0, 64).arrayBuffer());
    const text = String.fromCharCode(...head);
    if (text.startsWith('RPA-3.0 ')) {
      const offset = parseInt(text.slice(8, 24), 16);
      const key = parseInt(text.slice(25, 33), 16);
      if (!Number.isFinite(offset) || !Number.isFinite(key) || offset <= 0 || offset > archive.size) throw new RpaError('ungültiger Archivkopf');
      const { index, skipped } = buildIndex(unpickle(await inflateZlib(archive.slice(offset))), BigInt(key), archive.size);
      return { index, skipped, format: 'RPA-3.0' };
    }
    if (text.startsWith('RPA-2.0 ')) {
      const offset = parseInt(text.slice(8, 24), 16);
      if (!Number.isFinite(offset) || offset <= 0 || offset > archive.size) throw new RpaError('ungültiger Archivkopf');
      const { index, skipped } = buildIndex(unpickle(await inflateZlib(archive.slice(offset))), 0n, archive.size);
      return { index, skipped, format: 'RPA-2.0' };
    }
    const header = text.split('\n')[0]!.replace(/[^\x20-\x7e]/g, '').slice(0, 24);
    throw new RpaError('Archivformat wird nicht unterstützt', header);
  } catch (error) {
    if (error instanceof RpaError) throw error;
    if (error instanceof PickleError) throw new RpaError(`Archivindex nicht lesbar (${error.message})`);
    throw new RpaError('Archivindex nicht lesbar');
  }
}

/** Datei aus dem Archiv als Blob – ohne Kopie (Ausschnitte der Archivdatei). */
export function memberBlob(archive: Blob, member: RpaMember, type = ''): Blob {
  const parts: BlobPart[] = [];
  if (member.prefix.byteLength) parts.push(member.prefix as Uint8Array<ArrayBuffer>);
  for (const s of member.segments) parts.push(archive.slice(s.offset, s.offset + s.length));
  return new Blob(parts, { type });
}
