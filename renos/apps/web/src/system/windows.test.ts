import { beforeEach, describe, expect, it } from 'vitest';
import { useWindows, zIndexFor } from './windows';

const ws = () => useWindows.getState();

beforeEach(() => {
  useWindows.setState({ windows: {}, order: [], focusedId: null, lastRects: {}, immersiveId: null, bounds: { x: 0, y: 32, w: 1180, h: 700 } });
});

describe('window manager store', () => {
  it('opens, focuses and stacks windows', () => {
    const a = ws().open('files');
    const b = ws().open('terminal');
    expect(ws().focusedId).toBe(b);
    expect(ws().order).toEqual([a, b]);
    ws().focus(a);
    expect(ws().order).toEqual([b, a]);
    expect(zIndexFor(ws().order, a)).toBeGreaterThan(zIndexFor(ws().order, b));
  });

  it('reuses single-instance apps and opens new instances for multi-instance apps', () => {
    const s1 = ws().open('settings');
    const s2 = ws().open('settings', { section: 'dock' });
    expect(s2).toBe(s1);
    expect(ws().windows[s1]!.payload).toEqual({ section: 'dock' });
    const t1 = ws().open('terminal');
    const t2 = ws().open('terminal', null, { newInstance: true });
    expect(t2).not.toBe(t1);
  });

  it('minimizes, restores and moves focus to the next window', () => {
    const a = ws().open('files');
    const b = ws().open('notes');
    ws().minimize(b);
    expect(ws().windows[b]!.minimized).toBe(true);
    expect(ws().focusedId).toBe(a);
    ws().focus(b);
    expect(ws().windows[b]!.minimized).toBe(false);
    expect(ws().focusedId).toBe(b);
  });

  it('closes windows and remembers their geometry per app', () => {
    const a = ws().open('notes');
    ws().setRect(a, { x: 200, y: 120, w: 700, h: 500 });
    ws().close(a);
    expect(ws().windows[a]).toBeUndefined();
    expect(ws().focusedId).toBeNull();
    const again = ws().open('notes');
    expect(ws().windows[again]!.rect).toEqual({ x: 200, y: 120, w: 700, h: 500 });
  });

  it('toggles maximize and snapping', () => {
    const a = ws().open('files');
    ws().toggleMaximize(a);
    expect(ws().windows[a]!.mode).toBe('maximized');
    ws().toggleMaximize(a);
    expect(ws().windows[a]!.mode).toBe('normal');
    ws().setMode(a, 'snap-left');
    expect(ws().windows[a]!.mode).toBe('snap-left');
  });

  it('keeps windows visible when the screen shrinks', () => {
    const a = ws().open('files');
    ws().setRect(a, { x: 1000, y: 500, w: 800, h: 500 });
    ws().setBounds({ x: 0, y: 32, w: 700, h: 400 });
    const r = ws().windows[a]!.rect;
    expect(r.w).toBeLessThanOrEqual(700);
    expect(r.h).toBeLessThanOrEqual(400);
    expect(r.x).toBeLessThan(700);
    expect(r.y).toBeLessThan(32 + 400);
  });

  it('cycles through windows', () => {
    const a = ws().open('files');
    const b = ws().open('notes');
    const c = ws().open('terminal');
    ws().cycle(1);
    expect(ws().focusedId).toBe(b);
    ws().cycle(1);
    expect(ws().focusedId).toBe(a);
    ws().cycle(-1);
    expect([a, b, c]).toContain(ws().focusedId);
  });

  it('clears immersive mode when the player closes', () => {
    const p = ws().open('player', { gameId: 'x' });
    ws().setImmersive(p);
    expect(ws().immersiveId).toBe(p);
    ws().close(p);
    expect(ws().immersiveId).toBeNull();
  });
});
