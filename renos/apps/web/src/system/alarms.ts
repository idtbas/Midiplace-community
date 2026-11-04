import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { notify } from './notifications';

/**
 * Wecker und Timer des Systems. Der Zeitplaner läuft im Schreibtisch – Wecker klingeln also auch,
 * wenn die Uhr-App geschlossen ist, aber nur solange RenOS geöffnet ist (eine Web-App kann sich
 * nicht selbst aufwecken).
 */

export interface Alarm {
  id: string;
  /** „HH:MM“ (24 h) */
  time: string;
  label: string;
  /** Wochentage 0 = Sonntag … 6 = Samstag; leer = einmalig. */
  days: number[];
  enabled: boolean;
  /** Zuletzt ausgelöst (YYYY-MM-DD HH:MM), damit ein Wecker pro Minute nur einmal klingelt. */
  lastFired: string | null;
}

export interface TimerState {
  endsAt: number;
  durationMs: number;
  label: string;
}

interface AlarmStore {
  alarms: Alarm[];
  timer: TimerState | null;
  addAlarm: (alarm: Omit<Alarm, 'id' | 'lastFired' | 'enabled'>) => void;
  updateAlarm: (id: string, patch: Partial<Alarm>) => void;
  removeAlarm: (id: string) => void;
  startTimer: (durationMs: number, label?: string) => void;
  cancelTimer: () => void;
}

export const useAlarms = create<AlarmStore>()(
  persist(
    (set) => ({
      alarms: [],
      timer: null,
      addAlarm: (alarm) => set((s) => ({ alarms: [...s.alarms, { ...alarm, id: crypto.randomUUID(), enabled: true, lastFired: null }].sort((a, b) => a.time.localeCompare(b.time)) })),
      updateAlarm: (id, patch) => set((s) => ({ alarms: s.alarms.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),
      removeAlarm: (id) => set((s) => ({ alarms: s.alarms.filter((a) => a.id !== id) })),
      startTimer: (durationMs, label = 'Timer') => set({ timer: { endsAt: Date.now() + durationMs, durationMs, label } }),
      cancelTimer: () => set({ timer: null }),
    }),
    { name: 'renos.alarms', version: 1 },
  ),
);

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function minuteKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Soll der Wecker zu diesem Zeitpunkt klingeln? */
export function alarmDue(alarm: Alarm, now: Date): boolean {
  if (!alarm.enabled) return false;
  if (alarm.time !== `${pad(now.getHours())}:${pad(now.getMinutes())}`) return false;
  if (alarm.days.length && !alarm.days.includes(now.getDay())) return false;
  return alarm.lastFired !== minuteKey(now);
}

/** Kurzer Signalton über Web Audio (kein Audio-Asset nötig). */
export function playChime(repeats = 3): void {
  try {
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const start = ctx.currentTime + 0.05;
    for (let r = 0; r < repeats; r += 1) {
      for (const [i, freq] of [880, 1175, 1568].entries()) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t = start + r * 0.9 + i * 0.16;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.45);
      }
    }
    window.setTimeout(() => void ctx.close().catch(() => undefined), repeats * 900 + 800);
  } catch {
    /* kein Ton verfügbar */
  }
}

/** Zeitplaner für Wecker und Timer (einmal im Schreibtisch eingebunden). */
export function useAlarmScheduler(): void {
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const { alarms, timer, updateAlarm, cancelTimer } = useAlarms.getState();
      for (const alarm of alarms) {
        if (!alarmDue(alarm, now)) continue;
        updateAlarm(alarm.id, { lastFired: minuteKey(now), enabled: alarm.days.length ? true : false });
        notify({ kind: 'info', title: `Wecker ${alarm.time}`, message: alarm.label || 'Es ist so weit.' });
        playChime(4);
      }
      if (timer && timer.endsAt <= now.getTime()) {
        cancelTimer();
        notify({ kind: 'info', title: `${timer.label} abgelaufen`, message: 'Der Timer ist abgelaufen.' });
        playChime(3);
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);
}
