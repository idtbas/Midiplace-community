/** CRC32 (IEEE) mit Slicing-by-4-Tabellen – schnell genug, um auch Gigabyte-Archive zu prüfen. */
const TABLES = (() => {
  const t = Array.from({ length: 4 }, () => new Uint32Array(256));
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[0]![i] = c >>> 0;
  }
  for (let i = 0; i < 256; i += 1) {
    t[1]![i] = (t[0]![t[0]![i]! & 0xff]! ^ (t[0]![i]! >>> 8)) >>> 0;
    t[2]![i] = (t[0]![t[1]![i]! & 0xff]! ^ (t[1]![i]! >>> 8)) >>> 0;
    t[3]![i] = (t[0]![t[2]![i]! & 0xff]! ^ (t[2]![i]! >>> 8)) >>> 0;
  }
  return t as [Uint32Array, Uint32Array, Uint32Array, Uint32Array];
})();

export function crc32(data: Uint8Array, previous = 0): number {
  const [t0, t1, t2, t3] = TABLES;
  let crc = ~previous >>> 0;
  let i = 0;
  const n = data.length;
  for (; i + 4 <= n; i += 4) {
    crc ^= data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24);
    crc = (t3[crc & 0xff]! ^ t2[(crc >>> 8) & 0xff]! ^ t1[(crc >>> 16) & 0xff]! ^ t0[crc >>> 24]!) >>> 0;
  }
  for (; i < n; i += 1) crc = (t0[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return ~crc >>> 0;
}
