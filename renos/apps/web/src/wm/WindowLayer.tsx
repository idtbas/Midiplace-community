import { useShallow } from 'zustand/react/shallow';
import { cn } from '@/lib/cn';
import { effectiveRect } from '@/system/geometry';
import { useWindows, zIndexFor } from '@/system/windows';
import { WindowFrame, useSnapPreview } from './WindowFrame';

/** Rendert alle Fenster in fester DOM-Reihenfolge (nach Erstellung), gestapelt per z-index. */
export function WindowLayer() {
  const { windows, order, focusedId, bounds, immersiveId } = useWindows(
    useShallow((s) => ({ windows: s.windows, order: s.order, focusedId: s.focusedId, bounds: s.bounds, immersiveId: s.immersiveId })),
  );
  const snap = useSnapPreview((s) => s.target);
  // Stabile DOM-Reihenfolge verhindert, dass iframes beim Fokuswechsel neu geladen werden.
  const list = Object.values(windows).sort((a, b) => a.createdAt - b.createdAt);
  const preview = snap ? effectiveRect(bounds, snap, bounds) : null;

  return (
    // Bewusst ohne z-index: Fenster teilen sich den Stapelkontext mit Systemleiste und Dock,
    // damit der immersive Spielmodus über beiden liegen kann.
    <div className="pointer-events-none absolute inset-0">
      {preview ? (
        <div
          className={cn('absolute rounded-lg border-2 border-accent/60 bg-accent-softer transition-all duration-[var(--dur)] ease-[var(--ease-out)]')}
          style={{ left: preview.x + 4, top: preview.y + 4, width: preview.w - 8, height: preview.h - 8, zIndex: 999 }}
        />
      ) : null}
      {list.map((win) => (
        <WindowFrame
          key={win.id}
          win={win}
          zIndex={zIndexFor(order, win.id)}
          focused={focusedId === win.id}
          bounds={bounds}
          immersive={immersiveId === win.id}
        />
      ))}
    </div>
  );
}
