import { Suspense, memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Copy, Maximize2, Minus, Square, X } from 'lucide-react';
import { create } from 'zustand';
import { t } from '@/i18n';
import { cn } from '@/lib/cn';
import { APP_META } from '@/system/appMeta';
import { APP_COMPONENTS } from '@/system/apps';
import { showContextMenu } from '@/system/contextMenu';
import { resizeRect, snapTargetFor, type Bounds, type Rect, type ResizeEdge, type SnapTarget } from '@/system/geometry';
import { useSettings } from '@/system/settings';
import { useWindows, windowRect, type WindowState } from '@/system/windows';
import { ErrorBoundary } from '@/shell/ErrorBoundary';
import { AppIcon } from '@/ui/AppIcon';
import { Button } from '@/ui/Button';
import { Spinner } from '@/ui/Feedback';
import { WindowContext } from './WindowContext';

/** Vorschau beim Einrasten an Bildschirmrändern (geteilt zwischen allen Fenstern). */
export const useSnapPreview = create<{ target: SnapTarget }>(() => ({ target: null }));

const EDGES: Array<{ edge: ResizeEdge; className: string; cursor: string }> = [
  { edge: 'n', className: 'top-[-4px] left-3 right-3 h-2', cursor: 'ns-resize' },
  { edge: 's', className: 'bottom-[-4px] left-3 right-3 h-2', cursor: 'ns-resize' },
  { edge: 'e', className: 'right-[-4px] top-3 bottom-3 w-2', cursor: 'ew-resize' },
  { edge: 'w', className: 'left-[-4px] top-3 bottom-3 w-2', cursor: 'ew-resize' },
  { edge: 'ne', className: 'right-[-5px] top-[-5px] h-4 w-4', cursor: 'nesw-resize' },
  { edge: 'nw', className: 'left-[-5px] top-[-5px] h-4 w-4', cursor: 'nwse-resize' },
  { edge: 'se', className: 'right-[-5px] bottom-[-5px] h-4 w-4', cursor: 'nwse-resize' },
  { edge: 'sw', className: 'left-[-5px] bottom-[-5px] h-4 w-4', cursor: 'nesw-resize' },
];

interface Props {
  win: WindowState;
  zIndex: number;
  focused: boolean;
  bounds: Bounds;
  immersive: boolean;
}

