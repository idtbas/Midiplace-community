import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Info, Maximize, Minimize2, Settings2, X, XCircle } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { t, locale } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { openApp } from '@/system/actions';
import { useNotifications, type RenosNotification } from '@/system/notifications';
import { ACCENTS, useSettings, type AccentId } from '@/system/settings';
import { useShell } from '@/system/shell';
import { useWindows } from '@/system/windows';
import { Switch } from '@/ui/Form';

const KIND_ICON = { info: Info, success: CheckCircle2, warning: AlertTriangle, error: XCircle } as const;
const KIND_COLOR = { info: 'text-accent', success: 'text-success', warning: 'text-warning', error: 'text-danger' } as const;

function usePanelDismiss(ref: React.RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (ref.current?.contains(target) || target.closest('header')) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close, ref]);
}

function MiniCalendar() {
  const today = new Date();
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const days = useMemo(() => {
    const first = new Date(month);
    const offset = (first.getDay() + 6) % 7; // Woche beginnt am Montag
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return [...Array<null>(offset).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
  }, [month]);
  const isThisMonth = month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth();
  const weekdays = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  return (
    <div className="p-3">
      <div className="mb-1 text-sm text-fg-muted">{today.toLocaleDateString(locale, { weekday: 'long' })}</div>
      <div className="mb-3 text-xl font-semibold">{today.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })}</div>
      <div className="mb-2 flex items-center justify-between">
        <button type="button" className="rounded-sm px-2 py-0.5 text-fg-muted hover:bg-surface-3" aria-label="Vorheriger Monat" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
          ‹
        </button>
        <span className="text-base font-medium">{month.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}</span>
        <button type="button" className="rounded-sm px-2 py-0.5 text-fg-muted hover:bg-surface-3" aria-label="Nächster Monat" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 gap-y-1 text-center text-sm">
        {weekdays.map((d) => (
          <span key={d} className="text-xs text-fg-subtle">
            {d}
          </span>
        ))}
        {days.map((d, i) => (
          <span
            key={i}
            className={cn(
              'tabular mx-auto flex h-7 w-7 items-center justify-center rounded-full',
              d && isThisMonth && d === today.getDate() ? 'bg-accent font-semibold text-accent-fg' : 'text-fg-muted',
            )}
          >
            {d ?? ''}
          </span>
        ))}
      </div>
    </div>
  );
}

function NotificationItem({ n, onClose }: { n: RenosNotification; onClose?: () => void }) {
  const Icon = KIND_ICON[n.kind];
  return (
    <div className="flex gap-3 rounded-lg border border-line-soft bg-surface-1 p-3 shadow-sm">
      <Icon size={17} strokeWidth={2} className={cn('mt-0.5 shrink-0', KIND_COLOR[n.kind])} />
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium text-fg">{n.title}</div>
        {n.message ? <div className="selectable mt-0.5 break-words text-sm text-fg-muted">{n.message}</div> : null}
        {n.action ? (
          <button type="button" className="mt-2 text-sm font-medium text-accent hover:underline" onClick={n.action.run}>
            {n.action.label}
          </button>
        ) : null}
      </div>
      {onClose ? (
        <button type="button" aria-label={t.system.close} onClick={onClose} className="h-6 w-6 shrink-0 rounded-sm text-fg-subtle hover:bg-surface-3 hover:text-fg">
          <X size={14} className="mx-auto" />
        </button>
      ) : null}
    </div>
  );
}

