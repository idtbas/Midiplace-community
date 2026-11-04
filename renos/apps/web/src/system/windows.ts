import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { APP_META } from './appMeta';
import { isAppId, type AppId } from './appIds';
import { clampRect, effectiveRect, initialRect, type Bounds, type Rect, type WindowMode } from './geometry';

/**
 * Zentraler Window Manager. Alle Fensterzustände liegen ausschließlich hier –
 * Anwendungen besitzen keine eigene Fensterlogik.
 *
 * Stapelreihenfolge: `order` (unten → oben). Der z-index wird daraus abgeleitet und
 * ist dadurch immer lückenlos und begrenzt (keine wachsenden z-index-Ketten).
 */

export type WindowPayload = Record<string, string | number | boolean | null>;

export interface WindowState {
  id: string;
  appId: AppId;
  title: string;
  /** Normale (wiederhergestellte) Fläche. */
  rect: Rect;
  mode: WindowMode;
  minimized: boolean;
  payload: WindowPayload | null;
  createdAt: number;
}

interface WindowStore {
  windows: Record<string, WindowState>;
  order: string[];
  focusedId: string | null;
  bounds: Bounds;
  lastRects: Partial<Record<AppId, Rect>>;
  /** Fenster, das gerade im immersiven Spielmodus läuft. */
  immersiveId: string | null;

  open: (appId: AppId, payload?: WindowPayload | null, options?: { newInstance?: boolean }) => string;
  close: (id: string) => void;
  closeAll: () => void;
  focus: (id: string) => void;
  blur: () => void;
  minimize: (id: string) => void;
  minimizeAll: () => void;
  restore: (id: string) => void;
  toggleMaximize: (id: string) => void;
  setMode: (id: string, mode: WindowMode) => void;
  setRect: (id: string, rect: Rect) => void;
  setTitle: (id: string, title: string) => void;
  setPayload: (id: string, payload: WindowPayload | null) => void;
  setBounds: (bounds: Bounds) => void;
  setImmersive: (id: string | null) => void;
  cycle: (direction: 1 | -1) => void;
  arrange: () => void;
  resetGeometry: () => void;
}

let counter = 0;
function nextId(appId: AppId): string {
  counter += 1;
  return `${appId}-${Date.now().toString(36)}-${counter}`;
}

const DEFAULT_BOUNDS: Bounds = { x: 0, y: 32, w: 1180, h: 700 };

function topVisible(order: string[], windows: Record<string, WindowState>, except?: string): string | null {
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const id = order[i]!;
    if (id !== except && windows[id] && !windows[id].minimized) return id;
  }
  return null;
}

