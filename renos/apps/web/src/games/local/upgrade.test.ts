// @vitest-environment node
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32 } from './crc32';
import { PLACEHOLDER_PNG } from './desktop';
import { REMOTE_LIST, parseRemoteList, upgradeGameZip } from './upgrade';
import { WEBSTUB, WEBSTUB_ENTRY, WEB_SUPPORT_RPY } from './webSupport';
import { BlobPartsSink, ZipWriter } from './zipWriter';
import { readCentralDirectory, readEntryChunks, type ZipEntry } from './zipReader';

const enc = new TextEncoder();

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

describe('Reparatur älterer Umwandlungen', () => {
  it('liest die Liste nachladbarer Dateien', () => {
    expect([...parseRemoteList('a.png\nimage 1,2\nb.ogg\nmusic -\n')]).toEqual([
      ['a.png', 'image 1,2'],
      ['b.ogg', 'music -'],
    ]);
  });

  it('lässt .rpy neben .rpyc weg, korrigiert Platzhalter und ergänzt Hilfsdateien', async () => {
    const result = await upgradeGameZip(await legacyGameZip());
    expect(result).not.toBeNull();
    const files = await readZip(result!.blob);

    // Quelltext mit kompilierter Fassung fehlt, Quelltext ohne kompilierte Fassung bleibt.
    expect(files.has('game/script.rpy')).toBe(false);
    expect(files.has('game/scenario/x.rpym')).toBe(false);
    expect(files.has('game/script.rpyc')).toBe(true);
    expect(files.has('game/options.rpy')).toBe(true);
    expect(result!.report.droppedSources).toBe(2);

    // Unveränderte Einträge (auch komprimierte) sind byte-genau übernommen.
    expect(new TextDecoder().decode(files.get('renpy/__init__.py'))).toBe('# Engine\n'.repeat(200));

    // Platzhalter in echter Größe (ersetzt und ergänzt).
    expect(pngSize(files.get('_placeholders/images/bg.png')!)).toEqual([1280, 720]);
    expect(pngSize(files.get('_placeholders/images/new.webp')!)).toEqual([64, 32]);
    expect(files.has('_placeholders/music/a.ogg')).toBe(false);

    // Unterstützungsskript und Ersatz-Module.
    expect(new TextDecoder().decode(files.get('game/renos_web_support.rpy'))).toBe(WEB_SUPPORT_RPY);
    expect(new TextDecoder().decode(files.get('_renos_webstub.py'))).toBe(WEBSTUB);
    expect(new TextDecoder().decode(files.get('game/python-packages/_renpytfd.py'))).toBe(WEBSTUB_ENTRY);
    expect(files.has('pyodide/__init__.py')).toBe(true);
    // Eigenes Modul des Spiels bleibt, kein Ersatz.
    expect(files.has('game/python-packages/steamworks.py')).toBe(false);
    expect(new TextDecoder().decode(files.get('game/python-packages/steamworks/__init__.py'))).toBe('STEAM = True\n');
  });

  it('ist idempotent: eine aktuelle game.zip bleibt unverändert', async () => {
    const first = await upgradeGameZip(await legacyGameZip());
    expect(await upgradeGameZip(first!.blob)).toBeNull();
  });

  it('prüft die Prüfsummen der neuen Einträge', async () => {
    const result = await upgradeGameZip(await legacyGameZip());
    for (const entry of await readCentralDirectory(result!.blob)) {
      if (entry.name.endsWith('/')) continue;
      expect(crc32(await bytesOf(result!.blob, entry)) >>> 0).toBe(entry.crc32 >>> 0);
    }
  });
});
