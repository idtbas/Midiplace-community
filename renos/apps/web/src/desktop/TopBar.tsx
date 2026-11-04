import { useEffect, useState } from 'react';
import { Bell, BellOff, ChevronDown, HardDrive, Server, ServerOff, Settings2, SlidersHorizontal, Wifi, WifiOff } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { t, locale } from '@/i18n';
import { cn } from '@/lib/cn';
import { useServer } from '@/api/server';
import { IS_LOCAL } from '@/config';
import { openApp } from '@/system/actions';
import { APP_META } from '@/system/appMeta';
import { showMenuAt, type MenuEntry } from '@/system/contextMenu';
import { useNotifications } from '@/system/notifications';
import { useSettings } from '@/system/settings';
import { useShell } from '@/system/shell';
import { formatCombo } from '@/system/shortcuts';
import { useWindows } from '@/system/windows';
import { RenosMark } from '@/ui/AppIcon';

function useClock(withSeconds: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: number;
    const tick = () => {
      setNow(new Date());
      const delay = withSeconds ? 1000 - (Date.now() % 1000) : 60_000 - (Date.now() % 60_000);
      timer = window.setTimeout(tick, delay + 5);
    };
    timer = window.setTimeout(tick, withSeconds ? 1000 - (Date.now() % 1000) : 60_000 - (Date.now() % 60_000));
    return () => window.clearTimeout(timer);
  }, [withSeconds]);
  return now;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

function BarButton({
  children,
  label,
  onClick,
  active,
  className,
  id,
}: {
  children: React.ReactNode;
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex h-[26px] items-center gap-1.5 rounded-sm px-2 text-fg transition-colors duration-[var(--dur-fast)] hover:bg-white/8 active:bg-white/12',
        active && 'bg-white/10',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TopBar() {
  const settings = useSettings(useShallow((s) => ({ clock24h: s.clock24h, clockSeconds: s.clockSeconds, clockShowDate: s.clockShowDate, dnd: s.doNotDisturb })));
  const { panel, togglePanel, toggleLauncher, launcherOpen } = useShell();
  const focusedWin = useWindows((s) => (s.focusedId ? s.windows[s.focusedId] : null));
  const server = useServer(useShallow((s) => ({ status: s.status, authenticated: s.session?.authenticated ?? false, publicLibrary: s.health?.publicLibrary ?? false })));
  const unread = useNotifications((s) => s.items.filter((i) => !i.read && !i.transient).length);
  const now = useClock(settings.clockSeconds);
  const online = useOnline();

  const time = now.toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: settings.clockSeconds ? '2-digit' : undefined,
    hour12: !settings.clock24h,
  });
  const date = now.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });

  const appMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!focusedWin) return;
    const meta = APP_META[focusedWin.appId];
    const { minimize, toggleMaximize, close } = useWindows.getState();
    const items: MenuEntry[] = [];
    if (!meta.singleInstance) items.push({ id: 'new', label: t.window.newWindow, run: () => openApp(meta.id, null, { newInstance: true }) });
    items.push(
      { id: 'min', label: t.window.minimize, shortcut: formatCombo('Alt+M'), run: () => minimize(focusedWin.id) },
      { id: 'max', label: focusedWin.mode === 'normal' ? t.window.maximize : t.window.restore, shortcut: formatCombo('Ctrl+Alt+ArrowUp'), run: () => toggleMaximize(focusedWin.id) },
      'separator',
      { id: 'close', label: t.window.close, shortcut: formatCombo('Alt+W'), run: () => close(focusedWin.id) },
    );
    showMenuAt(e.currentTarget, items);
  };

  const serverLabel = IS_LOCAL
    ? 'Spiele lokal auf diesem iPad'
    :
    server.status === 'offline' ? t.topbar.serverOffline : server.authenticated || server.publicLibrary ? t.topbar.serverOnline : t.topbar.serverAuth;

  return (
    <header
      className="os-chrome absolute inset-x-0 top-0 flex items-center justify-between bg-[#0c0f14]/88 px-1.5 text-sm"
      style={{ height: 'var(--topbar-h)', paddingTop: 'var(--safe-top)', zIndex: 5000, boxSizing: 'content-box' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex min-w-0 flex-1 items-center gap-0.5">
        <BarButton label={`${t.system.apps} (${formatCombo('Alt+Space')})`} onClick={() => toggleLauncher()} active={launcherOpen} id="renos-launcher-button">
          <RenosMark size={15} className="text-fg" />
          <span className="font-semibold">{t.system.activities}</span>
        </BarButton>
        {focusedWin ? (
          <BarButton label={t.topbar.appMenu} onClick={appMenu} className="min-w-0 text-fg-muted">
            <span className="truncate font-medium text-fg">{APP_META[focusedWin.appId].name}</span>
            <ChevronDown size={13} strokeWidth={2} className="text-fg-subtle" />
          </BarButton>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center">
        <BarButton label={t.notifications.title} onClick={() => togglePanel('notifications')} active={panel === 'notifications'}>
          <span className="tabular font-semibold">
            {settings.clockShowDate ? <span className="mr-2 font-medium text-fg-muted">{date}</span> : null}
            {time}
          </span>
          {unread > 0 && !settings.dnd ? <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden /> : null}
        </BarButton>
      </div>

      <div className="flex flex-1 items-center justify-end gap-0.5">
        <span className="flex h-[26px] items-center px-1.5 text-fg-muted" title={online ? t.topbar.online : t.topbar.offline} aria-label={online ? t.topbar.online : t.topbar.offline}>
          {online ? <Wifi size={15} strokeWidth={2} /> : <WifiOff size={15} strokeWidth={2} className="text-warning" />}
        </span>
        <span
          className="flex h-[26px] items-center px-1.5"
          title={serverLabel}
          aria-label={serverLabel}
          data-testid="server-status"
          data-status={server.status}
        >
          {IS_LOCAL ? (
            <HardDrive size={15} strokeWidth={2} className="text-fg-muted" />
          ) : server.status === 'offline' ? (
            <ServerOff size={15} strokeWidth={2} className="text-warning" />
          ) : (
            <Server size={15} strokeWidth={2} className={server.authenticated || server.publicLibrary ? 'text-fg-muted' : 'text-fg-subtle'} />
          )}
        </span>
        <BarButton label={t.topbar.notifications} onClick={() => togglePanel('notifications')} active={panel === 'notifications'}>
          {settings.dnd ? <BellOff size={15} strokeWidth={2} /> : <Bell size={15} strokeWidth={2} />}
          {unread > 0 ? <span className="tabular text-xs font-semibold text-accent">{unread}</span> : null}
        </BarButton>
        <BarButton label={t.topbar.quickSettings} onClick={() => togglePanel('quick')} active={panel === 'quick'}>
          <SlidersHorizontal size={15} strokeWidth={2} />
        </BarButton>
        <BarButton label={`${t.topbar.settings} (${formatCombo('Alt+,')})`} onClick={() => openApp('settings')}>
          <Settings2 size={15} strokeWidth={2} />
        </BarButton>
      </div>
    </header>
  );
}
