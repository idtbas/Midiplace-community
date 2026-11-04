/// <reference lib="webworker" />
/**
 * Wandelt einen Ren'Py-Desktop-Build (Windows/Linux/Mac) im Installations-Worker in einen Web-Build um.
 *
 * Ergebnis im OPFS (renos-games/<id>/):
 *   index.html            Startseite der Ren'Py-Web-Laufzeit (Titel des Spiels)
 *   game.zip              Engine (aus dem Laufzeitpaket) + Skripte, Schriften, GUI, kleine Dateien,
 *                         Platzhalter und game/renpyweb_remote_files.txt
 *   game/<pfad>           nachladbare Bilder, Musik, Stimmen, Videos (lose Dateien des Spiels)
 *   archives/<n>.rpa      .rpa-Archive, aus denen nachladbare Dateien stammen (werden nicht entpackt)
 *   renos-web.json        Verzeichnis für RenOS: welche Datei aus welchem Archiv-Ausschnitt kommt
 *   web-presplash.*       Startbild des Spiels (falls vorhanden)
 *
 * Die Laufzeitdateien (WebAssembly-Engine usw.) liegen einmal für alle Spiele in renos-runtimes/<id>/.
 */
import { crc32 } from './crc32';
import { CLASSIFY_LIMITS, Classifier, PLACEHOLDER_PNG, escapeHtml, mediaKind, remoteFilesText, skipGameFile } from './desktop';
import { IMAGE_HEADER_BYTES, imageSize } from './imageSize';
import { gameDirectory } from './opfs';
import { directoryMaker, openSink, writeChunks } from './opfsWrite';
import { RpaError, memberBlob, readRpaIndex, type RpaMember } from './rpa';
import { readInstalledRuntime, runtimeDirectory } from './runtimes';
import { ZipWriter } from './zipWriter';
import { ZipFormatError, entryDataStart, readCentralDirectory, readEntryChunks, readRange, type ZipEntry } from './zipReader';

export interface AcceptedEntry {
  entry: ZipEntry;
  path: string;
  isDirectory: boolean;
  size: number;
}

export interface ConvertParams {
  file: File;
  accepted: AcceptedEntry[];
  gameId: string;
  root: string;
  title: string;
  runtimeId: string;
  maxBytes: number;
  isCancelled: () => boolean;
  progress: (bytesWritten: number, filesWritten: number) => void;
  /** Abschnitte ohne Schreibfortschritt (z. B. Prüfen der Dateien) melden. */
  stage?: (stage: 'scan', done: number, total: number) => void;
}

export interface ConvertReport {
  bytesWritten: number;
  filesWritten: number;
  /** Dateien, die bei Bedarf nachgeladen werden. */
  remoteFiles: number;
  /** Dateien des Spiels in der game.zip (ohne Engine). */
  localFiles: number;
  localBytes: number;
  archives: number;
  archiveMembers: number;
  skippedMembers: number;
  /** Archive in unbekanntem Format (Name und Kopfzeile). */
  unsupportedArchives: string[];
  /** Bilder, deren Größe nicht bestimmbar war (deshalb sofort geladen). */
  unsizedImages: number;
  cover: Blob | null;
}

export const WEB_MANIFEST = 'renos-web.json';

/** Verzeichnis für RenOS: Datei → [Archiv, Präfix (Base64), [[Position, Länge], …]]. */
export interface WebManifest {
  format: 1;
  runtime: string;
  archives: string[];
  members: Record<string, [number, string, Array<[number, number]>]>;
}

type Source = { kind: 'loose'; entry: AcceptedEntry } | { kind: 'archive'; archive: number; member: RpaMember };

