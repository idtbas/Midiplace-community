/** Reine Geometriefunktionen des Window Managers (ohne React, vollständig testbar). */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/** Nutzbare Desktop-Fläche (unterhalb der Systemleiste, oberhalb des Docks). */
export type Bounds = Rect;

export type WindowMode = 'normal' | 'maximized' | 'snap-left' | 'snap-right';

/** Mindestanteil der Titelleiste, der immer sichtbar bleiben muss. */
export const VISIBLE_MARGIN = 96;
export const TITLEBAR_H = 38;
export const SNAP_GAP = 6;

/** Begrenzt Größe und Position eines Fensters so, dass es bedienbar bleibt. */
export function clampRect(rect: Rect, bounds: Bounds, min: Size): Rect {
  const minW = Math.min(min.w, bounds.w);
  const minH = Math.min(min.h, bounds.h);
  const w = Math.round(Math.min(Math.max(rect.w, minW), bounds.w));
  const h = Math.round(Math.min(Math.max(rect.h, minH), bounds.h));
  const minX = bounds.x - w + VISIBLE_MARGIN;
  const maxX = bounds.x + bounds.w - VISIBLE_MARGIN;
  const minY = bounds.y;
  const maxY = bounds.y + bounds.h - TITLEBAR_H;
  const x = Math.round(Math.min(Math.max(rect.x, minX), maxX));
  const y = Math.round(Math.min(Math.max(rect.y, minY), maxY));
  return { x, y, w, h };
}

/** Erste Position eines neuen Fensters: zentriert, leicht versetzt zu bereits offenen Fenstern. */
export function initialRect(size: Size, min: Size, bounds: Bounds, occupied: Rect[], remembered?: Rect): Rect {
  if (remembered) {
    const clamped = clampRect(remembered, bounds, min);
    const collides = occupied.some((r) => Math.abs(r.x - clamped.x) < 8 && Math.abs(r.y - clamped.y) < 8);
    if (!collides) return clamped;
  }
  const w = Math.min(Math.max(size.w, min.w), Math.round(bounds.w * 0.94));
  const h = Math.min(Math.max(size.h, min.h), Math.round(bounds.h * 0.94));
  let x = bounds.x + Math.round((bounds.w - w) / 2);
  let y = bounds.y + Math.round((bounds.h - h) / 2.6);
  for (let i = 0; i < 12; i += 1) {
    const collides = occupied.some((r) => Math.abs(r.x - x) < 12 && Math.abs(r.y - y) < 12);
    if (!collides) break;
    x += 28;
    y += 24;
    if (x + w > bounds.x + bounds.w || y + h > bounds.y + bounds.h) {
      x = bounds.x + 24 + i * 8;
      y = bounds.y + 16 + i * 8;
    }
  }
  return clampRect({ x, y, w, h }, bounds, min);
}

/** Tatsächlich dargestellte Fläche abhängig vom Modus. */
export function effectiveRect(rect: Rect, mode: WindowMode, bounds: Bounds): Rect {
  switch (mode) {
    case 'maximized':
      return { ...bounds };
    case 'snap-left':
      return { x: bounds.x, y: bounds.y, w: Math.floor(bounds.w / 2) - SNAP_GAP / 2, h: bounds.h };
    case 'snap-right': {
      const w = Math.floor(bounds.w / 2) - SNAP_GAP / 2;
      return { x: bounds.x + bounds.w - w, y: bounds.y, w, h: bounds.h };
    }
    default:
      return rect;
  }
}

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Neue Fläche beim Ziehen an einer Kante/Ecke. */
export function resizeRect(start: Rect, edge: ResizeEdge, dx: number, dy: number, min: Size, bounds: Bounds): Rect {
  let { x, y, w, h } = start;
  if (edge.includes('e')) w = start.w + dx;
  if (edge.includes('s')) h = start.h + dy;
  if (edge.includes('w')) {
    w = start.w - dx;
    x = start.x + dx;
  }
  if (edge.includes('n')) {
    h = start.h - dy;
    y = start.y + dy;
  }
  if (w < min.w) {
    if (edge.includes('w')) x -= min.w - w;
    w = min.w;
  }
  if (h < min.h) {
    if (edge.includes('n')) y -= min.h - h;
    h = min.h;
  }
  // Oberkante nie über die Systemleiste ziehen.
  if (y < bounds.y) {
    h -= bounds.y - y;
    y = bounds.y;
  }
  if (x < bounds.x && edge.includes('w')) {
    w -= bounds.x - x;
    x = bounds.x;
  }
  if (edge.includes('e')) w = Math.min(w, bounds.x + bounds.w - x);
  if (edge.includes('s')) h = Math.min(h, bounds.y + bounds.h - y);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(Math.max(w, Math.min(min.w, bounds.w))), h: Math.round(Math.max(h, Math.min(min.h, bounds.h))) };
}

export type SnapTarget = 'maximized' | 'snap-left' | 'snap-right' | null;

/** Erkennt, ob der Zeiger beim Ziehen an einem Bildschirmrand liegt. */
export function snapTargetFor(pointerX: number, pointerY: number, bounds: Bounds, threshold = 14): SnapTarget {
  if (pointerY <= bounds.y + 4) return 'maximized';
  if (pointerX <= bounds.x + threshold) return 'snap-left';
  if (pointerX >= bounds.x + bounds.w - threshold) return 'snap-right';
  return null;
}
