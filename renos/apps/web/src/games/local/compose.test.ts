// @vitest-environment node
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BASE_LIST, OVERLAY_LIST, REMOTE_LIST, composeGameZip, parseRemoteList, upgradeChanged } from './compose';
import { crc32 } from './crc32';
import { PLACEHOLDER_MARKER, PLACEHOLDER_PNG } from './desktop';
import { classifyOverlayFile, validOverlayPath } from './overlay';
import { RENOS_HOST_PY, RENPYTFD_PY, WEBSTUB, WEBSTUB_ENTRY, WEB_SUPPORT_RPY } from './webSupport';
import { BlobPartsSink, ZipWriter } from './zipWriter';
import { readCentralDirectory, readEntryChunks, type ZipEntry } from './zipReader';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function bytesOf(zip: Blob, entry: ZipEntry): Promise<Uint8Array> {
  const parts: number[] = [];
  for await (const chunk of readEntryChunks(zip, entry)) parts.push(...chunk);
  return Uint8Array.from(parts);
}

async function readZip(zip: Blob): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const entry of await readCentralDirectory(zip)) out.set(entry.name, await bytesOf(zip, entry));
  return out;
}

/** game.zip wie von der ersten Fassung der Umwandlung erzeugt. */
async function legacyGameZip(): Promise<Blob> {
  const sink = new BlobPartsSink();
  const writer = new ZipWriter(sink);
  const engine = enc.encode('# Engine\n'.repeat(200));
  const deflated = deflateRawSync(engine);
  await writer.addRaw({ name: 'renpy/__init__.py', method: 8, crc: zlibCrc32(engine), compressedSize: deflated.byteLength, uncompressedSize: engine.byteLength, data: [new Uint8Array(deflated)] });
  await writer.addBytes('game/script.rpy', enc.encode('label start:\n    john a_11 : a_4, patty a_4: a_11\n'));
  await writer.addBytes('game/script.rpyc', enc.encode('compiled'));
  await writer.addBytes('game/options.rpy', enc.encode('define config.name = "Test"\n'));
  await writer.addBytes('game/scenario/x.rpym', enc.encode('source'));
  await writer.addBytes('game/scenario/x.rpymc', enc.encode('compiled'));
  await writer.addBytes(REMOTE_LIST, enc.encode('images/bg.png\nimage 1280,720\nmusic/a.ogg\nmusic -\nimages/new.webp\nimage 64,32\n'));
  await writer.addBytes('_placeholders/images/bg.png', PLACEHOLDER_PNG);
  await writer.addBytes('js.py', enc.encode(WEBSTUB_ENTRY));
  await writer.addBytes('game/python-packages/js.py', enc.encode(WEBSTUB_ENTRY));
  await writer.addBytes('_renpytfd.py', enc.encode(WEBSTUB_ENTRY));
  await writer.addBytes('_renos_webstub.py', enc.encode('# alte Fassung\n'));
  // Das Spiel bringt ein eigenes Modul „steamworks“ mit.
  await writer.addBytes('game/python-packages/steamworks/__init__.py', enc.encode('STEAM = True\n'));
  await writer.finish();
  return sink.toBlob();
}

function pngSize(data: Uint8Array): [number, number] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

const lines = (data: Uint8Array | undefined) => dec.decode(data).split('\n').filter(Boolean);

