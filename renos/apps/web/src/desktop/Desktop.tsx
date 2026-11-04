import { useEffect, useLayoutEffect, useRef } from 'react';
import { AppWindow, Grid2x2, Image as ImageIcon, Info, Minimize2, Settings2, XSquare } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { t } from '@/i18n';
import { startServerMonitor } from '@/api/server';
import { openApp } from '@/system/actions';
import { showContextMenu } from '@/system/contextMenu';
import { useSettings } from '@/system/settings';
import { useShell } from '@/system/shell';
import { dispatchShortcut, isEditableTarget, useShortcut } from '@/system/shortcuts';
import { useWindows } from '@/system/windows';
import { showAbout } from '@/shell/About';
import { OrientationHint } from '@/shell/OrientationHint';
import { WindowLayer } from '@/wm/WindowLayer';
import { ContextMenuHost } from './ContextMenuHost';
import { DialogHost } from './DialogHost';
import { Dock, dockReserve } from './Dock';
import { Launcher } from './Launcher';
import { NotificationPanel, QuickSettingsPanel, ToastHost } from './Panels';
import { TopBar } from './TopBar';
import { Wallpaper } from './Wallpaper';

function useGlobalShortcuts() {
  const ws = () => useWindows.getState();
  const focused = () => ws().focusedId;

  useShortcut({ id: 'sys.launcher', keys: ['Alt+Space', 'Mod+K'], scope: 'global', group: 'System', description: 'Anwendungen & Suche öffnen', allowInInput: true, handler: () => useShell.getState().toggleLauncher() });
  useShortcut({ id: 'sys.settings', keys: ['Alt+,', 'Mod+,'], scope: 'global', group: 'System', description: 'Einstellungen öffnen', allowInInput: true, handler: () => void openApp('settings') });
  useShortcut({ id: 'sys.desktop', keys: 'Alt+D', scope: 'global', group: 'System', description: 'Schreibtisch anzeigen (alle minimieren)', handler: () => ws().minimizeAll() });
  useShortcut({
    id: 'win.close',
    keys: 'Alt+W',
    scope: 'global',
    group: 'Fenster',
    description: 'Aktives Fenster schließen',
    allowInInput: true,
    handler: () => {
      const id = focused();
      if (!id) return false;
      ws().close(id);
    },
  });
  useShortcut({
    id: 'win.minimize',
    keys: 'Alt+M',
    scope: 'global',
    group: 'Fenster',
    description: 'Aktives Fenster minimieren',
    allowInInput: true,
    handler: () => {
      const id = focused();
      if (!id) return false;
      ws().minimize(id);
    },
  });
  useShortcut({
    id: 'win.maximize',
    keys: 'Ctrl+Alt+ArrowUp',
    scope: 'global',
    group: 'Fenster',
    description: 'Maximieren / wiederherstellen',
    handler: () => {
      const id = focused();
      if (!id) return false;
      ws().toggleMaximize(id);
    },
  });
  useShortcut({
    id: 'win.left',
    keys: 'Ctrl+Alt+ArrowLeft',
    scope: 'global',
    group: 'Fenster',
    description: 'Links anordnen',
    handler: () => {
      const id = focused();
      if (!id) return false;
      ws().setMode(id, 'snap-left');
    },
  });
  useShortcut({
    id: 'win.right',
    keys: 'Ctrl+Alt+ArrowRight',
    scope: 'global',
    group: 'Fenster',
    description: 'Rechts anordnen',
    handler: () => {
      const id = focused();
      if (!id) return false;
      ws().setMode(id, 'snap-right');
    },
  });
  useShortcut({ id: 'win.next', keys: ['Alt+Tab', 'Alt+`'], scope: 'global', group: 'Fenster', description: 'Zum nächsten Fenster wechseln', allowInInput: true, handler: () => ws().cycle(1) });
  useShortcut({ id: 'win.prev', keys: ['Alt+Shift+Tab', 'Alt+Shift+`'], scope: 'global', group: 'Fenster', description: 'Zum vorherigen Fenster wechseln', allowInInput: true, handler: () => ws().cycle(-1) });
  const pinned = useSettings((s) => s.pinnedApps);
  useShortcut({
    id: 'sys.dockapp',
    keys: ['Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', 'Alt+5', 'Alt+6', 'Alt+7', 'Alt+8', 'Alt+9'],
    scope: 'global',
    group: 'System',
    description: 'n-te App im Dock öffnen (⌥1 … ⌥9)',
    handler: (e) => {
      const app = pinned[Number(e.code.replace('Digit', '')) - 1];
      if (!app) return false;
      openApp(app);
    },
  });
}

