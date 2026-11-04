import { crc32 } from './crc32';

/**
 * ZIP-Schreiber für die game.zip umgewandelter Spiele.
 *
 * Schreibt fortlaufend in eine Senke (OPFS-Datei), hält nur das Inhaltsverzeichnis im Speicher und
 * kann komprimierte Daten unverändert übernehmen (keine Neukomprimierung). ZIP64 wird automatisch
 * verwendet, wenn Größen, Positionen oder die Anzahl der Einträge die klassischen Grenzen überschreiten.
 */

export interface ZipSink {
  write(chunk: Uint8Array): void | Promise<void>;
}

interface CentralRecord {
  name: Uint8Array;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
}

const LIMIT32 = 0xffffffff;
const LIMIT16 = 0xffff;
const encoder = new TextEncoder();

// Fester Zeitstempel (2026-01-01 00:00) – Ren'Py verwendet ihn nicht.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

export interface RawEntry {
  name: string;
  /** 0 = gespeichert, 8 = deflate */
  method: 0 | 8;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Die (ggf. komprimierten) Daten, genau `compressedSize` Bytes. */
  data: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

export class ZipWriter {
  private offset = 0;
  private readonly records: CentralRecord[] = [];
  private readonly names = new Set<string>();

  constructor(private readonly sink: ZipSink) {}

  get bytesWritten(): number {
    return this.offset;
  }

  get entryCount(): number {
    return this.records.length;
  }

  has(name: string): boolean {
    return this.names.has(name);
  }

  private async emit(chunk: Uint8Array): Promise<void> {
    if (!chunk.byteLength) return;
    await this.sink.write(chunk);
    this.offset += chunk.byteLength;
  }

  /** Eintrag mit bekannten Größen und CRC (z. B. unverändert aus einem anderen ZIP übernommen). */
  async addRaw(entry: RawEntry): Promise<void> {
    if (this.names.has(entry.name)) throw new Error(`doppelter Eintrag: ${entry.name}`);
    const name = encoder.encode(entry.name);
    if (name.byteLength > LIMIT16) throw new Error('Dateiname zu lang');
    const zip64 = entry.compressedSize >= LIMIT32 || entry.uncompressedSize >= LIMIT32;
    const offset = this.offset;

    const extra = zip64 ? 20 : 0;
    const header = new DataView(new ArrayBuffer(30 + name.byteLength + extra));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, zip64 ? 45 : 20, true);
    header.setUint16(6, 0x0800, true); // UTF-8-Dateinamen
    header.setUint16(8, entry.method, true);
    header.setUint16(10, DOS_TIME, true);
    header.setUint16(12, DOS_DATE, true);
    header.setUint32(14, entry.crc >>> 0, true);
    header.setUint32(18, zip64 ? LIMIT32 : entry.compressedSize, true);
    header.setUint32(22, zip64 ? LIMIT32 : entry.uncompressedSize, true);
    header.setUint16(26, name.byteLength, true);
    header.setUint16(28, extra, true);
    new Uint8Array(header.buffer).set(name, 30);
    if (zip64) {
      const at = 30 + name.byteLength;
      header.setUint16(at, 0x0001, true);
      header.setUint16(at + 2, 16, true);
      header.setBigUint64(at + 4, BigInt(entry.uncompressedSize), true);
      header.setBigUint64(at + 12, BigInt(entry.compressedSize), true);
    }
    await this.emit(new Uint8Array(header.buffer));

    let written = 0;
    for await (const chunk of entry.data) {
      written += chunk.byteLength;
      if (written > entry.compressedSize) throw new Error(`mehr Daten als angegeben: ${entry.name}`);
      await this.emit(chunk);
    }
    if (written !== entry.compressedSize) throw new Error(`weniger Daten als angegeben: ${entry.name}`);

    this.names.add(entry.name);
    this.records.push({ name, method: entry.method, crc: entry.crc >>> 0, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize, offset });
  }