function applyRect(el: HTMLElement, rect: Rect) {
  el.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`;
  el.style.width = `${rect.w}px`;
  el.style.height = `${rect.h}px`;
}

export const WindowFrame = memo(function WindowFrame({ win, zIndex, focused, bounds, immersive }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  const [interacting, setInteracting] = useState(false);
  const snapping = useSettings((s) => s.windowSnapping);
  const doubleClick = useSettings((s) => s.titlebarDoubleClick);
  const meta = APP_META[win.appId];
  const AppComponent = APP_COMPONENTS[win.appId];
  const rect = windowRect(win, bounds);
  const { focus, minimize, close, toggleMaximize, setRect, setMode } = useWindows.getState();

  // Position immer aus dem Store übernehmen, wenn nicht gerade gezogen wird.
  useEffect(() => {
    if (!ref.current || interacting || immersive) return;
    applyRect(ref.current, rect);
  }, [rect.x, rect.y, rect.w, rect.h, interacting, immersive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tastaturfokus folgt dem Fensterfokus (z. B. nach ⌥⇥), ohne Eingabefelder zu stören.
  useEffect(() => {
    if (!focused || win.minimized) return;
    const content = contentRef.current;
    if (content && !content.contains(document.activeElement)) content.focus({ preventScroll: true });
  }, [focused, win.minimized]);

  const onFrameDown = useCallback(() => {
    if (!focused) focus(win.id);
  }, [focused, focus, win.id]);

  // ----- Verschieben -------------------------------------------------------
  const onTitlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || immersive) return;
    if ((event.target as HTMLElement).closest('button, input, [data-no-drag]')) return;
    const el = ref.current;
    if (!el) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const start = windowRect(win, bounds);
    let current: Rect = { ...start };
    let moved = false;
    let snap: SnapTarget = null;
    const pointerId = event.pointerId;
    (event.currentTarget as HTMLElement).setPointerCapture(pointerId);

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved) {
        moved = true;
        setInteracting(true);
        document.documentElement.dataset.dragging = 'window';
        // Aus maximiertem/eingerastetem Zustand lösen: Fenster behält relative Zeigerposition.
        if (win.mode !== 'normal') {
          const ratio = (startX - start.x) / start.w;
          const restored = win.rect;
          current = { ...restored, x: startX - restored.w * ratio, y: start.y };
          start.x = current.x;
          start.y = current.y;
          start.w = restored.w;
          start.h = restored.h;
        }
      }
      const minY = bounds.y;
      current = { ...current, x: start.x + dx, y: Math.max(minY, start.y + dy), w: start.w, h: start.h };
      applyRect(el, current);
      if (snapping) {
        const next = snapTargetFor(e.clientX, e.clientY, bounds);
        if (next !== snap) {
          snap = next;
          useSnapPreview.setState({ target: next });
        }
      }
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      delete document.documentElement.dataset.dragging;
      useSnapPreview.setState({ target: null });
      if (!moved) return;
      if (snap) {
        // Normale Fläche merken, damit „Wiederherstellen“ zur letzten Position zurückkehrt.
        setRect(win.id, { ...current, y: Math.max(current.y, bounds.y) });
        setMode(win.id, snap);
      } else {
        setRect(win.id, current);
      }
      setInteracting(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const onTitleDoubleClick = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('button, input, [data-no-drag]')) return;
    if (doubleClick === 'maximize') toggleMaximize(win.id);
    else if (doubleClick === 'minimize') minimize(win.id);
  };

  // ----- Größe ändern ------------------------------------------------------
  const onResizeDown = (edge: ResizeEdge) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const el = ref.current;
    if (!el) return;
    focus(win.id);
    const start = windowRect(win, bounds);
    const startX = event.clientX;
    const startY = event.clientY;
    let current = start;
    const pointerId = event.pointerId;
    (event.currentTarget as HTMLElement).setPointerCapture(pointerId);
    setInteracting(true);
    document.documentElement.dataset.dragging = 'resize';
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      current = resizeRect(start, edge, e.clientX - startX, e.clientY - startY, meta.minSize, bounds);
      applyRect(el, current);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      delete document.documentElement.dataset.dragging;
      setRect(win.id, current);
      setInteracting(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const onTitleContextMenu = (event: React.MouseEvent) => {
    showContextMenu(event, [
      { id: 'min', label: t.window.minimize, icon: Minus, run: () => minimize(win.id) },
      {
        id: 'max',
        label: win.mode === 'normal' ? t.window.maximize : t.window.restore,
        icon: win.mode === 'normal' ? Square : Copy,
        run: () => toggleMaximize(win.id),
      },
      { id: 'left', label: t.window.snapLeft, run: () => setMode(win.id, 'snap-left') },
      { id: 'right', label: t.window.snapRight, run: () => setMode(win.id, 'snap-right') },
      'separator',
      { id: 'close', label: t.window.close, icon: X, shortcut: '⌥ W', run: () => close(win.id) },
    ]);
  };

  const isNormal = win.mode === 'normal';

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={win.title}
      aria-hidden={win.minimized}
      data-window-id={win.id}
      data-app-id={win.appId}
      data-focused={focused || undefined}
      data-minimized={win.minimized || undefined}
      onPointerDownCapture={onFrameDown}
      className={cn(
        'renos-window pointer-events-auto flex flex-col will-change-transform',
        immersive ? 'fixed inset-0 bg-black' : 'absolute left-0 top-0 overflow-visible',
        win.minimized && 'pointer-events-none',
      )}
      style={
        immersive
          ? { zIndex: 9000, transform: 'none', width: '100%', height: '100%' }
          : {
              zIndex,
              transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
              width: rect.w,
              height: rect.h,
              visibility: win.minimized ? 'hidden' : 'visible',
              // Sichtbarkeit erst nach der Minimier-Animation umschalten.
              transition: win.minimized ? 'visibility 0s linear var(--dur)' : 'none',
            }
      }
    >
      <div
        className={cn(
          'relative flex h-full w-full flex-col overflow-hidden',
          !immersive && 'rounded-lg border bg-surface-1 transition-[opacity,transform,box-shadow] duration-[var(--dur)] ease-[var(--ease-out)]',
          !immersive && (focused ? 'border-line-soft shadow-[var(--shadow-window)]' : 'border-line-faint shadow-[var(--shadow-window-inactive)]'),
          !immersive && win.mode !== 'normal' && 'rounded-md',
          win.minimized ? 'translate-y-6 scale-[0.96] opacity-0' : 'opacity-100',
        )}
      >
        {immersive ? null : (
          <div
            className={cn(
              'os-chrome relative flex h-[38px] shrink-0 items-center gap-2 border-b pl-3 pr-1.5 touch-none',
              focused ? 'border-line-soft bg-surface-2' : 'border-line-faint bg-surface-1',
            )}
            onPointerDown={onTitlePointerDown}
            onDoubleClick={onTitleDoubleClick}
            onContextMenu={onTitleContextMenu}
          >
            <AppIcon appId={win.appId} size={18} className={cn(!focused && 'opacity-60')} />
            <div className={cn('min-w-0 shrink truncate text-base font-semibold', focused ? 'text-fg' : 'text-fg-subtle')}>{win.title}</div>
            {/* Freie Fläche bleibt ziehbar und doppelklickbar; App-Bedienelemente nehmen nur ihren eigenen Platz ein. */}
            <div className="min-w-0 flex-1 self-stretch" />
            <div ref={setHeaderSlot} className="flex shrink-0 items-center gap-1" data-no-drag />
            <div className="ml-1 flex items-center gap-1">
              <WindowButton label={t.window.minimize} onClick={() => minimize(win.id)} icon={<Minus size={13} strokeWidth={2.2} />} />
              <WindowButton
                label={isNormal ? t.window.maximize : t.window.restore}
                onClick={() => toggleMaximize(win.id)}
                icon={isNormal ? <Maximize2 size={11} strokeWidth={2.4} /> : <Copy size={11} strokeWidth={2.2} />}
              />
              <WindowButton label={t.window.close} onClick={() => close(win.id)} icon={<X size={13} strokeWidth={2.2} />} close />
            </div>
          </div>
        )}
        <div ref={contentRef} tabIndex={-1} className="relative min-h-0 flex-1 outline-none">
          <WindowContext.Provider value={{ windowId: win.id, appId: win.appId, focused, headerSlot }}>
            <ErrorBoundary
              fallback={(_error, reset) => (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                  <p className="text-base text-fg-muted">{t.window.loadError}</p>
                  <div className="flex gap-2">
                    <Button onClick={reset}>{t.system.retry}</Button>
                    <Button variant="ghost" onClick={() => close(win.id)}>
                      {t.system.close}
                    </Button>
                  </div>
                </div>
              )}
            >
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <Spinner size={20} />
                  </div>
                }
              >
                <AppComponent windowId={win.id} payload={win.payload} />
              </Suspense>
            </ErrorBoundary>
          </WindowContext.Provider>
          {/* Während des Ziehens fängt diese Fläche Zeigerereignisse ab (wichtig über iframes). */}
          {interacting ? <div className="absolute inset-0 z-50" /> : null}
        </div>
      </div>
      {!immersive && isNormal && !win.minimized
        ? EDGES.map(({ edge, className, cursor }) => (
            <div key={edge} className={cn('absolute z-10 touch-none', className)} style={{ cursor }} onPointerDown={onResizeDown(edge)} />
          ))
        : null}
    </div>
  );
});

function WindowButton({ label, onClick, icon, close }: { label: string; onClick: () => void; icon: React.ReactNode; close?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        'group relative flex h-7 w-7 items-center justify-center rounded-full',
        'before:absolute before:inset-[3px] before:rounded-full before:bg-surface-3/80 before:transition-colors before:duration-[var(--dur-fast)]',
        close ? 'hover:before:bg-danger/80' : 'hover:before:bg-surface-4',
      )}
    >
      <span className={cn('relative text-fg-muted', close ? 'group-hover:text-[#1b2029]' : 'group-hover:text-fg')}>{icon}</span>
    </button>
  );
}
