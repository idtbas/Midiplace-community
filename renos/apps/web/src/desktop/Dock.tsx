import { useEffect, useRef, useState } from 'react';
import { Pin, PinOff, Plus, SquareStack, Trash2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { t } from '@/i18n';
import { cn } from '@/lib/cn';
import { useServer } from '@/api/server';
import { activateApp, closeApp, openApp, openFilesAt } from '@/system/actions';
import { APP_META } from '@/system/appMeta';
import type { AppId } from '@/system/appIds';
import { showContextMenu, type MenuEntry } from '@/system/contextMenu';
import { DOCK_SIZES, useSettings } from '@/system/settings';
import { useShell } from '@/system/shell';
import { useWindows } from '@/system/windows';

export function dockReserve(size: keyof typeof DOCK_SIZES, autohide: boolean): number {
  return autohide ? 0 : DOCK_SIZES[size] + 26;
}

function Tooltip({ label, visible }: { label: string; visible: boolean }) {
  return (
    <span
      role="tooltip"
      className={cn(
        'pointer-events-none absolute bottom-full left-1/2 mb-3 -translate-x-1/2 whitespace-nowrap rounded-sm border border-line-soft bg-surface-1 px-2 py-1 text-sm text-fg shadow-md transition-opacity duration-[var(--dur-fast)]',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      {label}
    </span>
  );
}

interface DockItemProps {
  id: string;
  label: string;
  icon: string;
  size: number;
  running: boolean;
  active: boolean;
  onActivate: () => void;
  onMenu: (e: React.MouseEvent | { clientX: number; clientY: number }) => void;
  cover?: boolean;
}

function DockItem({ id, label, icon, size, running, active, onActivate, onMenu, cover }: DockItemProps) {
  const [hover, setHover] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);

  // Langes Drücken auf Touch-Geräten öffnet das Kontextmenü.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    longPressed.current = false;
    const { clientX, clientY } = e;
    pressTimer.current = window.setTimeout(() => {
      longPressed.current = true;
      onMenu({ clientX, clientY });
    }, 520);
  };
  const cancelPress = () => {
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  return (
    <div className="relative flex flex-col items-center" onPointerEnter={(e) => e.pointerType !== 'touch' && setHover(true)} onPointerLeave={() => setHover(false)}>
      <Tooltip label={label} visible={hover} />
      <button
        type="button"
        data-dock-item={id}
        aria-label={label}
        aria-pressed={active}
        onClick={() => {
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          setHover(false);
          onActivate();
        }}
        onContextMenu={(e) => {
          cancelPress();
          onMenu(e);
        }}
        onPointerDown={onPointerDown}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        className="group relative flex items-center justify-center rounded-lg transition-transform duration-[var(--dur)] ease-[var(--ease-out)] hover:-translate-y-1 active:translate-y-0 active:scale-95"
        style={{ width: size + 8, height: size + 8 }}
      >
        {cover ? (
          <img src={icon} alt="" draggable={false} className="rounded-md object-cover shadow-md" style={{ width: size * 0.92, height: size * 0.92 }} />
        ) : (
          <img src={icon} alt="" draggable={false} style={{ width: size, height: size }} />
        )}
      </button>
      <span
        aria-hidden
        className={cn(
          'absolute -bottom-[5px] h-1 rounded-full transition-all duration-[var(--dur)]',
          running ? (active ? 'w-3 bg-fg' : 'w-1 bg-fg-muted') : 'w-0 bg-transparent',
        )}
      />
    </div>
  );
}

export function Dock() {
  const { dockSize, autohide, showRunning, pinned } = useSettings(
    useShallow((s) => ({ dockSize: s.dockSize, autohide: s.dockAutohide, showRunning: s.dockShowRunning, pinned: s.pinnedApps })),
  );
  const setSetting = useSettings((s) => s.set);
  const { windows, order, focusedId } = useWindows(useShallow((s) => ({ windows: s.windows, order: s.order, focusedId: s.focusedId })));
  const games = useServer((s) => s.games);
  const { dockRevealed, setDockRevealed } = useShell(useShallow((s) => ({ dockRevealed: s.dockRevealed, setDockRevealed: s.setDockRevealed })));
  const size = DOCK_SIZES[dockSize];
  const hideTimer = useRef<number | null>(null);

  const runningApps = new Set(Object.values(windows).map((w) => w.appId));
  const focusedApp = focusedId ? windows[focusedId]?.appId : null;
  const extraRunning = showRunning ? [...new Set(order.map((id) => windows[id]?.appId).filter((a): a is AppId => !!a && !pinned.includes(a)))] : [];
  const visible = !autohide || dockRevealed;

  useEffect(() => () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
  }, []);

  const scheduleHide = () => {
    if (!autohide) return;
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setDockRevealed(false), 700);
  };

  const menuFor = (appId: AppId) => (e: React.MouseEvent | { clientX: number; clientY: number }) => {
    const meta = APP_META[appId];
    const appWins = order.filter((id) => windows[id]?.appId === appId);
    const isPinned = pinned.includes(appId);
    const items: MenuEntry[] = [];
    for (const id of appWins) {
      const w = windows[id]!;
      items.push({ id: `w-${id}`, label: w.title, icon: SquareStack, checked: focusedId === id, run: () => useWindows.getState().focus(id) });
    }
    if (appWins.length) items.push('separator');
    if (!meta.singleInstance || appWins.length === 0) {
      items.push({ id: 'new', label: appWins.length ? t.window.newWindow : t.system.open, icon: Plus, run: () => openApp(appId, null, { newInstance: appWins.length > 0 }) });
    }
    if (appId !== 'player') {
      items.push({
        id: 'pin',
        label: isPinned ? t.desktop.removeFromDock : t.desktop.keepInDock,
        icon: isPinned ? PinOff : Pin,
        run: () => setSetting('pinnedApps', isPinned ? pinned.filter((p) => p !== appId) : [...pinned, appId]),
      });
    }
    if (appWins.length) items.push('separator', { id: 'quit', label: t.desktop.quit, icon: X, run: () => closeApp(appId) });
    showContextMenu(e as React.MouseEvent, items);
  };

  const playerWin = Object.values(windows).find((w) => w.appId === 'player');
  const playerGame = playerWin ? games.find((g) => g.id === playerWin.payload?.gameId) : undefined;

  const itemFor = (appId: AppId) => {
    const isPlayer = appId === 'player';
    const icon = isPlayer && playerGame?.coverUrl ? playerGame.coverUrl : APP_META[appId].icon;
    return (
      <DockItem
        key={appId}
        id={appId}
        label={isPlayer && playerGame ? playerGame.title : APP_META[appId].name}
        icon={icon}
        cover={isPlayer && Boolean(playerGame?.coverUrl)}
        size={size}
        running={runningApps.has(appId)}
        active={focusedApp === appId}
        onActivate={() => activateApp(appId)}
        onMenu={menuFor(appId)}
      />
    );
  };

  return (
    <>
      {autohide ? (
        // Unsichtbarer Streifen am unteren Rand: Zeiger oder Tippen blendet das Dock ein.
        <div
          className="absolute inset-x-0 bottom-0 h-2"
          style={{ zIndex: 4999 }}
          onPointerEnter={() => setDockRevealed(true)}
          onPointerDown={() => setDockRevealed(true)}
          aria-hidden
        />
      ) : null}
      <nav
        aria-label="Dock"
        className="os-chrome pointer-events-none absolute inset-x-0 flex justify-center"
        style={{ bottom: 'calc(10px + var(--safe-bottom))', zIndex: 5000 }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          onPointerEnter={() => {
            if (hideTimer.current) window.clearTimeout(hideTimer.current);
          }}
          onPointerLeave={scheduleHide}
          className={cn(
            'panel-surface pointer-events-auto flex items-end gap-1 rounded-xl px-2 pt-1.5 pb-2 transition-[transform,opacity] duration-[var(--dur)] ease-[var(--ease-out)]',
            visible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-[calc(100%+16px)] opacity-0',
          )}
        >
          {pinned.filter((a) => APP_META[a]).map(itemFor)}
          {extraRunning.length ? <div className="mx-1 mb-1.5 w-px self-stretch bg-line-soft" aria-hidden /> : null}
          {extraRunning.map(itemFor)}
          <div className="mx-1 mb-1.5 w-px self-stretch bg-line-soft" aria-hidden />
          <DockItem
            id="trash"
            label={t.desktop.trash}
            icon="/icons/apps/trash.png"
            size={size}
            running={false}
            active={false}
            onActivate={() => openFilesAt('trash')}
            onMenu={(e) =>
              showContextMenu(e as React.MouseEvent, [
                { id: 'open', label: t.system.open, icon: Trash2, run: () => openFilesAt('trash') },
              ])
            }
          />
        </div>
      </nav>
    </>
  );
}