  /** Kleiner Eintrag aus dem Speicher (gespeichert, CRC wird berechnet). */
  async addBytes(name: string, data: Uint8Array): Promise<void> {
    await this.addRaw({ name, method: 0, crc: crc32(data), compressedSize: data.byteLength, uncompressedSize: data.byteLength, data: [data] });
  }

  /** Schließt das Archiv mit dem zentralen Verzeichnis ab. */
  async finish(): Promise<void> {
    const cdStart = this.offset;
    for (const r of this.records) {
      const needSizes = r.compressedSize >= LIMIT32 || r.uncompressedSize >= LIMIT32;
      const needOffset = r.offset >= LIMIT32;
      const extraLength = needSizes || needOffset ? 4 + (needSizes ? 16 : 0) + (needOffset ? 8 : 0) : 0;
      const rec = new DataView(new ArrayBuffer(46 + r.name.byteLength + extraLength));
      rec.setUint32(0, 0x02014b50, true);
      rec.setUint16(4, (3 << 8) | 45, true); // Unix, Version 4.5
      rec.setUint16(6, extraLength ? 45 : 20, true);
      rec.setUint16(8, 0x0800, true);
      rec.setUint16(10, r.method, true);
      rec.setUint16(12, DOS_TIME, true);
      rec.setUint16(14, DOS_DATE, true);
      rec.setUint32(16, r.crc, true);
      rec.setUint32(20, needSizes ? LIMIT32 : r.compressedSize, true);
      rec.setUint32(24, needSizes ? LIMIT32 : r.uncompressedSize, true);
      rec.setUint16(28, r.name.byteLength, true);
      rec.setUint16(30, extraLength, true);
      rec.setUint16(32, 0, true);
      rec.setUint16(34, 0, true);
      rec.setUint16(36, 0, true);
      // Ordner (Name endet auf „/“): drwxr-xr-x + MS-DOS-Ordnerbit; sonst reguläre Datei rw-r--r--.
      const isDir = r.name[r.name.byteLength - 1] === 0x2f;
      rec.setUint32(38, isDir ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, true);
      rec.setUint32(42, needOffset ? LIMIT32 : r.offset, true);
      new Uint8Array(rec.buffer).set(r.name, 46);
      if (extraLength) {
        let at = 46 + r.name.byteLength;
        rec.setUint16(at, 0x0001, true);
        rec.setUint16(at + 2, extraLength - 4, true);
        at += 4;
        if (needSizes) {
          rec.setBigUint64(at, BigInt(r.uncompressedSize), true);
          rec.setBigUint64(at + 8, BigInt(r.compressedSize), true);
          at += 16;
        }
        if (needOffset) rec.setBigUint64(at, BigInt(r.offset), true);
      }
      await this.emit(new Uint8Array(rec.buffer));
    }
    const cdSize = this.offset - cdStart;
    const count = this.records.length;
    const zip64 = count >= LIMIT16 || cdStart >= LIMIT32 || cdSize >= LIMIT32;
    if (zip64) {
      const eocd64At = this.offset;
      const z = new DataView(new ArrayBuffer(56 + 20));
      z.setUint32(0, 0x06064b50, true);
      z.setBigUint64(4, 44n, true);
      z.setUint16(12, (3 << 8) | 45, true);
      z.setUint16(14, 45, true);
      z.setUint32(16, 0, true);
      z.setUint32(20, 0, true);
      z.setBigUint64(24, BigInt(count), true);
      z.setBigUint64(32, BigInt(count), true);
      z.setBigUint64(40, BigInt(cdSize), true);
      z.setBigUint64(48, BigInt(cdStart), true);
      z.setUint32(56, 0x07064b50, true);
      z.setUint32(60, 0, true);
      z.setBigUint64(64, BigInt(eocd64At), true);
      z.setUint32(72, 1, true);
      await this.emit(new Uint8Array(z.buffer));
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, zip64 ? LIMIT16 : count, true);
    end.setUint16(10, zip64 ? LIMIT16 : count, true);
    end.setUint32(12, zip64 ? LIMIT32 : cdSize, true);
    end.setUint32(16, zip64 ? LIMIT32 : cdStart, true);
    await this.emit(new Uint8Array(end.buffer));
  }
}
