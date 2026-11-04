import { describe, expect, it } from 'vitest';
import { clampRect, effectiveRect, initialRect, resizeRect, snapTargetFor, VISIBLE_MARGIN } from './geometry';

const bounds = { x: 0, y: 32, w: 1180, h: 700 };
const min = { w: 400, h: 300 };

describe('window geometry', () => {
  it('keeps windows reachable inside the work area', () => {
    const r = clampRect({ x: -5000, y: -100, w: 600, h: 400 }, bounds, min);
    expect(r.y).toBe(32);
    expect(r.x + r.w).toBe(VISIBLE_MARGIN);
    const off = clampRect({ x: 9000, y: 9000, w: 600, h: 400 }, bounds, min);
    expect(off.x).toBe(bounds.w - VISIBLE_MARGIN);
    expect(off.y).toBeLessThan(bounds.y + bounds.h);
  });

  it('enforces minimum and maximum sizes', () => {
    expect(clampRect({ x: 0, y: 32, w: 100, h: 50 }, bounds, min)).toMatchObject({ w: 400, h: 300 });
    expect(clampRect({ x: 0, y: 32, w: 5000, h: 5000 }, bounds, min)).toMatchObject({ w: 1180, h: 700 });
  });

  it('cascades new windows instead of stacking them exactly', () => {
    const a = initialRect({ w: 800, h: 500 }, min, bounds, []);
    const b = initialRect({ w: 800, h: 500 }, min, bounds, [a]);
    expect(b.x).not.toBe(a.x);
    expect(b.y).not.toBe(a.y);
  });

  it('computes maximized and snapped areas', () => {
    expect(effectiveRect({ x: 1, y: 2, w: 3, h: 4 }, 'maximized', bounds)).toEqual(bounds);
    const left = effectiveRect({ x: 1, y: 2, w: 3, h: 4 }, 'snap-left', bounds);
    const right = effectiveRect({ x: 1, y: 2, w: 3, h: 4 }, 'snap-right', bounds);
    expect(left.x).toBe(0);
    expect(right.x + right.w).toBe(1180);
    expect(left.w).toBe(right.w);
  });

  it('resizes from edges without going below the minimum size', () => {
    const start = { x: 100, y: 100, w: 600, h: 400 };
    expect(resizeRect(start, 'se', 50, 30, min, bounds)).toEqual({ x: 100, y: 100, w: 650, h: 430 });
    const shrunk = resizeRect(start, 'nw', 500, 500, min, bounds);
    expect(shrunk.w).toBe(400);
    expect(shrunk.h).toBe(300);
    expect(shrunk.x + shrunk.w).toBe(700);
    expect(resizeRect(start, 'n', 0, -500, min, bounds).y).toBe(32);
  });

  it('detects snap targets at the screen edges', () => {
    expect(snapTargetFor(2, 300, bounds)).toBe('snap-left');
    expect(snapTargetFor(1178, 300, bounds)).toBe('snap-right');
    expect(snapTargetFor(600, 33, bounds)).toBe('maximized');
    expect(snapTargetFor(600, 300, bounds)).toBeNull();
  });
});
