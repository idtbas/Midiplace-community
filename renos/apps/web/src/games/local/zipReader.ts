/**
 * ZIP-Leser für den Browser (lokale Installation auf dem iPad).
 *
 * Liest ausschließlich per `Blob.slice()` aus der vom Nutzer gewählten Datei – das Archiv wird nie
 * vollständig in den Arbeitsspeicher geladen. Unterstützt ZIP64 (Archive und Einträge über 4 GB),
 * UTF-8-, Info-ZIP-Unicode- und CP437-Dateinamen, „stored“ und „deflate“.
 */

import { Inflate } from 'fflate';
import { crc32 } from './crc32';

export interface ZipEntry {
  name: string;
  versionMadeBy: number;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  externalFileAttributes: number;
}

export class ZipFormatError extends Error {}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_COMMENT = 0xffff;
/** Obergrenze für das Inhaltsverzeichnis (schützt vor manipulierten Größenangaben). */
const MAX_CENTRAL_DIRECTORY_BYTES = 256 * 1024 * 1024;

async function readBytes(blob: Blob, start: number, end: number): Promise<DataView> {
  if (start < 0 || end > blob.size || start > end) throw new ZipFormatError('out of range');
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

function u64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipFormatError('size too large');
  return Number(value);
}

// CP437 (Standardkodierung älterer ZIP-Programme) für Bytes ≥ 0x80.
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeCp437(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return out;
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

interface ExtraField {
  id: number;
  data: DataView;
}

function parseExtra(view: DataView): ExtraField[] {
  const fields: ExtraField[] = [];
  let i = 0;
  while (i + 4 <= view.byteLength) {
    const id = view.getUint16(i, true);
    const size = view.getUint16(i + 2, true);
    if (i + 4 + size > view.byteLength) break;
    fields.push({ id, data: new DataView(view.buffer, view.byteOffset + i + 4, size) });
    i += 4 + size;
  }
  return fields;
}


function decodeName(raw: Uint8Array, flags: number, extras: ExtraField[]): string {
  let name: string;
  if (flags & 0x800) {
    name = utf8.decode(raw);
  } else {
    // Info-ZIP Unicode Path Extra Field (0x7075), nur wenn die Prüfsumme zum Originalnamen passt.
    const unicode = extras.find((e) => e.id === 0x7075 && e.data.byteLength >= 6 && e.data.getUint8(0) === 1);
    if (unicode && unicode.data.getUint32(1, true) === crc32(raw)) {
      name = utf8.decode(new Uint8Array(unicode.data.buffer, unicode.data.byteOffset + 5, unicode.data.byteLength - 5));
    } else {
      name = decodeCp437(raw);
    }
  }
  // Wie yauzl (strictFileNames=false): Backslashes werden zu Schrägstrichen und danach geprüft.
  return name.replace(/\\/g, '/');
}

/** Liest das Inhaltsverzeichnis eines ZIP-Archivs. */
export async function readCentralDirectory(blob: Blob): Promise<ZipEntry[]> {
  if (blob.size < 22) throw new ZipFormatError('too small');
  const tailStart = Math.max(0, blob.size - (22 + MAX_COMMENT));
  const tail = await readBytes(blob, tailStart, blob.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i -= 1) {
    if (tail.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError('no end of central directory');

  let diskNumber = tail.getUint16(eocd + 4, true);
  let entryCount = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);

  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff || diskNumber === 0xffff) {
    const locatorPos = tailStart + eocd - 20;
    if (locatorPos < 0) throw new ZipFormatError('zip64 locator missing');
    const locator = await readBytes(blob, locatorPos, locatorPos + 20);
    if (locator.getUint32(0, true) !== ZIP64_LOCATOR_SIG) throw new ZipFormatError('zip64 locator missing');
    const recordOffset = u64(locator, 8);
    const record = await readBytes(blob, recordOffset, recordOffset + 56);
    if (record.getUint32(0, true) !== ZIP64_EOCD_SIG) throw new ZipFormatError('zip64 record missing');
    diskNumber = record.getUint32(16, true);
    entryCount = u64(record, 32);
    cdSize = u64(record, 40);
    cdOffset = u64(record, 48);
  }
  if (diskNumber !== 0) throw new ZipFormatError('multi-disk archives are not supported');
  if (cdSize > MAX_CENTRAL_DIRECTORY_BYTES || cdOffset + cdSize > blob.size) throw new ZipFormatError('invalid central directory');

  const cd = await readBytes(blob, cdOffset, cdOffset + cdSize);
  const bytes = new Uint8Array(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < entryCount; n += 1) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== CENTRAL_SIG) throw new ZipFormatError('invalid central directory entry');
    const versionMadeBy = cd.getUint16(p + 4, true);
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    const crc = cd.getUint32(p + 16, true);
    let compressedSize = cd.getUint32(p + 20, true);
    let uncompressedSize = cd.getUint32(p + 24, true);
    const nameLength = cd.getUint16(p + 28, true);
    const extraLength = cd.getUint16(p + 30, true);
    const commentLength = cd.getUint16(p + 32, true);
    const externalFileAttributes = cd.getUint32(p + 38, true);
    let localHeaderOffset = cd.getUint32(p + 42, true);
    const end = p + 46 + nameLength + extraLength + commentLength;
    if (end > cd.byteLength) throw new ZipFormatError('truncated central directory');
    const rawName = bytes.slice(p + 46, p + 46 + nameLength);
    const extras = parseExtra(new DataView(cd.buffer, cd.byteOffset + p + 46 + nameLength, extraLength));

    const zip64 = extras.find((e) => e.id === 0x0001);
    if (zip64) {
      let o = 0;
      if (uncompressedSize === 0xffffffff) {
        uncompressedSize = u64(zip64.data, o);
        o += 8;
      }
      if (compressedSize === 0xffffffff) {
        compressedSize = u64(zip64.data, o);
        o += 8;
      }
      if (localHeaderOffset === 0xffffffff) localHeaderOffset = u64(zip64.data, o);
    }
    entries.push({
      name: decodeName(rawName, flags, extras),
      versionMadeBy,
      flags,
      method,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      externalFileAttributes,
    });
    p = end;
  }
  return entries;
}