describe('game.zip für den Start', () => {
  it('liest die Liste nachladbarer Dateien', () => {
    expect([...parseRemoteList('a.png\nimage 1,2\nb.ogg\nmusic -\n')]).toEqual([
      ['a.png', 'image 1,2'],
      ['b.ogg', 'music -'],
    ]);
  });

  it('repariert ältere Umwandlungen: .rpy neben .rpyc, Platzhalter am echten Pfad, Hilfsdateien', async () => {
    const { blob, report } = await composeGameZip(await legacyGameZip(), { upgrade: true });
    expect(upgradeChanged(report)).toBe(true);
    const files = await readZip(blob);

    expect(files.has('game/script.rpy')).toBe(false);
    expect(files.has('game/scenario/x.rpym')).toBe(false);
    expect(files.has('game/script.rpyc')).toBe(true);
    expect(files.has('game/options.rpy')).toBe(true);
    expect(report.droppedSources).toBe(2);
    // Unveränderte Einträge (auch komprimierte) sind byte-genau übernommen.
    expect(dec.decode(files.get('renpy/__init__.py'))).toBe('# Engine\n'.repeat(200));

    // Platzhalter am echten Pfad – findbar mit os.walk; Bilder in echter Größe mit Kennzeichen, Audio leer.
    expect(pngSize(files.get('game/images/bg.png')!)).toEqual([1280, 720]);
    expect(dec.decode(files.get('game/images/bg.png')!.subarray(0, 64))).toContain(PLACEHOLDER_MARKER);
    expect(pngSize(files.get('game/images/new.webp')!)).toEqual([64, 32]);
    expect(files.get('game/music/a.ogg')!.byteLength).toBe(0);
    expect([...files.keys()].some((n) => n.startsWith('_placeholders/'))).toBe(false);

    // Unterstützungsskript, Verbindung zu RenOS und echte Datei-Dialoge.
    expect(dec.decode(files.get('game/renos_web_support.rpy'))).toBe(WEB_SUPPORT_RPY);
    expect(dec.decode(files.get('_renos_webstub.py'))).toBe(WEBSTUB);
    expect(dec.decode(files.get('game/python-packages/_renos_host.py'))).toBe(RENOS_HOST_PY);
    expect(dec.decode(files.get('_renpytfd.py'))).toBe(RENPYTFD_PY);
    expect(dec.decode(files.get('game/python-packages/micropip.py'))).toBe(WEBSTUB_ENTRY);
    // Eigenes Modul des Spiels bleibt, kein Ersatz.
    expect(files.has('game/python-packages/steamworks.py')).toBe(false);

    // Liste der Dateien aus der game.zip für den Abgleich im Spiel.
    const base = lines(files.get(BASE_LIST));
    expect(base).toEqual(expect.arrayContaining(['script.rpyc', 'images/bg.png', 'music/a.ogg', 'renos_web_support.rpy']));
    expect(base).not.toContain('script.rpy');
    expect(lines(files.get(OVERLAY_LIST))).toEqual([]);
  });

  it('ist idempotent und prüft die Prüfsummen aller Einträge', async () => {
    const first = await composeGameZip(await legacyGameZip(), { upgrade: true });
    const second = await composeGameZip(first.blob, { upgrade: true });
    expect(upgradeChanged(second.report)).toBe(false);
    for (const entry of await readCentralDirectory(second.blob)) {
      expect(crc32(await bytesOf(second.blob, entry)) >>> 0).toBe(entry.crc32 >>> 0);
    }
  });

  it('gibt vom Spiel angelegte Dateien mit: Skripte direkt, große Bilder zum Nachladen', async () => {
    const { blob } = await composeGameZip(await legacyGameZip(), { upgrade: true });
    const script = new Blob(['label szenario:\n    "Hallo"\n']);
    const image = new Blob([new Uint8Array(100_000)]);
    const { blob: withOverlay, report } = await composeGameZip(blob, {
      upgrade: false,
      overlay: [
        { path: 'game/scenario/neu/story.rpy', blob: script, size: script.size, kind: 'local', meta: '' },
        { path: 'game/scenario/neu/bg/park.webp', blob: image, size: image.size, kind: 'remote', meta: 'image 800,600' },
      ],
    });
    expect(report.overlayFiles).toBe(2);
    const files = await readZip(withOverlay);
    expect(dec.decode(files.get('game/scenario/neu/story.rpy'))).toContain('label szenario');
    expect(pngSize(files.get('game/scenario/neu/bg/park.webp')!)).toEqual([800, 600]);
    const remote = parseRemoteList(dec.decode(files.get(REMOTE_LIST)));
    expect(remote.get('scenario/neu/bg/park.webp')).toBe('image 800,600');
    expect(remote.get('images/bg.png')).toBe('image 1280,720');
    expect(lines(files.get(OVERLAY_LIST))).toEqual(expect.arrayContaining([`scenario/neu/story.rpy\t${script.size}`, 'scenario/neu/bg/park.webp\t-1']));
    expect(lines(files.get(BASE_LIST))).not.toContain('scenario/neu/story.rpy');
  });
});

describe('Python-Module für die Spiele', () => {
  it('sind reines ASCII ohne Kodierungszeile (Ren’Py 7 übersetzt sie als Unicode-Text)', () => {
    for (const source of [RENOS_HOST_PY, RENPYTFD_PY]) {
      expect([...source].every((c) => c.charCodeAt(0) < 128)).toBe(true);
      expect(source).not.toMatch(/coding[:=]/);
    }
  });
});

describe('vom Spiel angelegte Dateien', () => {
  it('nimmt nur Pfade im Spielordner an', () => {
    expect(validOverlayPath('game/scenario/x/scenario.yml')).toBe(true);
    for (const bad of ['game/../x', '/game/a', 'renpy/x.py', 'game//a', 'game/a\\b', 'game/renos_base.txt', 'game/renpyweb_remote_files.txt', 'game/python-packages/_renos_host.py', 'game/a\u0000b', 42]) {
      expect(validOverlayPath(bad)).toBe(false);
    }
  });

  it('lädt große Medien bei Bedarf nach, Skripte und kleine Dateien sofort', async () => {
    expect(await classifyOverlayFile('game/scenario/x/story.rpy', new Blob(['x']))).toEqual({ kind: 'local', meta: '' });
    expect(await classifyOverlayFile('game/scenario/x/movie.webm', new Blob(['x']))).toEqual({ kind: 'remote', meta: 'video -' });
    expect(await classifyOverlayFile('game/scenario/x/sfx/a.ogg', new Blob([new Uint8Array(10)]))).toEqual({ kind: 'local', meta: '' });
    expect(await classifyOverlayFile('game/scenario/x/music/a.ogg', new Blob([new Uint8Array(400_000)]))).toEqual({ kind: 'remote', meta: 'music -' });
  });
});
