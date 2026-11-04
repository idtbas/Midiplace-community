/**
 * Bildgröße aus dem Dateikopf (PNG, JPEG, WebP, AVIF) – ohne das Bild zu dekodieren.
 * Ren'Py braucht sie für nachgeladene Bilder: Bis die Datei da ist, zeigt es einen Platzhalter
 * in genau dieser Größe.
 */

export interface ImageSize {
  width: number;
  height: number;
}

/** So viele Bytes vom Dateianfang reichen für alle unterstützten Formate. */
export const IMAGE_HEADER_BYTES = 256 * 1024;

const valid = (w: number, h: number): ImageSize | null => (w > 0 && h > 0 && w <= 65_535 && h <= 65_535 ? { width: w, height: h } : null);

function png(b: Uint8Array, v: DataView): ImageSize | null {
  if (b.length < 24 || v.getUint32(0) !== 0x89504e47 || v.getUint32(12) !== 0x49484452) return null;
  return valid(v.getUint32(16), v.getUint32(20));
}

function jpeg(b: Uint8Array, v: DataView): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = v.getUint16(i + 2);
    // SOF0–SOF15 außer DHT (C4), JPG (C8) und DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return valid(v.getUint16(i + 7), v.getUint16(i + 5));
    }
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

function webp(b: Uint8Array, v: DataView): ImageSize | null {
  if (b.length < 30 || v.getUint32(0) !== 0x52494646 || v.getUint32(8) !== 0x57454250) return null;
  const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return valid(v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff);
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = v.getUint32(21, true);
    return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X') {
    const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
    const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
    return valid(w, h);
  }
  return null;
}

function avif(b: Uint8Array, v: DataView): ImageSize | null {
  if (b.length < 16 || String.fromCharCode(b[4]!, b[5]!, b[6]!, b[7]!) !== 'ftyp') return null;
  const brand = String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!);
  if (!/^(avif|avis|mif1|heic|heix)$/.test(brand)) return null;
  // Erste „ispe“-Box (Bildgröße der Hauptdarstellung).
  for (let i = 4; i + 16 <= b.length; i += 1) {
    if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) {
      return valid(v.getUint32(i + 8), v.getUint32(i + 12));
    }
  }
  return null;
}

export function imageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    return png(bytes, view) ?? jpeg(bytes, view) ?? webp(bytes, view) ?? avif(bytes, view);
  } catch {
    return null;
  }
}
