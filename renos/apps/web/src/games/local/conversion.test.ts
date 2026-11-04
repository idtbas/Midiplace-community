// @vitest-environment node
import { crc32 as zlibCrc32, deflateRawSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32 } from './crc32';
import {
  CLASSIFY_LIMITS,
  Classifier,
  PLACEHOLDER_PNG,
  chooseGameRoot,
  chooseRuntime,
  detectPlatforms,
  detectPython,
  mediaKind,
  parseEngineVersion,
  placeholderPng,
  remoteFilesText,
  skipGameFile,
} from './desktop';
import { imageSize } from './imageSize';
import { PickleError, PyBytes, PyDict, type PyTuple, unpickle } from './pickle';
import { RpaError, memberBlob, readRpaIndex } from './rpa';
import { ZipWriter } from './zipWriter';
import { readCentralDirectory, readEntryChunks } from './zipReader';

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const KEY = 0x42424242;

// Mit Python erzeugt (pickle.dumps(...)) – siehe TESTING.md.
const P5 = 'gAWVSwAAAAAAAAB9lCiMEmltYWdlcy9iZyBjbHViLmpwZ5RdlEomQkJCSnBCQkJDAJSHlGGMC3NjcmlwdC5ycHljlF2UStRCQkJKVkJCQmgDh5RhdS4=';
const P0 = 'KGRwMApWYS5wbmcKcDEKKGxwMgooSTEKSTIKVgpwMwp0cDQKYXNWc3ViL2Iub2dnCnA1CihscDYKKEkzCkk0ClZ4eQpwNwp0cDgKYXMu';
const PBIG = 'gAJ9cQBYCAAAAGJpZy53ZWJtcQFdcQKKBkJCQkIAAUpHQkJCY19fYnVpbHRpbl9fCmJ5dGVzCnEDKVJxBIdxBWFzLg==';
const PEVIL = 'gAJ9cQBYAQAAAGFxAWNwb3NpeApzeXN0ZW0KcQJYCgAAAGVjaG8gcHduZWRxA4VxBFJxBXMu';

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of chunks) parts.push(c.slice());
  return new Uint8Array(Buffer.concat(parts));
}

describe('Pickle-Leser (Index von .rpa-Archiven)', () => {
  it('liest Protokoll 5 (Ren’Py 8) mit FRAME, MEMOIZE und Bytes', () => {
    const v = unpickle(b64(P5));
    expect(v).toBeInstanceOf(PyDict);
    const entries = (v as PyDict).entries;
    expect(entries.map(([k]) => k)).toEqual(['images/bg club.jpg', 'script.rpyc']);
    const first = (entries[0]![1] as unknown[])[0] as PyTuple;
    expect(first.items[0]).toBe(100 ^ KEY);
    expect(first.items[2]).toBeInstanceOf(PyBytes);
  });

  it('liest das Textprotokoll 0 und große Zahlen (LONG1)', () => {
    const v = unpickle(b64(P0)) as PyDict;
    expect(v.entries.map(([k]) => k)).toEqual(['a.png', 'sub/b.ogg']);
    const big = unpickle(b64(PBIG)) as PyDict;
    const tuple = (big.entries[0]![1] as unknown[])[0] as PyTuple;
    expect(tuple.items[0]).toBe(Number(BigInt(2 ** 40) ^ BigInt(KEY)));
    expect((tuple.items[2] as PyBytes).data.byteLength).toBe(0);
  });

  it('führt keinen Code aus: fremde Aufrufe werden abgelehnt', () => {
    expect(() => unpickle(b64(PEVIL))).toThrow(PickleError);
    expect(() => unpickle(new Uint8Array([0x80, 0x02, 0x7d]))).toThrow(PickleError);
  });
});

