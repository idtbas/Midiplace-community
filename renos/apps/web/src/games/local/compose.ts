/**
 * Setzt beim Start eines umgewandelten Spiels die game.zip zusammen, die Ren'Py bekommt.
 *
 * Grundlage ist die bei der Installation geschriebene game.zip. Daraus entsteht ein zusammengesetzter
 * Blob: unveränderte Einträge sind Ausschnitte der vorhandenen Datei (nichts wird kopiert oder neu
 * geschrieben), nur kleine neue Einträge liegen im Speicher.
 *
 *  1. Reparatur älterer Umwandlungen (ohne Neuinstallation), wenn `upgrade` gesetzt ist:
 *     - .rpy/.rpym weglassen, wenn die kompilierte .rpyc/.rpymc daneben liegt
 *     - Platzhalter nachladbarer Dateien am echten Pfad (statt unter _placeholders/), damit Spiele sie
 *       auch mit os.walk/glob/os.path.exists finden; 1×1-Platzhalter werden durch die echte Größe ersetzt
 *     - Unterstützungsskript und Hilfsmodule (_renos_host, _renpytfd, js, pyodide …) auf den neuen Stand
 *  2. Vom Spiel angelegte Dateien (overlay.ts): Skripte und kleine Dateien direkt, Bilder/Audio/Video
 *     als Platzhalter plus Eintrag in renpyweb_remote_files.txt (nachgeladen aus RenOS).
 *  3. game/renos_base.txt (alle Dateien aus der game.zip) und game/renos_overlay.txt (aufbewahrte
 *     Dateien): Daran erkennt _renos_host.py, welche Dateien das Spiel neu angelegt oder gelöscht hat.
 */
import type { OverlayRecord } from '@/persistence/db';
import { crc32 } from './crc32';
import { PLACEHOLDER_PNG, remoteFilesText } from './desktop';
import { PlaceholderCache, hasCompiledTwin, supportFiles } from './webSupport';
import { BlobPartsSink, ZipWriter } from './zipWriter';
import { entryDataStart, readCentralDirectory, readEntryChunks, type ZipEntry } from './zipReader';

export const REMOTE_LIST = 'game/renpyweb_remote_files.txt';
export const BASE_LIST = 'game/renos_base.txt';
export const OVERLAY_LIST = 'game/renos_overlay.txt';
const MAX_REMOTE_LIST_BYTES = 64 * 1024 * 1024;
/** Prüfsumme des „js“-Ersatzes aus der ersten Fassung (nur, um ihn als RenOS-Datei zu erkennen). */
const LEGACY_JS_STUB_CRC = 0x14b6fd15;
/** „Made by“ der game.zip, die RenOS selbst schreibt (Unix, ZIP 4.5) – lokale Kopfzeilen sind dann berechenbar. */
const RENOS_MADE_BY = (3 << 8) | 45;

export interface ComposeReport {
  droppedSources: number;
  /** Platzhalter am echten Pfad ergänzt oder in echter Größe ersetzt. */
  placeholders: number;
  /** Ergänzte oder erneuerte RenOS-Dateien (Unterstützungsskript, Hilfsmodule). */
  supportFiles: number;
  /** Mitgegebene, vom Spiel angelegte Dateien. */
  overlayFiles: number;
}

export interface ComposeOptions {
  /** Reparatur älterer Umwandlungen durchführen. */
  upgrade: boolean;
  overlay?: Array<Pick<OverlayRecord, 'path' | 'blob' | 'size' | 'kind' | 'meta'>>;
}

/** Liest renpyweb_remote_files.txt: abwechselnd Pfad und Art („image B,H“, „music -“ …). */
export function parseRemoteList(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split('\n');
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const name = lines[i]!.trim();
    if (name) out.set(name, lines[i + 1]!.trim());
  }
  return out;
}