/** Beginn der komprimierten Daten eines Eintrags (aus dem lokalen Header). */
export async function entryDataStart(blob: Blob, entry: ZipEntry): Promise<number> {
  const header = await readBytes(blob, entry.localHeaderOffset, entry.localHeaderOffset + 30);
  if (header.getUint32(0, true) !== LOCAL_SIG) throw new ZipFormatError('invalid local header');
  const start = entry.localHeaderOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  if (start + entry.compressedSize > blob.size) throw new ZipFormatError('entry exceeds archive');
  return start;
}

export function isEncrypted(entry: ZipEntry): boolean {
  return (entry.flags & 0x1) !== 0;
}

const CHUNK = 4 * 1024 * 1024;
export const CRC_LIMIT = 256 * 1024 * 1024;

/**
 * Liest einen Byte-Bereich einer Datei in Abschnitten – bewusst nur mit `slice().arrayBuffer()`.
 * Streams (`blob.stream()`, BYOB-Reader) sind in Safari bei Gigabyte-Dateien unzuverlässig und
 * konnten die Installation anhalten. Jeder Abschnitt ist ein eigener Puffer.
 */
export async function* readRange(blob: Blob, start: number, length: number, _reuse = true): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < length; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, length);
    yield new Uint8Array(await blob.slice(start + offset, start + end).arrayBuffer());
  }
}

/**
 * Liefert den entpackten Inhalt eines Eintrags abschnittsweise. Die Größe wird immer geprüft
 * (gefälschte Angaben/Zip-Bombs brechen ab), die Prüfsumme bis 256 MB.
 * Deflate wird mit fflate (reines JavaScript) entpackt – ohne Browser-Streams, die in Safari hängen können.
 */
export async function* readEntryChunks(blob: Blob, entry: ZipEntry): AsyncGenerator<Uint8Array> {
  const start = await entryDataStart(blob, entry);
  const expected = entry.uncompressedSize;
  let total = 0;
  let crc = 0;
  const verifyCrc = expected <= CRC_LIMIT;
  const check = (chunk: Uint8Array) => {
    total += chunk.byteLength;
    if (total > expected) throw new ZipFormatError('entry larger than declared');
    if (verifyCrc) crc = crc32(chunk, crc);
  };

  if (entry.method === 0) {
    for await (const chunk of readRange(blob, start, entry.compressedSize)) {
      check(chunk);
      yield chunk;
    }
  } else if (entry.method === 8) {
    const out: Uint8Array[] = [];
    let failed: unknown = null;
    const inflate = new Inflate((data) => {
      out.push(data);
    });
    const compressed = entry.compressedSize;
    for (let offset = 0; offset < compressed || offset === 0; offset += CHUNK) {
      const end = Math.min(offset + CHUNK, compressed);
      const input = new Uint8Array(await blob.slice(start + offset, start + end).arrayBuffer());
      try {
        inflate.push(input, end >= compressed);
      } catch (error) {
        failed = error;
      }
      if (failed) throw new ZipFormatError('invalid deflate data');
      while (out.length) {
        const chunk = out.shift()!;
        check(chunk);
        yield chunk;
      }
      if (end >= compressed) break;
    }
  } else {
    throw new ZipFormatError('unsupported compression');
  }
  if (total !== expected) throw new ZipFormatError('entry size mismatch');
  if (verifyCrc && crc !== entry.crc32) throw new ZipFormatError('crc mismatch');
}

/** Entpackter Inhalt als Stream (für kleine Dateien und Tests; kopiert jeden Abschnitt). */
export async function openEntryStream(blob: Blob, entry: ZipEntry): Promise<ReadableStream<Uint8Array>> {
  const chunks = readEntryChunks(blob, entry);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(value.slice());
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}

export async function readEntryText(blob: Blob, entry: ZipEntry, maxBytes: number): Promise<string> {
  if (entry.uncompressedSize > maxBytes) return '';
  const stream = await openEntryStream(blob, entry);
  return new Response(stream).text();
}
