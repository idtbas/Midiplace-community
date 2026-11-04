/**
 * Reparatur älterer Umwandlungen ohne Neuinstallation.
 *
 * Spiele, die mit einer früheren RenOS-Version aus einem Windows-/Linux-Build umgewandelt wurden, haben
 * eine game.zip, der spätere Korrekturen fehlen (z. B. „Parsing the script failed“ bei Student Transfer,
 * weil die .rpy neben der .rpyc lag). Beim Start wird deshalb eine aktualisierte game.zip als
 * zusammengesetzter Blob geliefert: unveränderte Einträge sind Ausschnitte der vorhandenen Datei (nichts
 * wird kopiert oder neu geschrieben), nur kleine neue Einträge liegen im Speicher.
 *
 * Änderungen gegenüber Stand 1:
 *   - .rpy/.rpym weglassen, wenn die kompilierte .rpyc/.rpymc daneben liegt
 *   - 1×1-Platzhalter nachladbarer Bilder durch Platzhalter in echter Bildgröße ersetzen
 *   - renos_web_support.rpy und die Ersatz-Module (js, pyodide, _renpytfd, …) ergänzen bzw. erneuern
 */
import { crc32 } from './crc32';
import { PLACEHOLDER_PNG, placeholderPng } from './desktop';
import { STUB_MODULES, WEBSTUB, WEBSTUB_ENTRY, WEB_SUPPORT_RPY, hasCompiledTwin } from './webSupport';
import { BlobPartsSink, ZipWriter } from './zipWriter';
import { entryDataStart, readCentralDirectory, readEntryChunks, type ZipEntry } from './zipReader';

export const REMOTE_LIST = 'game/renpyweb_remote_files.txt';
const MAX_REMOTE_LIST_BYTES = 64 * 1024 * 1024;
/** Prüfsumme des „js“-Ersatzes aus der ersten Fassung (nur, um ihn als RenOS-Datei zu erkennen). */
const LEGACY_JS_STUB_CRC = 0x14b6fd15;

export interface UpgradeReport {
  droppedSources: number;
  resizedPlaceholders: number;
  /** Ergänzte oder erneuerte RenOS-Dateien (Unterstützungsskript, Ersatz-Module). */
  supportFiles: number;
}

export interface UpgradeResult {
  blob: Blob;
  report: UpgradeReport;
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

/**
 * Berechnet die nötigen Änderungen und baut daraus eine neue game.zip.
 * Liefert null, wenn nichts zu tun ist.
 */
export async function upgradeGameZip(zip: Blob): Promise<UpgradeResult | null> {
  const entries = await readCentralDirectory(zip);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const exists = (path: string) => byName.has(path);
  const report: UpgradeReport = { droppedSources: 0, resizedPlaceholders: 0, supportFiles: 0 };

  // 1. Quelltexte mit kompilierter Fassung weglassen.
  const drop = new Set<string>();
  for (const entry of entries) {
    if (entry.name.startsWith('game/') && hasCompiledTwin(entry.name, exists)) drop.add(entry.name);
  }
  report.droppedSources = drop.size;

  // Neue Inhalte: ersetzen (Name vorhanden) oder ergänzen.
  const content = new Map<string, Uint8Array>();

  // 2. Platzhalter in echter Bildgröße.
  const remoteEntry = byName.get(REMOTE_LIST);
  if (remoteEntry && remoteEntry.uncompressedSize <= MAX_REMOTE_LIST_BYTES) {
    const remote = parseRemoteList(new TextDecoder().decode(await entryBytes(zip, remoteEntry)));
    const legacyCrc = crc32(PLACEHOLDER_PNG);
    const bySize = new Map<string, Uint8Array>();
    for (const [rel, meta] of remote) {
      if (!meta.startsWith('image ')) continue;
      const [w, h] = meta.slice(6).split(',').map(Number);
      if (!w || !h || w > 65535 || h > 65535) continue;
      const name = `_placeholders/${rel}`;
      const current = byName.get(name);
      // Nur die 1×1-Platzhalter früherer Fassungen ersetzen (oder fehlende ergänzen).
      if (current && (current.uncompressedSize !== PLACEHOLDER_PNG.byteLength || current.crc32 >>> 0 !== legacyCrc >>> 0)) continue;
      const key = `${w}x${h}`;
      let data = bySize.get(key);
      if (!data) {
        data = placeholderPng(w, h);
        bySize.set(key, data);
      }
      content.set(name, data);
      report.resizedPlaceholders += 1;
    }
  }

  // 3. Unterstützungsskript und Ersatz-Module (RenOS-eigene Dateien werden auf den neuen Stand gebracht).
  const enc = new TextEncoder();
  const stubEntryCrc = crc32(enc.encode(WEBSTUB_ENTRY));
  const isRenosStub = (entry: ZipEntry) => entry.crc32 >>> 0 === stubEntryCrc >>> 0 || entry.crc32 >>> 0 === LEGACY_JS_STUB_CRC;
  const own = (module: string) => {
    const pattern = new RegExp(`(^|/)${module}(\\.py|/__init__\\.py)$`, 'i');
    return entries.some((e) => e.name.startsWith('game/') && pattern.test(e.name) && !isRenosStub(e));
  };
  const wanted: Array<{ name: string; text: string; renosOnly: boolean }> = [{ name: 'game/renos_web_support.rpy', text: WEB_SUPPORT_RPY, renosOnly: true }];
  for (const prefix of ['', 'game/python-packages/']) {
    wanted.push({ name: `${prefix}_renos_webstub.py`, text: WEBSTUB, renosOnly: true });
    for (const module of STUB_MODULES) if (!own(module)) wanted.push({ name: `${prefix}${module}.py`, text: WEBSTUB_ENTRY, renosOnly: false });
    if (!own('pyodide')) wanted.push({ name: `${prefix}pyodide/__init__.py`, text: WEBSTUB_ENTRY, renosOnly: false });
  }
  for (const item of wanted) {
    const data = enc.encode(item.text);
    const current = byName.get(item.name);
    if (current) {
      if (current.uncompressedSize === data.byteLength && current.crc32 >>> 0 === crc32(data) >>> 0) continue;
      // Fremde Dateien (vom Spiel mitgebracht) bleiben unangetastet.
      if (!item.renosOnly && !isRenosStub(current)) continue;
    }
    // Bringt das Spiel eine kompilierte Fassung des Unterstützungsskripts mit, nichts ergänzen.
    if (item.name === 'game/renos_web_support.rpy' && !current && exists('game/renos_web_support.rpyc')) continue;
    content.set(item.name, data);
    report.supportFiles += 1;
  }

  if (!drop.size && !content.size) return null;

  // 4. Neue game.zip zusammensetzen: vorhandene Einträge als Ausschnitte, neue Einträge aus dem Speicher.
  const sink = new BlobPartsSink();
  const writer = new ZipWriter(sink);
  const kept = entries.filter((e) => !drop.has(e.name) && !content.has(e.name));
  const starts = new Array<number>(kept.length);
  // Lokale Kopfzeilen gebündelt lesen (Tausende kleiner Lesezugriffe).
  for (let i = 0; i < kept.length; i += 256) {
    const batch = kept.slice(i, i + 256);
    const values = await Promise.all(batch.map((e) => entryDataStart(zip, e)));
    values.forEach((v, j) => (starts[i + j] = v));
  }
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
  for (const [name, data] of content) await writer.addBytes(name, data);
  await writer.finish();
  return { blob: sink.toBlob(), report };
}