async function entryBytes(zip: Blob, entry: ZipEntry): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of readEntryChunks(zip, entry)) {
    parts.push(chunk);
    size += chunk.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

const encoder = new TextEncoder();

/** Beginn der Daten aller Einträge – für von RenOS geschriebene Archive berechnet, sonst gelesen. */
async function dataStarts(zip: Blob, entries: ZipEntry[]): Promise<number[]> {
  const computed = (e: ZipEntry) => {
    const zip64 = e.compressedSize >= 0xffffffff || e.uncompressedSize >= 0xffffffff;
    return e.localHeaderOffset + 30 + encoder.encode(e.name).byteLength + (zip64 ? 20 : 0);
  };
  const ours = entries.length > 0 && entries.every((e) => e.versionMadeBy === RENOS_MADE_BY);
  if (ours) {
    // Stichprobe: Stimmt die Rechnung, gilt sie für alle (gleicher Schreiber).
    const sample = [entries[0]!, entries[entries.length - 1]!];
    const ok = (await Promise.all(sample.map(async (e) => (await entryDataStart(zip, e)) === computed(e)))).every(Boolean);
    if (ok) return entries.map(computed);
  }
  const starts = new Array<number>(entries.length);
  for (let i = 0; i < entries.length; i += 256) {
    const batch = entries.slice(i, i + 256);
    const values = await Promise.all(batch.map((e) => entryDataStart(zip, e)));
    values.forEach((v, j) => (starts[i + j] = v));
  }
  return starts;
}

/** Baut die game.zip für den Start (siehe oben). */
export async function composeGameZip(zip: Blob, options: ComposeOptions): Promise<{ blob: Blob; report: ComposeReport }> {
  const entries = await readCentralDirectory(zip);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const exists = (path: string) => byName.has(path);
  const report: ComposeReport = { droppedSources: 0, placeholders: 0, supportFiles: 0, overlayFiles: 0 };
  const overlay = options.overlay ?? [];
  const overlayPaths = new Set(overlay.map((o) => o.path));

  const drop = new Set<string>();
  const content = new Map<string, Uint8Array | Blob>();

  const remoteEntry = byName.get(REMOTE_LIST);
  const remote =
    remoteEntry && remoteEntry.uncompressedSize <= MAX_REMOTE_LIST_BYTES ? parseRemoteList(new TextDecoder().decode(await entryBytes(zip, remoteEntry))) : new Map<string, string>();

  if (options.upgrade) {
    // 1a. Quelltexte mit kompilierter Fassung weglassen.
    for (const entry of entries) {
      if (entry.name.startsWith('game/') && hasCompiledTwin(entry.name, exists)) drop.add(entry.name);
    }
    report.droppedSources = drop.size;

    // 1b. Platzhalter am echten Pfad; die alten unter _placeholders/ werden nicht mehr gebraucht.
    for (const entry of entries) if (entry.name.startsWith('_placeholders/')) drop.add(entry.name);
    const placeholders = new PlaceholderCache();
    const legacyCrc = crc32(PLACEHOLDER_PNG) >>> 0;
    for (const [rel, meta] of remote) {
      const name = `game/${rel}`;
      const current = byName.get(name);
      const legacy = current && current.uncompressedSize === PLACEHOLDER_PNG.byteLength && current.crc32 >>> 0 === legacyCrc;
      if (current && !legacy) continue;
      content.set(name, placeholders.get(meta).data);
      report.placeholders += 1;
    }

    // 1c. Unterstützungsskript und Hilfsmodule.
    const stubEntryCrc = crc32(encoder.encode(supportFiles(() => false).find((f) => f.name === 'js.py')!.text)) >>> 0;
    const isRenosStub = (entry: ZipEntry) => entry.crc32 >>> 0 === stubEntryCrc || entry.crc32 >>> 0 === LEGACY_JS_STUB_CRC;
    const own = (module: string) => {
      const pattern = new RegExp(`(^|/)${module}(\\.py|/__init__\\.py)$`, 'i');
      return entries.some((e) => e.name.startsWith('game/') && pattern.test(e.name) && !isRenosStub(e));
    };
    for (const file of supportFiles(own)) {
      const data = encoder.encode(file.text);
      const current = byName.get(file.name);
      if (current) {
        if (current.uncompressedSize === data.byteLength && current.crc32 >>> 0 === crc32(data) >>> 0) continue;
        // Fremde Dateien (vom Spiel mitgebracht) bleiben unangetastet.
        if (!file.renosOnly && !isRenosStub(current)) continue;
      }
      if (file.name === 'game/renos_web_support.rpy' && !current && exists('game/renos_web_support.rpyc')) continue;
      content.set(file.name, data);
      report.supportFiles += 1;
    }
  }

  // 2. Vom Spiel angelegte Dateien.
  const placeholders = new PlaceholderCache();
  const remoteWithOverlay = new Map(remote);
  for (const file of overlay) {
    if (file.kind === 'remote') {
      content.set(file.path, placeholders.get(file.meta).data);
      remoteWithOverlay.set(file.path.slice('game/'.length), file.meta);
    } else {
      content.set(file.path, file.blob);
      remoteWithOverlay.delete(file.path.slice('game/'.length));
    }
    report.overlayFiles += 1;
  }
  // Nachladeliste neu schreiben, wenn aufbewahrte Dateien nachgeladen werden oder Einträge ersetzen.
  if (overlay.some((f) => f.kind === 'remote' || remote.has(f.path.slice('game/'.length)))) {
    content.set(REMOTE_LIST, encoder.encode(remoteFilesText(remoteWithOverlay)));
  }

  // 3. Listen für den Abgleich im Spiel.
  const names = new Set<string>();
  for (const entry of entries) if (!drop.has(entry.name)) names.add(entry.name);
  for (const name of content.keys()) names.add(name);
  const base = [...names].filter((n) => n.startsWith('game/') && !n.endsWith('/') && !overlayPaths.has(n) && n !== BASE_LIST && n !== OVERLAY_LIST);
  content.set(BASE_LIST, encoder.encode(base.map((n) => n.slice('game/'.length)).sort().join('\n') + '\n'));
  content.set(OVERLAY_LIST, encoder.encode(overlay.map((f) => `${f.path.slice('game/'.length)}\t${f.kind === 'remote' ? -1 : f.size}`).join('\n') + '\n'));

  // 4. Zusammensetzen: vorhandene Einträge als Ausschnitte, neue Einträge danach.
  const sink = new BlobPartsSink();
  const writer = new ZipWriter(sink);
  const kept = entries.filter((e) => !drop.has(e.name) && !content.has(e.name));
  const starts = await dataStarts(zip, kept);
  for (const [i, entry] of kept.entries()) {
    if (entry.method !== 0 && entry.method !== 8) throw new Error(`Unbekannte Kompression: ${entry.name}`);
    const start = starts[i]!;
    await writer.addRaw({
      name: entry.name,
      method: entry.method,
      crc: entry.crc32,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      data: zip.slice(start, start + entry.compressedSize),
    });
  }
  for (const [name, data] of content) {
    if (data instanceof Blob) {
      const crc = await blobCrc(data);
      await writer.addRaw({ name, method: 0, crc, compressedSize: data.size, uncompressedSize: data.size, data });
    } else {
      await writer.addBytes(name, data);
    }
  }
  await writer.finish();
  return { blob: sink.toBlob(), report };
}

async function blobCrc(blob: Blob): Promise<number> {
  let crc = 0;
  const CHUNK = 4 * 1024 * 1024;
  for (let at = 0; at < blob.size; at += CHUNK) crc = crc32(new Uint8Array(await blob.slice(at, at + CHUNK).arrayBuffer()), crc);
  return crc >>> 0;
}

/** Ob die Reparatur etwas verändert hat (sonst kann das Spiel als aktuell markiert werden). */
export function upgradeChanged(report: ComposeReport): boolean {
  return report.droppedSources > 0 || report.placeholders > 0 || report.supportFiles > 0;
}