export function Desktop() {
  const rootRef = useRef<HTMLDivElement>(null);
  const { dockSize, autohide, shortcutsEnabled, typeToSearch } = useSettings(
    useShallow((s) => ({ dockSize: s.dockSize, autohide: s.dockAutohide, shortcutsEnabled: s.shortcutsEnabled, typeToSearch: s.typeToSearch })),
  );
  useGlobalShortcuts();

  useEffect(() => startServerMonitor(), []);

  // Arbeitsfläche messen: Systemleiste oben, Dock unten. Reagiert auf Drehung, Split View und Stage Manager.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const measure = () => {
      const header = root.querySelector('header');
      const top = header ? header.getBoundingClientRect().bottom : 32;
      const width = root.clientWidth;
      const height = root.clientHeight;
      const reserve = dockReserve(dockSize, autohide);
      const safeBottom = parseFloat(getComputedStyle(root).getPropertyValue('padding-bottom')) || 0;
      useWindows.getState().setBounds({ x: 0, y: Math.round(top), w: width, h: Math.max(200, Math.round(height - top - reserve - safeBottom)) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    window.addEventListener('orientationchange', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('orientationchange', measure);
    };
  }, [dockSize, autohide]);

  // Zentrale Tastaturbehandlung.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { focusedId, windows } = useWindows.getState();
      const focusedAppId = focusedId ? (windows[focusedId]?.appId ?? null) : null;
      if (dispatchShortcut(event, { focusedAppId, focusedWindowId: focusedId }, { systemEnabled: shortcutsEnabled })) return;
      // Tippen auf dem leeren Schreibtisch öffnet die Suche (wie in GNOME).
      const shell = useShell.getState();
      if (
        typeToSearch &&
        !focusedId &&
        !shell.launcherOpen &&
        !isEditableTarget(event.target) &&
        event.key.length === 1 &&
        /\S/.test(event.key) &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        shell.openLauncher(event.key);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcutsEnabled, typeToSearch]);

  const onDesktopContextMenu = (event: React.MouseEvent) => {
    if (event.target !== event.currentTarget) return;
    showContextMenu(event, [
      { id: 'apps', label: t.desktop.showApps, icon: Grid2x2, shortcut: '⌥ Leertaste', run: () => useShell.getState().openLauncher() },
      { id: 'wallpaper', label: t.desktop.changeWallpaper, icon: ImageIcon, run: () => openApp('settings', { section: 'desktop' }) },
      'separator',
      { id: 'arrange', label: t.desktop.arrange, icon: AppWindow, run: () => useWindows.getState().arrange() },
      { id: 'minall', label: t.desktop.minimizeAll, icon: Minimize2, shortcut: '⌥D', run: () => useWindows.getState().minimizeAll() },
      { id: 'closeall', label: t.desktop.closeAll, icon: XSquare, run: () => useWindows.getState().closeAll() },
      'separator',
      { id: 'settings', label: t.desktop.openSettings, icon: Settings2, run: () => openApp('settings') },
      { id: 'about', label: t.desktop.about, icon: Info, run: () => showAbout() },
    ]);
  };

  // Langes Drücken auf dem Schreibtisch (Touch) öffnet ebenfalls das Kontextmenü.
  const pressTimer = useRef<number | null>(null);
  const onDesktopPointerDown = (event: React.PointerEvent) => {
    if (event.target !== event.currentTarget) return;
    useWindows.getState().blur();
    if (event.pointerType !== 'touch') return;
    const { clientX, clientY } = event;
    pressTimer.current = window.setTimeout(() => onDesktopContextMenu({ clientX, clientY, target: event.currentTarget, currentTarget: event.currentTarget, preventDefault() {}, stopPropagation() {} } as unknown as React.MouseEvent), 550);
  };
  const cancelPress = () => {
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
  };

  return (
    <div ref={rootRef} className="os-chrome fixed inset-0 overflow-hidden bg-desk" style={{ paddingBottom: 'var(--safe-bottom)' }} data-testid="desktop">
      <Wallpaper />
      <div className="absolute inset-0" onContextMenu={onDesktopContextMenu} onPointerDown={onDesktopPointerDown} onPointerUp={cancelPress} onPointerCancel={cancelPress} onPointerMove={cancelPress} />
      <WindowLayer />
      <TopBar />
      <Dock />
      <Launcher />
      <NotificationPanel />
      <QuickSettingsPanel />
      <ToastHost />
      <ContextMenuHost />
      <DialogHost />
      <OrientationHint />
    </div>
  );
}