export function NotificationPanel() {
  const { panel, closePanel } = useShell(useShallow((s) => ({ panel: s.panel, closePanel: s.closePanel })));
  const { items, remove, clear, markAllRead } = useNotifications();
  const dnd = useSettings((s) => s.doNotDisturb);
  const setSetting = useSettings((s) => s.set);
  const ref = useRef<HTMLDivElement>(null);
  const open = panel === 'notifications';
  usePanelDismiss(ref, open, closePanel);
  useEffect(() => {
    if (open) markAllRead();
  }, [open, markAllRead, items.length]);
  const list = items.filter((i) => !i.transient);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={ref}
          role="dialog"
          aria-label={t.notifications.title}
          className="os-chrome panel-surface fixed left-1/2 flex w-[680px] max-w-[calc(100vw-24px)] -translate-x-1/2 overflow-hidden rounded-xl"
          style={{ top: 'calc(var(--topbar-h) + var(--safe-top) + 6px)', zIndex: 7000, maxHeight: '70vh' }}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.16 }}
        >
          <div className="flex min-w-0 flex-1 flex-col border-r border-line-soft">
            <div className="flex items-center justify-between px-4 pt-3 pb-2">
              <h2 className="text-base font-semibold">{t.notifications.title}</h2>
              {list.length ? (
                <button type="button" className="text-sm text-fg-muted hover:text-fg" onClick={clear}>
                  {t.notifications.clear}
                </button>
              ) : null}
            </div>
            <div className="scroll-area flex min-h-[200px] flex-1 flex-col gap-2 px-3 pb-3">
              {list.length === 0 ? (
                <p className="m-auto text-base text-fg-subtle">{t.notifications.empty}</p>
              ) : (
                list.map((n) => (
                  <div key={n.id}>
                    <NotificationItem n={n} onClose={() => remove(n.id)} />
                    <div className="mt-1 pl-1 text-xs text-fg-subtle">{formatRelative(n.createdAt)}</div>
                  </div>
                ))
              )}
            </div>
            <div className="flex items-center justify-between border-t border-line-soft px-4 py-2.5">
              <div>
                <div className="text-base">{t.notifications.dnd}</div>
                <div className="text-xs text-fg-subtle">{t.notifications.dndHint}</div>
              </div>
              <Switch checked={dnd} onChange={(v) => setSetting('doNotDisturb', v)} label={t.notifications.dnd} />
            </div>
          </div>
          <div className="w-[260px] shrink-0">
            <MiniCalendar />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export function ToastHost() {
  const { toasts, items, dismissToast } = useNotifications(useShallow((s) => ({ toasts: s.toasts, items: s.items, dismissToast: s.dismissToast })));
  const visible = toasts.map((id) => items.find((i) => i.id === id)).filter((n): n is RenosNotification => Boolean(n));
  return (
    <div
      className="os-chrome pointer-events-none fixed right-3 flex w-[340px] max-w-[calc(100vw-24px)] flex-col gap-2"
      style={{ top: 'calc(var(--topbar-h) + var(--safe-top) + 8px)', zIndex: 9600 }}
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {visible.map((n) => (
          <motion.div
            key={n.id}
            layout
            className="pointer-events-auto"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
            data-testid="toast"
          >
            <NotificationItem
              n={{ ...n, action: n.action ? { ...n.action, run: () => { n.action!.run(); dismissToast(n.id); } } : undefined }}
              onClose={() => dismissToast(n.id)}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function fullscreenSupported(): boolean {
  const doc = document as Document & { webkitFullscreenEnabled?: boolean };
  return Boolean(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
}

async function toggleFullscreen(): Promise<void> {
  const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  if (document.fullscreenElement || doc.webkitFullscreenElement) {
    if (document.exitFullscreen) await document.exitFullscreen();
    else doc.webkitExitFullscreen?.();
  } else if (el.requestFullscreen) {
    await el.requestFullscreen();
  } else {
    el.webkitRequestFullscreen?.();
  }
}

export function QuickSettingsPanel() {
  const { panel, closePanel } = useShell(useShallow((s) => ({ panel: s.panel, closePanel: s.closePanel })));
  const s = useSettings();
  const ref = useRef<HTMLDivElement>(null);
  const open = panel === 'quick';
  usePanelDismiss(ref, open, closePanel);
  const [isFull, setIsFull] = useState(Boolean(document.fullscreenElement));
  useEffect(() => {
    const update = () => setIsFull(Boolean(document.fullscreenElement || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement));
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('webkitfullscreenchange', update);
    return () => {
      document.removeEventListener('fullscreenchange', update);
      document.removeEventListener('webkitfullscreenchange', update);
    };
  }, []);

  const toggles: Array<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = [
    { label: t.quick.reduceMotion, checked: s.motion === 'reduced', onChange: (v) => s.set('motion', v ? 'reduced' : 'system') },
    { label: t.quick.transparency, checked: s.transparency, onChange: (v) => s.set('transparency', v) },
    { label: t.quick.dockAutohide, checked: s.dockAutohide, onChange: (v) => s.set('dockAutohide', v) },
    { label: t.notifications.dnd, checked: s.doNotDisturb, onChange: (v) => s.set('doNotDisturb', v) },
  ];

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={ref}
          role="dialog"
          aria-label={t.quick.title}
          className="os-chrome panel-surface fixed right-2 w-[320px] rounded-xl p-3"
          style={{ top: 'calc(var(--topbar-h) + var(--safe-top) + 6px)', zIndex: 7000 }}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.16 }}
        >
          <div className="flex flex-col gap-1">
            {toggles.map((toggle) => (
              <div key={toggle.label} className="flex h-10 items-center justify-between rounded-md px-2 hover:bg-surface-3/50">
                <span className="text-base">{toggle.label}</span>
                <Switch checked={toggle.checked} onChange={toggle.onChange} label={toggle.label} />
              </div>
            ))}
          </div>
          <div className="mt-2 border-t border-line-soft px-2 pt-3">
            <div className="mb-2 text-sm text-fg-muted">{t.quick.accent}</div>
            <div className="flex gap-2">
              {(Object.keys(ACCENTS) as AccentId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-label={ACCENTS[id].label}
                  title={ACCENTS[id].label}
                  aria-pressed={s.accent === id}
                  onClick={() => s.set('accent', id)}
                  className={cn('h-7 w-7 rounded-full border-2 transition-transform hover:scale-110', s.accent === id ? 'border-fg' : 'border-transparent')}
                  style={{ background: ACCENTS[id].value }}
                />
              ))}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-line-soft pt-3">
            <button
              type="button"
              onClick={() => {
                useWindows.getState().minimizeAll();
                closePanel();
              }}
              className="flex h-9 items-center justify-center gap-2 rounded-md bg-surface-3/70 text-sm hover:bg-surface-4"
            >
              <Minimize2 size={14} /> {t.quick.minimizeAll}
            </button>
            {fullscreenSupported() ? (
              <button
                type="button"
                onClick={() => void toggleFullscreen()}
                className="flex h-9 items-center justify-center gap-2 rounded-md bg-surface-3/70 text-sm hover:bg-surface-4"
                aria-pressed={isFull}
              >
                <Maximize size={14} /> {t.quick.fullscreen}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                openApp('settings');
                closePanel();
              }}
              className="col-span-2 flex h-9 items-center justify-center gap-2 rounded-md bg-surface-3/70 text-sm hover:bg-surface-4"
            >
              <Settings2 size={14} /> {t.quick.settings}
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