function makeRpa(files: Record<string, Uint8Array>, pickleIndex: (index: Record<string, [number, number]>) => Uint8Array): Blob {
  const header = 'RPA-3.0 XXXXXXXXXXXXXXXX XXXXXXXX\n';
  const parts: Uint8Array[] = [new TextEncoder().encode(header)];
  let offset = header.length;
  const index: Record<string, [number, number]> = {};
  for (const [name, data] of Object.entries(files)) {
    index[name] = [offset ^ KEY, data.byteLength ^ KEY];
    parts.push(data);
    offset += data.byteLength;
  }
  const compressed = new Uint8Array(deflateSync(pickleIndex(index)));
  const realHeader = `RPA-3.0 ${offset.toString(16).padStart(16, '0')} ${KEY.toString(16)}\n`;
  parts[0] = new TextEncoder().encode(realHeader);
  parts.push(compressed);
  return new Blob(parts as Uint8Array<ArrayBuffer>[]);
}

/** Pickle (Protokoll 2) wie Ren'Py 7: {name: [(offset, length, '')]} mit BINUNICODE und SHORT_BINSTRING. */
function py2Pickle(index: Record<string, [number, number]>): Uint8Array {
  const out: number[] = [0x80, 0x02, 0x7d, 0x28];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const [name, [o, l]] of Object.entries(index)) {
    const bytes = [...new TextEncoder().encode(name)];
    out.push(0x58, ...u32(bytes.length), ...bytes);
    out.push(0x5d, 0x4a, ...u32(o), 0x4a, ...u32(l), 0x55, 0x00, 0x87, 0x61);
  }
  out.push(0x75, 0x2e);
  return Uint8Array.from(out);
}

describe('Ren’Py-Archive (.rpa)', () => {
  it('liest RPA-3.0, entschlüsselt Positionen und liefert Dateien als Ausschnitt', async () => {
    const png = new Uint8Array([1, 2, 3, 4, 5]);
    const rpyc = new TextEncoder().encode('script');
    const blob = makeRpa({ 'images/a.png': png, 'script.rpyc': rpyc, '../../böse.txt': rpyc, 'C:\\win\\x.png': png }, py2Pickle);
    const { index, skipped, format } = await readRpaIndex(blob);
    expect(format).toBe('RPA-3.0');
    // Unsichere Pfade werden nicht übernommen, Backslashes werden zu „/“.
    expect(index.has('images/a.png') && index.has('script.rpyc')).toBe(true);
    expect([...index.keys()].some((k) => k.includes('..') || k.includes('\\'))).toBe(false);
    expect(skipped).toBeGreaterThanOrEqual(1);
    const member = index.get('images/a.png')!;
    expect(new Uint8Array(await memberBlob(blob, member).arrayBuffer())).toEqual(png);
    expect(await memberBlob(blob, index.get('script.rpyc')!).text()).toBe('script');
  });

  it('meldet unbekannte Archivformate verständlich', async () => {
    const blob = new Blob([new TextEncoder().encode('ALT-1.0 0000\n'), new Uint8Array(64)]);
    await expect(readRpaIndex(blob)).rejects.toMatchObject({ header: 'ALT-1.0 0000' });
    await expect(readRpaIndex(new Blob([new TextEncoder().encode('RPA-3.0 00000000000000ff 42424242\n')]))).rejects.toBeInstanceOf(RpaError);
  });
});

describe('Bildgröße aus dem Dateikopf', () => {
  it('erkennt PNG, JPEG, WebP und AVIF', () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 1920);
    new DataView(png.buffer).setUint32(20, 1080);
    expect(imageSize(png)).toEqual({ width: 1920, height: 1080 });
    expect(imageSize(PLACEHOLDER_PNG)).toEqual({ width: 1, height: 1 });
    // Platzhalter in Originalgröße: korrekte Maße, trotzdem winzig.
    const ph = placeholderPng(1920, 1080);
    expect(imageSize(ph)).toEqual({ width: 1920, height: 1080 });
    expect(ph.byteLength).toBeLessThan(2048);

    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0, 0, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ width: 1280, height: 720 });

    const vp8x = new Uint8Array(30);
    vp8x.set(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8X'));
    vp8x.set([0x7f, 0x07, 0x00, 0x37, 0x04, 0x00], 24); // 1920 × 1080
    expect(imageSize(vp8x)).toEqual({ width: 1920, height: 1080 });

    const avif = new Uint8Array(64);
    avif.set(new TextEncoder().encode('\0\0\0\x18ftypavif'));
    avif.set(new TextEncoder().encode('ispe'), 32);
    new DataView(avif.buffer).setUint32(40, 800);
    new DataView(avif.buffer).setUint32(44, 600);
    expect(imageSize(avif)).toEqual({ width: 800, height: 600 });

    expect(imageSize(new TextEncoder().encode('<svg width="10" height="10"></svg>'))).toBeNull();
  });
});

