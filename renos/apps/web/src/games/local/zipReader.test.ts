// @vitest-environment node
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { EntryScanner, summarizeArchive } from '@renos/shared';
import { makeZip, webBuildEntries } from '../../../../server/test/helpers/zip';
import { crc32 } from './crc32';
import { openEntryStream, readCentralDirectory, readEntryText } from './zipReader';

const blobOf = (buffer: Buffer) => new Blob([new Uint8Array(buffer)]);
const readAll = async (stream: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(stream).arrayBuffer());

/** Archiv mit ZIP64-Feldern (wie von Werkzeugen für Archive über 4 GB erzeugt). */
function makeZip64(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name);
  const payload = deflateRawSync(data);
  const crc = zlibCrc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(45, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(0xffffffff, 18);
  local.writeUInt32LE(0xffffffff, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const localExtra = Buffer.alloc(20);
  localExtra.writeUInt16LE(0x0001, 0);
  localExtra.writeUInt16LE(16, 2);
  localExtra.writeBigUInt64LE(BigInt(data.length), 4);
  localExtra.writeBigUInt64LE(BigInt(payload.length), 12);
  local.writeUInt16LE(localExtra.length, 28);
  const localPart = Buffer.concat([local, nameBuf, localExtra, payload]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 45, 4);
  central.writeUInt16LE(45, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(0xffffffff, 20);
  central.writeUInt32LE(0xffffffff, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  const extra = Buffer.alloc(28);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(24, 2);
  extra.writeBigUInt64LE(BigInt(data.length), 4);
  extra.writeBigUInt64LE(BigInt(payload.length), 12);
  extra.writeBigUInt64LE(0n, 20);
  central.writeUInt16LE(extra.length, 30);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  central.writeUInt32LE(0xffffffff, 42);
  const centralPart = Buffer.concat([central, nameBuf, extra]);

  const cdOffset = localPart.length;
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(1n, 24);
  record.writeBigUInt64LE(1n, 32);
  record.writeBigUInt64LE(BigInt(centralPart.length), 40);
  record.writeBigUInt64LE(BigInt(cdOffset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(cdOffset + centralPart.length), 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([localPart, centralPart, record, locator, end]);
}

describe('crc32', () => {
  it('matches zlib for arbitrary data', () => {
    const data = new Uint8Array(100_003).map((_, i) => (i * 31 + 7) & 0xff);
    expect(crc32(data)).toBe(zlibCrc32(data));
    expect(crc32(data.subarray(50_000), crc32(data.subarray(0, 50_000)))).toBe(zlibCrc32(data));
  });
});

describe('browser zip reader', () => {
  it('reads entries and decompresses with size and CRC checks', async () => {
    const zip = blobOf(makeZip(webBuildEntries('Spiel-web/', 'Sternenlicht')));
    const entries = await readCentralDirectory(zip);
    expect(entries.map((e) => e.name)).toContain('Spiel-web/renpy.wasm');
    const index = entries.find((e) => e.name.endsWith('index.html'))!;
    expect(await readEntryText(zip, index, 1024 * 1024)).toContain('<title>Sternenlicht</title>');
    const data = entries.find((e) => e.name.endsWith('renpy.data'))!;
    expect((await readAll(await openEntryStream(zip, data))).length).toBe(2048);
  });

  it('produces the same analysis as the server rules', async () => {
    const zip = blobOf(makeZip([...webBuildEntries('Spiel-web/', 'Sternenlicht'), { name: '../evil.js', data: 'x' }]));
    const entries = await readCentralDirectory(zip);
    const scanner = new EntryScanner({ maxEntries: 100, maxUncompressedBytes: 1e9, maxCompressionRatio: 200 });
    const files = new Map<string, number>();
    for (const e of entries) {
      const scanned = scanner.accept({ name: e.name, externalFileAttributes: e.externalFileAttributes, encrypted: false, compressionMethod: e.method, compressedSize: e.compressedSize, uncompressedSize: e.uncompressedSize });
      if (scanned && !scanned.isDirectory) files.set(scanned.path, scanned.size);
    }
    const analysis = summarizeArchive({ files, directoryCount: 0, indexHtml: new Map(), fileName: 'x.zip', compressedBytes: zip.size, declaredUncompressed: scanner.declaredUncompressed, issues: scanner.issues });
    expect(analysis.kind).toBe('renpy-web');
    expect(analysis.installable).toBe(false);
    expect(analysis.issues.map((i) => i.code)).toContain('path_traversal');
  });

  it('supports ZIP64 archives', async () => {
    const zip = blobOf(makeZip64('groß/datei.bin', Buffer.alloc(70_000, 9)));
    const [entry] = await readCentralDirectory(zip);
    expect(entry).toMatchObject({ name: 'groß/datei.bin', uncompressedSize: 70_000, localHeaderOffset: 0 });
    const out = await readAll(await openEntryStream(zip, entry!));
    expect(out.length).toBe(70_000);
    expect(out[69_999]).toBe(9);
  });

  it('aborts when an entry contains more data than declared (zip bomb)', async () => {
    const zip = blobOf(makeZip([{ name: 'liar.bin', data: Buffer.alloc(64 * 1024, 1), declaredSize: 1000 }]));
    const [entry] = await readCentralDirectory(zip);
    await expect(readAll(await openEntryStream(zip, entry!))).rejects.toThrow();
  });

  it('detects corrupted data via CRC32', async () => {
    const buffer = makeZip([{ name: 'a.txt', data: 'Hallo Welt, das ist ein Test', method: 0 }]);
    const pos = buffer.indexOf(Buffer.from('Hallo'));
    buffer[pos] = 'X'.charCodeAt(0);
    const zip = blobOf(buffer);
    const [entry] = await readCentralDirectory(zip);
    await expect(readAll(await openEntryStream(zip, entry!))).rejects.toThrow(/crc/);
  });

  it('decodes CP437 names and normalises backslashes', async () => {
    const buffer = makeZip([{ name: 'ordner\\datei.txt', data: 'x' }]);
    // UTF-8-Flag entfernen und ein CP437-Zeichen (0x84 = ä) einsetzen.
    const name = Buffer.from('ordner\\datei.txt');
    let i = buffer.indexOf(name);
    while (i >= 0) {
      buffer[i + 7] = 0x84;
      i = buffer.indexOf(name, i + 1);
    }
    buffer.writeUInt16LE(0, 6);
    buffer.writeUInt16LE(0, buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
    const [entry] = await readCentralDirectory(blobOf(buffer));
    expect(entry!.name).toBe('ordner/äatei.txt');
  });

  it('rejects files that are not zip archives', async () => {
    await expect(readCentralDirectory(new Blob(['kein zip, nur Text mit genug Länge für den Test']))).rejects.toThrow();
  });
});