export const useWindows = create<WindowStore>()(
  persist(
    (set, get) => ({
      windows: {},
      order: [],
      focusedId: null,
      bounds: DEFAULT_BOUNDS,
      lastRects: {},
      immersiveId: null,

      open: (appId, payload = null, options = {}) => {
        const state = get();
        const meta = APP_META[appId];
        if (meta.singleInstance && !options.newInstance) {
          const existing = Object.values(state.windows).find((w) => w.appId === appId);
          if (existing) {
            set((s) => ({
              windows: { ...s.windows, [existing.id]: { ...existing, minimized: false, payload: payload ?? existing.payload } },
              order: [...s.order.filter((id) => id !== existing.id), existing.id],
              focusedId: existing.id,
            }));
            return existing.id;
          }
        }
        const id = nextId(appId);
        const occupied = Object.values(state.windows).map((w) => w.rect);
        const rect = initialRect(meta.defaultSize, meta.minSize, state.bounds, occupied, state.lastRects[appId]);
        const win: WindowState = { id, appId, title: meta.name, rect, mode: 'normal', minimized: false, payload, createdAt: Date.now() };
        set((s) => ({ windows: { ...s.windows, [id]: win }, order: [...s.order, id], focusedId: id }));
        return id;
      },

      close: (id) => {
        const { windows, order, lastRects, immersiveId } = get();
        const win = windows[id];
        if (!win) return;
        const rest = { ...windows };
        delete rest[id];
        const newOrder = order.filter((o) => o !== id);
        set({
          windows: rest,
          order: newOrder,
          focusedId: topVisible(newOrder, rest),
          lastRects: { ...lastRects, [win.appId]: win.rect },
          immersiveId: immersiveId === id ? null : immersiveId,
        });
      },

      closeAll: () => {
        const { windows, lastRects } = get();
        const remembered = { ...lastRects };
        for (const w of Object.values(windows)) remembered[w.appId] = w.rect;
        set({ windows: {}, order: [], focusedId: null, lastRects: remembered, immersiveId: null });
      },

      focus: (id) => {
        const { windows, order, focusedId } = get();
        const win = windows[id];
        if (!win) return;
        if (focusedId === id && order[order.length - 1] === id && !win.minimized) return;
        set({
          windows: win.minimized ? { ...windows, [id]: { ...win, minimized: false } } : windows,
          order: [...order.filter((o) => o !== id), id],
          focusedId: id,
        });
      },

      blur: () => set({ focusedId: null }),

      minimize: (id) => {
        const { windows, order, immersiveId } = get();
        const win = windows[id];
        if (!win) return;
        const updated = { ...windows, [id]: { ...win, minimized: true } };
        set({ windows: updated, focusedId: topVisible(order, updated, id), immersiveId: immersiveId === id ? null : immersiveId });
      },

      minimizeAll: () => {
        const { windows } = get();
        const updated: Record<string, WindowState> = {};
        for (const [id, w] of Object.entries(windows)) updated[id] = { ...w, minimized: true };
        set({ windows: updated, focusedId: null, immersiveId: null });
      },

      restore: (id) => {
        const { windows, order } = get();
        const win = windows[id];
        if (!win) return;
        set({
          windows: { ...windows, [id]: { ...win, minimized: false, mode: win.minimized ? win.mode : 'normal' } },
          order: [...order.filter((o) => o !== id), id],
          focusedId: id,
        });
      },

      toggleMaximize: (id) => {
        const win = get().windows[id];
        if (!win) return;
        get().setMode(id, win.mode === 'normal' ? 'maximized' : 'normal');
      },

      setMode: (id, mode) => {
        const { windows, order } = get();
        const win = windows[id];
        if (!win) return;
        set({
          windows: { ...windows, [id]: { ...win, mode, minimized: false } },
          order: [...order.filter((o) => o !== id), id],
          focusedId: id,
        });
      },

      setRect: (id, rect) => {
        const { windows, bounds } = get();
        const win = windows[id];
        if (!win) return;
        const clamped = clampRect(rect, bounds, APP_META[win.appId].minSize);
        set({ windows: { ...windows, [id]: { ...win, rect: clamped, mode: 'normal' } } });
      },

      setTitle: (id, title) => {
        const win = get().windows[id];
        if (!win || win.title === title) return;
        set((s) => ({ windows: { ...s.windows, [id]: { ...win, title } } }));
      },

      setPayload: (id, payload) => {
        const win = get().windows[id];
        if (!win) return;
        set((s) => ({ windows: { ...s.windows, [id]: { ...win, payload } } }));
      },

      setBounds: (bounds) => {
        const { windows, bounds: previous } = get();
        if (previous.x === bounds.x && previous.y === bounds.y && previous.w === bounds.w && previous.h === bounds.h) return;
        // Bei geänderter Fenstergröße (Drehung, Split View, Stage Manager) alle Fenster sichtbar halten.
        const updated: Record<string, WindowState> = {};
        for (const [id, w] of Object.entries(windows)) {
          updated[id] = { ...w, rect: clampRect(w.rect, bounds, APP_META[w.appId].minSize) };
        }
        set({ bounds, windows: updated });
      },

      setImmersive: (id) => set({ immersiveId: id }),

      cycle: (direction) => {
        const { order, windows } = get();
        const ids = order.filter((id) => windows[id]);
        if (ids.length === 0) return;
        if (ids.length === 1) {
          get().focus(ids[0]!);
          return;
        }
        if (direction === 1) {
          // Oberstes Fenster nach unten legen, das nächste kommt nach vorn (Rotation).
          const top = ids[ids.length - 1]!;
          const newOrder = [top, ...ids.slice(0, -1)];
          const target = newOrder[newOrder.length - 1]!;
          set({ order: newOrder, windows: { ...windows, [target]: { ...windows[target]!, minimized: false } }, focusedId: target });
        } else {
          get().focus(ids[0]!);
        }
      },

      arrange: () => {
        const { windows, order, bounds } = get();
        const visible = order.filter((id) => windows[id] && !windows[id].minimized);
        if (visible.length === 0) return;
        const cols = Math.ceil(Math.sqrt(visible.length));
        const rows = Math.ceil(visible.length / cols);
        const gap = 8;
        const cellW = (bounds.w - gap * (cols + 1)) / cols;
        const cellH = (bounds.h - gap * (rows + 1)) / rows;
        const updated = { ...windows };
        visible.forEach((id, index) => {
          const win = windows[id]!;
          const col = index % cols;
          const row = Math.floor(index / cols);
          const rect = { x: bounds.x + gap + col * (cellW + gap), y: bounds.y + gap + row * (cellH + gap), w: cellW, h: cellH };
          updated[id] = { ...win, mode: 'normal', rect: clampRect(rect, bounds, APP_META[win.appId].minSize) };
        });
        set({ windows: updated });
      },

      resetGeometry: () => {
        const { windows, bounds } = get();
        const updated: Record<string, WindowState> = {};
        const occupied: Rect[] = [];
        for (const [id, w] of Object.entries(windows)) {
          const meta = APP_META[w.appId];
          const rect = initialRect(meta.defaultSize, meta.minSize, bounds, occupied);
          occupied.push(rect);
          updated[id] = { ...w, rect, mode: 'normal' };
        }
        set({ windows: updated, lastRects: {} });
      },
    }),
    {
      name: 'renos.windows',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        // Spiele werden nie automatisch gestartet: Player-Fenster werden nicht gesichert.
        windows: Object.fromEntries(Object.entries(state.windows).filter(([, w]) => w.appId !== 'player')),
        order: state.order.filter((id) => state.windows[id]?.appId !== 'player'),
        lastRects: state.lastRects,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Pick<WindowStore, 'windows' | 'order' | 'lastRects'>>;
        const windows: Record<string, WindowState> = {};
        for (const [id, w] of Object.entries(p.windows ?? {})) {
          if (!w || !isAppId(w.appId) || w.appId === 'player' || typeof w.rect?.x !== 'number') continue;
          windows[id] = { ...w, minimized: Boolean(w.minimized), mode: w.mode ?? 'normal' };
        }
        const order = (p.order ?? []).filter((id) => windows[id]);
        for (const id of Object.keys(windows)) if (!order.includes(id)) order.push(id);
        return { ...current, windows, order, focusedId: topVisible(order, windows), lastRects: p.lastRects ?? {} };
      },
    },
  ),
);

/** z-index eines Fensters (aus der Stapelreihenfolge abgeleitet). */
export function zIndexFor(order: string[], id: string): number {
  const index = order.indexOf(id);
  return index < 0 ? 10 : 10 + index;
}

export function windowRect(win: WindowState, bounds: Bounds): Rect {
  return effectiveRect(win.rect, win.mode, bounds);
}

/** Verwirft die gespeicherte Sitzung (z. B. wenn „Sitzung wiederherstellen“ aus ist). */
export function clearSessionWindows(): void {
  useWindows.setState({ windows: {}, order: [], focusedId: null });
}
