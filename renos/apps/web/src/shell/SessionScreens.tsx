import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowRight, Lock, Power } from 'lucide-react';
import { RENOS_VERSION } from '@renos/shared';
import { locale } from '@/i18n';
import { Wallpaper } from '@/desktop/Wallpaper';
import { useSession } from '@/system/session';
import { useSettings } from '@/system/settings';
import { useWindows } from '@/system/windows';
import { RenosMark } from '@/ui/AppIcon';

/** Startbildschirm beim Einschalten bzw. Neustart. */
export function BootScreen({ label = 'RenOS startet …' }: { label?: string }) {
  return (
    <div className="fixed inset-0 z-[20000] flex flex-col items-center justify-center bg-[#07090d] text-white" data-testid="boot-screen" role="status" aria-label={label}>
      <motion.div initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.5 }} className="flex flex-col items-center">
        <RenosMark size={72} className="text-white" />
        <div className="mt-5 text-2xl font-semibold tracking-tight">RenOS</div>
        <div className="mt-8 h-1 w-40 overflow-hidden rounded-full bg-white/10">
          <motion.div className="h-full w-1/3 rounded-full bg-white/70" initial={{ x: '-100%' }} animate={{ x: '300%' }} transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }} />
        </div>
        <div className="mt-4 text-sm text-white/50">{label}</div>
      </motion.div>
      <div className="absolute bottom-6 text-xs text-white/30">Version {RENOS_VERSION}</div>
    </div>
  );
}

/** Ausgeschaltet: schwarzer Bildschirm mit Einschaltknopf. */
export function OffScreen() {
  const powerOn = useSession((s) => s.powerOn);
  return (
    <div className="fixed inset-0 z-[20000] flex flex-col items-center justify-center bg-black text-white" data-testid="off-screen">
      <button
        type="button"
        onClick={powerOn}
        className="flex h-20 w-20 items-center justify-center rounded-full border border-white/20 text-white/70 transition-colors hover:border-white/50 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
        aria-label="RenOS einschalten"
        data-testid="power-on"
        autoFocus
      >
        <Power size={32} />
      </button>
      <div className="mt-5 text-sm text-white/40">RenOS ist ausgeschaltet. Zum Einschalten tippen.</div>
    </div>
  );
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Sperrbildschirm mit Uhr, Benutzer und (optional) PIN-Abfrage. */
export function LockScreen() {
  const unlock = useSession((s) => s.unlock);
  const blockedUntil = useSession((s) => s.blockedUntil);
  const hasPin = useSettings((s) => Boolean(s.lockPinHash));
  const userName = useSettings((s) => s.userName);
  const clock24h = useSettings((s) => s.clock24h);
  const now = useClock();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const waitSeconds = Math.max(0, Math.ceil((blockedUntil - now.getTime()) / 1000));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Ohne PIN entsperrt jede Taste.
  useEffect(() => {
    if (hasPin) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.altKey || e.ctrlKey) return;
      e.preventDefault();
      void unlock();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasPin, unlock]);

  const submit = async () => {
    if (busy || !pin) return;
    setBusy(true);
    const result = await unlock(pin);
    setBusy(false);
    if (result.ok) return;
    setPin('');
    setShake((n) => n + 1);
    setError(result.reason === 'wait' ? `Zu viele Fehlversuche. Bitte ${Math.ceil(result.waitMs / 1000)} s warten.` : 'Falsche PIN.');
    inputRef.current?.focus();
  };

  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: !clock24h }).format(now);
  const date = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(now);

  return (
    <div className="fixed inset-0 z-[20000] overflow-hidden text-white" data-testid="lock-screen" role="dialog" aria-modal="true" aria-label="Gesperrt">
      <Wallpaper />
      <div className="absolute inset-0 bg-black/45 backdrop-blur-2xl" />
      <div
        className="relative flex h-full flex-col items-center justify-between px-6 py-[12vh]"
        onClick={() => (hasPin ? inputRef.current?.focus() : void unlock())}
      >
        <div className="text-center">
          <div className="tabular text-[clamp(64px,11vw,128px)] font-light leading-none tracking-tight" data-testid="lock-time">
            {time}
          </div>
          <div className="mt-3 text-lg text-white/80">{date}</div>
        </div>

        <div className="flex flex-col items-center" onClick={(e) => e.stopPropagation()}>
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-white/15 text-3xl font-semibold uppercase ring-1 ring-white/20">{userName.slice(0, 1)}</div>
          <div className="mt-3 text-lg font-medium">{userName}</div>
          {hasPin ? (
            <motion.form
              key={shake}
              animate={shake ? { x: [0, -10, 10, -6, 6, 0] } : undefined}
              transition={{ duration: 0.35 }}
              className="mt-5 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <input
                ref={inputRef}
                type="password"
                autoComplete="current-password"
                value={pin}
                onChange={(e) => {
                  setPin(e.target.value);
                  setError(null);
                }}
                disabled={waitSeconds > 0}
                placeholder={waitSeconds > 0 ? `Warten … ${waitSeconds} s` : 'PIN oder Passwort'}
                aria-label="PIN oder Passwort"
                className="h-11 w-64 rounded-full border border-white/20 bg-white/10 px-5 text-base text-white placeholder:text-white/50 focus:border-white/50 focus:outline-none disabled:opacity-60"
                data-testid="lock-pin"
              />
              <button
                type="submit"
                disabled={busy || !pin || waitSeconds > 0}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-white/20 text-white transition-colors hover:bg-white/30 disabled:opacity-40"
                aria-label="Entsperren"
                data-testid="lock-submit"
              >
                <ArrowRight size={20} />
              </button>
            </motion.form>
          ) : (
            <button
              type="button"
              onClick={() => void unlock()}
              className="mt-5 flex items-center gap-2 rounded-full bg-white/15 px-5 py-2.5 text-base hover:bg-white/25"
              data-testid="lock-unlock"
            >
              <Lock size={16} /> Entsperren
            </button>
          )}
          <div className="mt-3 h-5 text-sm text-[#ffb4b4]" role="alert" data-testid="lock-error">
            {error}
          </div>
        </div>

        <div className="text-sm text-white/50">{hasPin ? 'Gesperrt · Eingabetaste zum Entsperren' : 'Zum Entsperren tippen oder eine Taste drücken'}</div>
      </div>
    </div>
  );
}

/** Legt Sperr-, Start- und Ausschaltbildschirm über den Schreibtisch. */
export function SessionOverlay() {
  const phase = useSession((s) => s.phase);
  if (phase === 'locked') return <LockScreen />;
  if (phase === 'off') return <OffScreen />;
  if (phase === 'booting') return <BootScreen />;
  if (phase === 'restarting') return <BootScreen label="RenOS wird neu gestartet …" />;
  return null;
}

/**
 * Automatisch sperren nach Inaktivität. Während ein Spiel im Vordergrund läuft, zählt das als
 * Aktivität (Eingaben im Spiel erreichen RenOS nicht).
 */
export function useAutoLock() {
  const minutes = useSettings((s) => s.autoLockMinutes);
  useEffect(() => {
    if (!minutes) return undefined;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    const timer = window.setInterval(() => {
      const { phase, lock } = useSession.getState();
      if (phase !== 'running') {
        last = Date.now();
        return;
      }
      const { focusedId, windows } = useWindows.getState();
      if (focusedId && windows[focusedId]?.appId === 'player') {
        last = Date.now();
        return;
      }
      if (Date.now() - last > minutes * 60_000) lock();
    }, 5000);
    return () => {
      for (const e of events) window.removeEventListener(e, touch);
      window.clearInterval(timer);
    };
  }, [minutes]);
}
