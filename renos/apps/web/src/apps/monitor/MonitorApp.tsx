import { useEffect, useRef, useState } from 'react';
import { Activity, AppWindow, Eye, HardDrive, X } from 'lucide-react';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useServer } from '@/api/server';
import { IS_LOCAL } from '@/config';
import { listInstalledRuntimes } from '@/games/local/runtimes';
import { usage } from '@/persistence/fs';
import { APP_META } from '@/system/appMeta';
import type { AppProps } from '@/system/apps';
import { confirmDialog } from '@/system/dialogs';
import { useSession } from '@/system/session';
import { useWindows } from '@/system/windows';
import { AppIcon } from '@/ui/AppIcon';
import { Button, IconButton } from '@/ui/Button';
import { ProgressBar } from '@/ui/Feedback';

type Tab = 'apps' | 'performance' | 'storage';

function since(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

function AppsTab() {
  const windows = useWindows((s) => s.windows);
  const order = useWindows((s) => s.order);
  const focusedId = useWindows((s) => s.focusedId);
  const now = useNow();
  const list = [...order].reverse().map((id) => windows[id]).filter((w): w is NonNullable<typeof w> => Boolean(w));
  const closeAll = async () => {
    if (!(await confirmDialog({ title: 'Alle Apps beenden?', message: 'Alle Fenster werden geschlossen, laufende Spiele beendet.', confirmLabel: 'Alle beenden', destructive: true }))) return;
    useWindows.getState().closeAll();
  };
  return (
    <div className="flex flex-col">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface-1 text-left text-xs text-fg-subtle">
          <tr>
            <th className="px-3 py-2 font-medium">App</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Läuft seit</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {list.map((w) => (
            <tr key={w.id} className="border-t border-line-soft" data-testid="monitor-row">
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <AppIcon appId={w.appId} size={20} />
                  <div className="min-w-0">
                    <div className="truncate text-fg">{w.title}</div>
                    <div className="text-xs text-fg-subtle">{APP_META[w.appId].name}</div>
                  </div>
                </div>
              </td>
              <td className="px-3 py-2 text-fg-muted">{w.minimized ? 'Minimiert' : w.id === focusedId ? 'Im Vordergrund' : 'Geöffnet'}</td>
              <td className="tabular px-3 py-2 text-fg-muted">{since(w.createdAt, now)}</td>
              <td className="px-3 py-2">
                <div className="flex justify-end gap-1">
                  <IconButton icon={Eye} label="Anzeigen" size="sm" onClick={() => useWindows.getState().focus(w.id)} />
                  <IconButton icon={X} label={`${w.title} beenden`} size="sm" onClick={() => useWindows.getState().close(w.id)} data-testid="monitor-close" />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between px-3 py-3 text-sm text-fg-subtle">
        <span>{list.length} geöffnete Fenster</span>
        <Button size="sm" variant="danger" disabled={list.length <= 1} onClick={() => void closeAll()}>
          Alle beenden
        </Button>
      </div>
    </div>
  );
}

function PerformanceTab() {
  const [fps, setFps] = useState<number[]>([]);
  const startedAt = useSession((s) => s.startedAt);
  const now = useNow();
  const frames = useRef(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      frames.current += 1;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const id = window.setInterval(() => {
      setFps((f) => [...f.slice(-59), frames.current]);
      frames.current = 0;
    }, 1000);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(id);
    };
  }, []);
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  const deviceMemory = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  const current = fps[fps.length - 1] ?? 0;
  const max = Math.max(60, ...fps);
  const points = fps.map((v, i) => `${(i / 59) * 100},${40 - (v / max) * 38}`).join(' ');
  const rows: Array<[string, string]> = [
    ['Sitzung läuft seit', since(startedAt, now)],
    ['Prozessor-Threads', navigator.hardwareConcurrency ? String(navigator.hardwareConcurrency) : 'nicht verfügbar'],
    ['Gerätespeicher (Näherung)', deviceMemory ? `${deviceMemory} GB` : 'vom Browser nicht angegeben'],
    ['JavaScript-Speicher', memory ? `${formatBytes(memory.usedJSHeapSize)} von ${formatBytes(memory.jsHeapSizeLimit)}` : 'vom Browser nicht angegeben'],
    ['Verbindung', navigator.onLine ? 'online' : 'offline'],
    ['Geöffnete Fenster', String(Object.keys(useWindows.getState().windows).length)],
  ];
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="rounded-lg border border-line-soft p-3">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium">Bildrate</span>
          <span className="tabular text-2xl font-light" data-testid="monitor-fps">
            {current} fps
          </span>
        </div>
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="mt-2 h-20 w-full">
          <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        </svg>
        <p className="mt-1 text-xs text-fg-subtle">Bilder pro Sekunde der Oberfläche in den letzten 60 Sekunden – ein Maß dafür, wie flüssig RenOS gerade läuft.</p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-subtle">{k}</dt>
            <dd className="tabular text-fg-muted">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-fg-subtle">Akku, Prozessorlast und Temperatur stellt der Browser Web-Apps nicht zur Verfügung; RenOS zeigt deshalb nur, was es wirklich messen kann.</p>
    </div>
  );
}

function StorageTab() {
  const storage = useServer((s) => s.storage);
  const loadStorage = useServer((s) => s.loadStorage);
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  const [files, setFiles] = useState<{ files: number; bytes: number } | null>(null);
  const [runtimes, setRuntimes] = useState<number | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => {
    void loadStorage();
    void navigator.storage?.estimate?.().then((e) => setEstimate({ usage: e.usage ?? 0, quota: e.quota ?? 0 }));
    void navigator.storage?.persisted?.().then(setPersisted);
    void usage().then(setFiles);
    if (IS_LOCAL) void listInstalledRuntimes().then((list) => setRuntimes(list.reduce((n, r) => n + r.totalBytes, 0)));
  }, [loadStorage]);
  const parts: Array<[string, number | null]> = [
    ['Dateien (Files)', files?.bytes ?? null],
    [IS_LOCAL ? 'Spiele auf diesem Gerät' : 'Spiele auf dem Server', storage?.gamesBytes ?? null],
    ...(IS_LOCAL ? ([['Ren’Py-Laufzeiten', runtimes]] as Array<[string, number | null]>) : []),
  ];
  return (
    <div className="flex flex-col gap-4 p-4">
      {estimate && estimate.quota ? (
        <div>
          <div className="flex justify-between text-sm">
            <span>Belegt durch RenOS</span>
            <span className="tabular text-fg-muted" data-testid="monitor-usage">
              {formatBytes(estimate.usage)} von {formatBytes(estimate.quota)}
            </span>
          </div>
          <ProgressBar className="mt-2" value={estimate.usage / estimate.quota} label="Speicherbelegung" />
        </div>
      ) : (
        <p className="text-sm text-fg-subtle">Der Browser gibt keine Speicherschätzung an.</p>
      )}
      <dl className="grid grid-cols-[1fr_auto] gap-y-2 text-sm">
        {parts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-muted">{k}</dt>
            <dd className="tabular text-right">{v === null ? '…' : formatBytes(v)}</dd>
          </div>
        ))}
      </dl>
      <p className={cn('text-sm', persisted ? 'text-success' : 'text-fg-subtle')}>
        {persisted ? 'Dauerhafter Speicher ist aktiv – iPadOS löscht nichts automatisch.' : 'Dauerhafter Speicher ist nicht aktiv (Settings → Speicher).'}
      </p>
    </div>
  );
}

const TABS: Array<{ id: Tab; label: string; icon: typeof Activity }> = [
  { id: 'apps', label: 'Apps', icon: AppWindow },
  { id: 'performance', label: 'Leistung', icon: Activity },
  { id: 'storage', label: 'Speicher', icon: HardDrive },
];

export default function MonitorApp(_props: AppProps) {
  const [tab, setTab] = useState<Tab>('apps');
  return (
    <div className="flex h-full flex-col bg-surface-1" data-testid="monitor">
      <div className="flex gap-1 border-b border-line-soft p-2" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm', tab === t.id ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:bg-surface-2')}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>
      <div className="scroll-area min-h-0 flex-1 overflow-auto">{tab === 'apps' ? <AppsTab /> : tab === 'performance' ? <PerformanceTab /> : <StorageTab />}</div>
    </div>
  );
}