describe('ZIP-Schreiber', () => {
  it('schreibt gespeicherte und unverändert übernommene Deflate-Einträge, die der Leser prüft', async () => {
    const chunks: Uint8Array[] = [];
    const writer = new ZipWriter({ write: (c) => void chunks.push(c.slice()) });
    const text = new TextEncoder().encode('label start:\n    "Hallo"\n'.repeat(50));
    const deflated = new Uint8Array(deflateRawSync(text));
    await writer.addBytes('game/a.txt', new TextEncoder().encode('A'));
    await writer.addRaw({ name: 'game/script.rpy', method: 8, crc: zlibCrc32(text), compressedSize: deflated.byteLength, uncompressedSize: text.byteLength, data: [deflated] });
    await writer.addBytes('_placeholders/images/ä.png', PLACEHOLDER_PNG);
    await expect(writer.addBytes('game/a.txt', new Uint8Array(1))).rejects.toThrow();
    await writer.finish();
    const blob = new Blob(chunks as Uint8Array<ArrayBuffer>[]);
    const entries = await readCentralDirectory(blob);
    expect(entries.map((e) => e.name)).toEqual(['game/a.txt', 'game/script.rpy', '_placeholders/images/ä.png']);
    expect(await collect(readEntryChunks(blob, entries[1]!))).toEqual(text);
    expect(await collect(readEntryChunks(blob, entries[2]!))).toEqual(PLACEHOLDER_PNG);
  });

  it('verwendet ZIP64 bei mehr als 65 535 Einträgen', async () => {
    const chunks: Uint8Array[] = [];
    const writer = new ZipWriter({ write: (c) => void chunks.push(c.slice()) });
    const crc = crc32(PLACEHOLDER_PNG);
    for (let i = 0; i < 70_000; i += 1) {
      await writer.addRaw({ name: `_placeholders/${i}.png`, method: 0, crc, compressedSize: PLACEHOLDER_PNG.length, uncompressedSize: PLACEHOLDER_PNG.length, data: [PLACEHOLDER_PNG] });
    }
    await writer.finish();
    const entries = await readCentralDirectory(new Blob(chunks as Uint8Array<ArrayBuffer>[]));
    expect(entries.length).toBe(70_000);
    expect(entries[69_999]!.name).toBe('_placeholders/69999.png');
  });
});