function abortIfCancelled(params: ConvertParams) {
  if (params.isCancelled()) throw new DOMException('cancelled', 'AbortError');
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function readHead(file: File, entry: ZipEntry, max: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of readEntryChunks(file, entry)) {
    parts.push(chunk.slice(0, Math.min(chunk.byteLength, max - total)));
    total += parts[parts.length - 1]!.byteLength;
    if (total >= max) break;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * Dateianfang schnell lesen: nur ein kleiner Ausschnitt der (ggf. komprimierten) Daten, ohne
 * Prüfsumme und ohne einen laufenden Entpack-Strom abbrechen zu müssen (das kann in Safari hängen).
 */
async function readHeadFast(file: File, entry: ZipEntry, max: number): Promise<Uint8Array> {
  const start = await entryDataStart(file, entry);
  if (entry.method === 0) return new Uint8Array(await file.slice(start, start + Math.min(max, entry.compressedSize)).arrayBuffer());
  // Deflate: max Bytes Ausgabe brauchen höchstens etwa max Bytes Eingabe (+ Reserve).
  const input = file.slice(start, start + Math.min(entry.compressedSize, max + 65_536));
  const reader = input.stream().pipeThrough(new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      parts.push(value.slice(0, max - total));
      total += parts[parts.length - 1]!.byteLength;
    }
  } catch {
    /* abgeschnittene Eingabe – was bis dahin entpackt wurde, reicht */
  }
  void reader.cancel().catch(() => undefined);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

async function readAll(file: File, entry: ZipEntry): Promise<Uint8Array> {
  return readHead(file, entry, entry.uncompressedSize);
}

async function blobCrc(blob: Blob): Promise<number> {
  let crc = 0;
  for await (const chunk of readRange(blob, 0, blob.size)) crc = crc32(chunk, crc);
  return crc;
}

export async function convertDesktopBuild(params: ConvertParams): Promise<ConvertReport> {
  const { file, root, runtimeId } = params;
  const runtime = await readInstalledRuntime(runtimeId);
  if (!runtime) throw new Error('runtime_missing');
  const runtimeDir = await runtimeDirectory(runtimeId);
  const engineFile = await (await runtimeDir.getFileHandle('engine.zip')).getFile();
  const runtimeIndex = await (await (await runtimeDir.getFileHandle('index.html')).getFile()).text();

  const gamePrefix = `${root}game/`;
  const gameDir = await gameDirectory(params.gameId, true);
  const { fileHandle } = directoryMaker(gameDir);

  let bytesWritten = 0;
  let filesWritten = 0;
  let lastReport = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (force || now - lastReport > 120) {
      lastReport = now;
      params.progress(bytesWritten, filesWritten);
    }
  };
  const count = (n: number) => {
    bytesWritten += n;
    if (bytesWritten > params.maxBytes) throw new ZipFormatError('too_large_uncompressed');
    report();
  };

  // 1. Dateien unter game/ einsammeln.
  const loose = new Map<string, AcceptedEntry>();
  const archiveEntries: AcceptedEntry[] = [];
  const rpiEntries = new Map<string, AcceptedEntry>();
  for (const item of params.accepted) {
    if (item.isDirectory || !item.path.startsWith(gamePrefix)) continue;
    const rel = item.path.slice(gamePrefix.length);
    if (!rel) continue;
    const lower = rel.toLowerCase();
    if (lower.endsWith('.rpa')) archiveEntries.push(item);
    else if (lower.endsWith('.rpi')) rpiEntries.set(lower.slice(0, -4), item);
    else if (!skipGameFile(rel)) loose.set(rel, item);
  }

  // 2. Archive ins OPFS kopieren und ihr Inhaltsverzeichnis lesen.
  const archiveNames: string[] = [];
  const archivePaths: string[] = [];
  const archiveFiles: File[] = [];
  const indexes: Array<Map<string, RpaMember>> = [];
  const unsupportedArchives: string[] = [];
  let skippedMembers = 0;
  archiveEntries.sort((a, b) => a.path.localeCompare(b.path));
  for (const item of archiveEntries) {
    abortIfCancelled(params);
    const name = `archives/${archiveNames.length}.rpa`;
    const handle = await fileHandle(name);
    await writeChunks(handle, readEntryChunks(file, item.entry), count);
    const archiveFile = await handle.getFile();
    const stem = item.path.slice(gamePrefix.length, -4).toLowerCase();
    const rpi = rpiEntries.get(stem);
    try {
      const rpiBlob = rpi ? new Blob([(await readAll(file, rpi.entry)) as Uint8Array<ArrayBuffer>]) : undefined;
      const { index, skipped } = await readRpaIndex(archiveFile, rpiBlob);
      skippedMembers += skipped;
      archiveNames.push(name);
      archivePaths.push(item.path);
      archiveFiles.push(archiveFile);
      indexes.push(index);
      filesWritten += 1;
    } catch (error) {
      if (!(error instanceof RpaError)) throw error;
      unsupportedArchives.push(`${item.path.slice(gamePrefix.length)}${error.header ? ` (${error.header})` : ''}`);
      await gameDir.getDirectoryHandle('archives').then((d) => d.removeEntry(name.slice('archives/'.length))).catch(() => undefined);
    }
  }

  // 3. Virtuelles Spielverzeichnis wie Ren'Py: lose Dateien vor Archiven, Archive in absteigender Namensfolge.
  const table = new Map<string, Source>();
  const order = archiveNames.map((_, i) => i).sort((a, b) => archivePaths[b]!.localeCompare(archivePaths[a]!));
  for (const i of order) {
    for (const [rel, member] of indexes[i]!) {
      if (!table.has(rel) && !skipGameFile(rel)) table.set(rel, { kind: 'archive', archive: i, member });
    }
  }
  for (const [rel, entry] of loose) table.set(rel, { kind: 'loose', entry });

  // 4. Einteilen: sofort laden (game.zip) oder bei Bedarf.
  const classifier = new Classifier(CLASSIFY_LIMITS);
  const remote = new Map<string, string>();
  const placement = new Map<string, 'local' | 'remote'>();
  let unsizedImages = 0;
  let scanned = 0;
  for (const [rel, source] of table) {
    abortIfCancelled(params);
    scanned += 1;
    if (scanned % 25 === 0) params.stage?.('scan', scanned, table.size);
    const size = source.kind === 'loose' ? source.entry.size : source.member.size;
    const decision = await classifier.place(rel, size, async () => {
      // Grob und schnell: erst 4 KB (PNG/WebP/AVIF), nur bei JPEG mit großen Metadaten einmal mehr.
      for (const bytes of [4096, IMAGE_HEADER_BYTES]) {
        const head =
          source.kind === 'loose'
            ? await readHeadFast(file, source.entry.entry, bytes)
            : new Uint8Array(await memberBlob(archiveFiles[source.archive]!, source.member).slice(0, bytes).arrayBuffer());
        const dims = imageSize(head);
        if (dims) return dims;
        if (head.byteLength < bytes) break;
      }
      unsizedImages += 1;
      return null;
    });
    placement.set(rel, decision.kind);
    if (decision.kind === 'remote') remote.set(rel, decision.meta);
  }

  params.stage?.('scan', table.size, table.size);

  // 5. Nachladbare lose Dateien ins OPFS kopieren.
  for (const [rel, kind] of placement) {
    const source = table.get(rel)!;
    if (kind !== 'remote' || source.kind !== 'loose') continue;
    abortIfCancelled(params);
    await writeChunks(await fileHandle(`game/${rel}`), readEntryChunks(file, source.entry.entry), count);
    filesWritten += 1;
  }

  // 6. Startbild und Cover.
  const findSource = (...names: string[]) => names.map((n) => [n, table.get(n)] as const).find(([, s]) => s);
  const blobOf = async (source: Source): Promise<Blob> =>
    source.kind === 'loose' ? new Blob([(await readAll(file, source.entry.entry)) as Uint8Array<ArrayBuffer>]) : memberBlob(archiveFiles[source.archive]!, source.member);
  const presplashSource = findSource('presplash.png', 'presplash.jpg', 'presplash_background.png', 'presplash_background.jpg');
  const presplashExt = presplashSource ? (presplashSource[0].endsWith('.jpg') ? 'jpg' : 'png') : null;
  const presplash = presplashSource && presplashSource[1] && (presplashSource[1].kind === 'loose' ? presplashSource[1].entry.size : presplashSource[1].member.size) <= 8 * 1024 * 1024 ? await blobOf(presplashSource[1]) : null;
  const coverSource = presplashSource ?? findSource('gui/main_menu.png', 'gui/main_menu.jpg', 'gui/main_menu.webp');
  const cover = presplash ?? (coverSource && coverSource[1] && (coverSource[1].kind === 'loose' ? coverSource[1].entry.size : coverSource[1].member.size) <= 8 * 1024 * 1024 ? await blobOf(coverSource[1]) : null);

  // 7. game.zip schreiben.
  const zipHandle = await fileHandle('game.zip');
  const sink = await openSink(zipHandle);
  const writer = new ZipWriter({
    write: async (chunk) => {
      await sink.write(chunk);
      count(chunk.byteLength);
    },
  });
  let localFiles = 0;
  let localBytes = 0;
  try {
    for (const entry of await readCentralDirectory(engineFile)) {
      if (entry.name.endsWith('/')) continue;
      abortIfCancelled(params);
      const start = await entryDataStart(engineFile, entry);
      await writer.addRaw({
        name: entry.name,
        method: entry.method === 8 ? 8 : 0,
        crc: entry.crc32,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        data: readRange(engineFile, start, entry.compressedSize),
      });
    }
    for (const [rel, kind] of placement) {
      if (kind !== 'local') continue;
      abortIfCancelled(params);
      const source = table.get(rel)!;
      if (source.kind === 'loose') {
        const e = source.entry.entry;
        const start = await entryDataStart(file, e);
        await writer.addRaw({
          name: `game/${rel}`,
          method: e.method === 8 ? 8 : 0,
          crc: e.crc32,
          compressedSize: e.compressedSize,
          uncompressedSize: e.uncompressedSize,
          data: readRange(file, start, e.compressedSize),
        });
        localBytes += e.uncompressedSize;
      } else {
        const blob = memberBlob(archiveFiles[source.archive]!, source.member);
        const crc = await blobCrc(blob);
        await writer.addRaw({ name: `game/${rel}`, method: 0, crc, compressedSize: blob.size, uncompressedSize: blob.size, data: readRange(blob, 0, blob.size) });
        localBytes += blob.size;
      }
      localFiles += 1;
    }
    // Ordner für nachgeladene Dateien: Ren'Py schreibt sie nach game/<pfad>; die Ordner müssen existieren
    // (offizielle Web-Builds enthalten dafür ebenfalls Ordnereinträge).
    const remoteDirs = new Set<string>();
    for (const rel of remote.keys()) {
      const parts = rel.split('/').slice(0, -1);
      for (let i = 1; i <= parts.length; i += 1) remoteDirs.add(`game/${parts.slice(0, i).join('/')}/`);
    }
    for (const dir of [...remoteDirs].sort()) {
      if (!writer.has(dir)) await writer.addRaw({ name: dir, method: 0, crc: 0, compressedSize: 0, uncompressedSize: 0, data: [] });
    }
    const placeholderCrc = crc32(PLACEHOLDER_PNG);
    for (const [rel, meta] of remote) {
      if (!meta.startsWith('image ')) continue;
      await writer.addRaw({
        name: `_placeholders/${rel}`,
        method: 0,
        crc: placeholderCrc,
        compressedSize: PLACEHOLDER_PNG.byteLength,
        uncompressedSize: PLACEHOLDER_PNG.byteLength,
        data: [PLACEHOLDER_PNG],
      });
    }
    await writer.addBytes('game/renpyweb_remote_files.txt', new TextEncoder().encode(remoteFilesText(remote)));
    // Ren'Py 7 (renpyweb) liest das Startbild aus der game.zip.
    if (presplash && runtime.generation === 'renpyweb') await writer.addBytes(`web-presplash.${presplashExt}`, new Uint8Array(await presplash.arrayBuffer()));
    await writer.finish();
  } catch (error) {
    await sink.abort();
    throw error;
  }
  await sink.close();
  filesWritten += 1;

  // 8. Startseite (index.html) der Laufzeit mit dem Titel des Spiels.
  const title = escapeHtml(params.title);
  let html = runtimeIndex.replaceAll("Ren'Py Web Game", title).replaceAll('%%TITLE%%', title);
  if (presplash && runtime.generation === 'web3') {
    html = html.replaceAll('web-presplash.jpg', `web-presplash.${presplashExt}`);
    await writeChunks(await fileHandle(`web-presplash.${presplashExt}`), toChunks(new Uint8Array(await presplash.arrayBuffer())), count);
  }
  await writeChunks(await fileHandle('index.html'), toChunks(new TextEncoder().encode(html)), count);

  // 9. Verzeichnis der Archiv-Ausschnitte; Archive ohne nachladbare Dateien werden nicht mehr gebraucht.
  const used = new Set<number>();
  const members: WebManifest['members'] = {};
  for (const [rel] of remote) {
    const source = table.get(rel)!;
    if (source.kind !== 'archive') continue;
    used.add(source.archive);
    members[rel] = [source.archive, source.member.prefix.byteLength ? toBase64(source.member.prefix) : '', source.member.segments.map((s) => [s.offset, s.length])];
  }
  const manifest: WebManifest = { format: 1, runtime: runtimeId, archives: archiveNames, members };
  await writeChunks(await fileHandle(WEB_MANIFEST), toChunks(new TextEncoder().encode(JSON.stringify(manifest))), count);
  for (const [i, name] of archiveNames.entries()) {
    if (used.has(i)) continue;
    await gameDir
      .getDirectoryHandle('archives')
      .then((d) => d.removeEntry(name.slice('archives/'.length)))
      .catch(() => undefined);
  }

  report(true);
  return {
    bytesWritten,
    filesWritten,
    remoteFiles: remote.size,
    localFiles,
    localBytes,
    archives: archiveNames.length,
    archiveMembers: indexes.reduce((sum, i) => sum + i.size, 0),
    skippedMembers,
    unsupportedArchives,
    unsizedImages,
    cover: cover ?? null,
  };
}

async function* toChunks(data: Uint8Array): AsyncGenerator<Uint8Array> {
  yield data;
}

/** Größe der Spieldaten unter game/ (für Speicherprüfung und Fortschritt). */
export function gameBytes(accepted: AcceptedEntry[], root: string): { files: number; bytes: number; archives: number; archiveBytes: number } {
  const prefix = `${root}game/`;
  let files = 0;
  let bytes = 0;
  let archives = 0;
  let archiveBytes = 0;
  for (const item of accepted) {
    if (item.isDirectory || !item.path.startsWith(prefix)) continue;
    const rel = item.path.slice(prefix.length);
    if (rel.toLowerCase().endsWith('.rpa')) {
      archives += 1;
      archiveBytes += item.size;
    } else if (skipGameFile(rel) && !rel.toLowerCase().endsWith('.rpi')) continue;
    files += 1;
    bytes += item.size;
  }
  return { files, bytes, archives, archiveBytes };
}

export { mediaKind };
