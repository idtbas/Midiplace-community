import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Minimaler ZIP-Writer für Tests. Erlaubt bewusst auch ungültige und bösartige Einträge
 * (Traversal-Pfade, Symlinks, falsche Größenangaben), die normale ZIP-Bibliotheken verweigern.
 */
export interface ZipEntrySpec {
  name: string;
  data?: Buffer | string;
  /** 0 = gespeichert, 8 = deflate */
  method?: 0 | 8;
  /** Unix-Modus inklusive Dateityp (z. B. 0o100644, 0o120777 für Symlinks) */
  mode?: number;
  /** Überschreibt die angegebene unkomprimierte Größe (für Zip-Bomb-Tests). */
  declaredSize?: number;
  encrypted?: boolean;
}

export function makeZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const spec of entries) {
    const name = Buffer.from(spec.name, 'utf8');
    const raw = typeof spec.data === 'string' ? Buffer.from(spec.data, 'utf8') : (spec.data ?? Buffer.alloc(0));
    const isDir = spec.name.endsWith('/');
    const method = isDir ? 0 : (spec.method ?? 8);
    const payload = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const size = spec.declaredSize ?? raw.length;
    const flags = 0x0800 | (spec.encrypted ? 0x0001 : 0);
    const mode = spec.mode ?? (isDir ? 0o040755 : 0o100644);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuffer, end]);
}

/** Ein kleiner, strukturell korrekter Ren'Py-Web-Build (ohne echte Laufzeit) für Tests. */
export function webBuildEntries(prefix = '', title = 'Testspiel'): ZipEntrySpec[] {
  return [
    { name: `${prefix}index.html`, data: `<!doctype html><html><head><title>${title}</title></head><body><canvas id="canvas"></canvas></body></html>` },
    { name: `${prefix}renpy.js`, data: 'console.log("renpy");' },
    { name: `${prefix}renpy.wasm`, data: Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]) },
    { name: `${prefix}renpy.data`, data: Buffer.alloc(2048, 7) },
    { name: `${prefix}game.zip`, data: Buffer.alloc(4096, 3), method: 0 },
    { name: `${prefix}renpy-pre.js`, data: '/* pre */' },
    { name: `${prefix}web-presplash.png`, data: tinyPng() },
  ];
}

/** 1×1-PNG */
export function tinyPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
}