describe('Planung der Umwandlung von Desktop-Builds', () => {
  const pc = [
    'Spiel-1.0-pc/Spiel.exe',
    'Spiel-1.0-pc/Spiel.sh',
    'Spiel-1.0-pc/lib/py3-linux-x86_64/python',
    'Spiel-1.0-pc/lib/py3-windows-x86_64/python.exe',
    'Spiel-1.0-pc/renpy/__init__.py',
    'Spiel-1.0-pc/renpy/common/00start.rpy',
    'Spiel-1.0-pc/game/scripts.rpa',
    'Spiel-1.0-pc/game/gui/game_menu.png',
  ];

  it('findet den Spielordner in Windows/Linux-, Mac- und reinen game/-Archiven', () => {
    expect(chooseGameRoot(pc)).toBe('Spiel-1.0-pc/');
    expect(chooseGameRoot(['Spiel.app/Contents/Resources/autorun/game/script.rpyc', 'Spiel.app/Contents/MacOS/Spiel'])).toBe('Spiel.app/Contents/Resources/autorun/');
    expect(chooseGameRoot(['game/script.rpy', 'game/images/a.png'])).toBe('');
    expect(chooseGameRoot(['Ordner/bilder/a.png'])).toBeNull();
    expect(detectPlatforms(pc, 'Spiel-1.0-pc/')).toEqual(['windows', 'linux']);
  });

  it('erkennt Version und Python-Generation', () => {
    expect(parseEngineVersion("version = '8.1.3.23091805'\n", null)).toEqual({ version: '8.1.3', major: 8 });
    expect(parseEngineVersion("vc_version = 1234\n", 'version_tuple = (7, 3, 5, vc_version)')).toEqual({ version: '7.3.5', major: 7 });
    expect(parseEngineVersion(null, "version = \"Ren'Py 6.99.12\"")).toEqual({ version: '6.99.12', major: 6 });
    expect(parseEngineVersion(null, null)).toEqual({ version: null, major: null });
    expect(detectPython(pc, 'Spiel-1.0-pc/', null)).toBe(3);
    expect(detectPython(['x/lib/py2-linux-x86_64/a'], 'x/', null)).toBe(2);
    expect(detectPython(['x/game/a.rpyc'], 'x/', 7)).toBe(2);
    expect(detectPython(['x/lib/windows-i686/python.exe'], 'x/', null)).toBe(2);
    expect(detectPython(['x/game/a.rpyc'], 'x/', null)).toBeNull();
  });

  it('lässt Caches, Spielstände, Archive und Programme weg', () => {
    for (const p of ['cache/bytecode-312.rpyb', 'saves/1-1-LT1.save', 'scripts.rpa', 'python-packages/__pycache__/x.pyc', 'log.txt', 'lib.dll', 'renpyweb_remote_files.txt']) {
      expect(skipGameFile(p)).toBe(true);
    }
    for (const p of ['script.rpyc', 'tl/german/common.rpy', 'fonts/a.ttf', 'images/log.txt.png']) expect(skipGameFile(p)).toBe(false);
  });

  it('lädt GUI und kleine Dateien sofort, große Medien bei Bedarf', async () => {
    const c = new Classifier(CLASSIFY_LIMITS);
    const dims = async () => ({ width: 1920, height: 1080 });
    const none = async () => null;
    expect(await c.place('gui/main_menu.png', 2_000_000, dims)).toEqual({ kind: 'local' });
    expect(await c.place('images/bg club.jpg', 984_435, dims)).toEqual({ kind: 'remote', meta: 'image 1920,1080' });
    expect(await c.place('images/icon.png', 4_000, dims)).toEqual({ kind: 'local' });
    expect(await c.place('images/kaputt.png', 900_000, none)).toEqual({ kind: 'local' });
    expect(await c.place('illurock.opus', 234_646, dims)).toEqual({ kind: 'remote', meta: 'music -' });
    expect(await c.place('sfx/click.ogg', 8_000, dims)).toEqual({ kind: 'local' });
    expect(await c.place('voice/ch1/0001.ogg', 8_000, dims)).toEqual({ kind: 'remote', meta: 'voice -' });
    expect(await c.place('movies/op.webm', 50_000_000, dims)).toEqual({ kind: 'remote', meta: 'video -' });
    expect(await c.place('script.rpyc', 50_000_000, dims)).toEqual({ kind: 'local' });
    expect(mediaKind('a.AVIF')).toBe('image');
  });

  it('schreibt die Liste nachladbarer Dateien im Format des Ren’Py-Launchers', () => {
    expect(remoteFilesText(new Map([['images/b.png', 'image 10,20'], ['audio/a.ogg', 'music -']]))).toBe('audio/a.ogg\nmusic -\nimages/b.png\nimage 10,20\n');
  });

  it('wählt die passende Ren’Py-Laufzeit', () => {
    const list = [
      { id: 'renpy-8.6.0', python: 3, version: '8.6.0' },
      { id: 'renpy-8.10.0', python: 3, version: '8.10.0' },
      { id: 'renpy-7.8.7', python: 2, version: '7.8.7' },
    ];
    expect(chooseRuntime(list, 3)?.id).toBe('renpy-8.10.0');
    expect(chooseRuntime(list, 2)?.id).toBe('renpy-7.8.7');
    expect(chooseRuntime(list, null)?.id).toBe('renpy-8.10.0');
    expect(chooseRuntime(list.slice(0, 2), 2)).toBeNull();
  });
});
