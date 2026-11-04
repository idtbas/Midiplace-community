import { create } from 'zustand';
import { lockoutMs, verifyPin } from './lock';
import { useSettings } from './settings';
import { useWindows } from './windows';

/**
 * Sitzung des Betriebssystems: läuft, gesperrt, ausgeschaltet, startet (neu).
 * Bewusst nicht gespeichert – nach dem Öffnen von RenOS entscheidet die PIN-Einstellung,
 * ob der Sperrbildschirm erscheint.
 */
export type SessionPhase = 'booting' | 'running' | 'locked' | 'off' | 'restarting';

export type UnlockResult = { ok: true } | { ok: false; reason: 'wrong' | 'wait'; waitMs: number };

interface SessionStore {
  phase: SessionPhase;
  failedAttempts: number;
  blockedUntil: number;
  startedAt: number;
  /** Nach dem Systemstart: gesperrt (PIN gesetzt) oder direkt zum Schreibtisch. */
  start: () => void;
  lock: () => void;
  unlock: (pin?: string) => Promise<UnlockResult>;
  shutdown: () => void;
  powerOn: () => void;
  restart: () => void;
}

export const BOOT_MS = 1300;

function blurActive() {
  const el = document.activeElement as HTMLElement | null;
  el?.blur?.();
}

export const useSession = create<SessionStore>()((set, get) => ({
  phase: 'booting',
  failedAttempts: 0,
  blockedUntil: 0,
  startedAt: Date.now(),
  start: () => set({ phase: useSettings.getState().lockPinHash ? 'locked' : 'running', startedAt: Date.now() }),
  lock: () => {
    if (get().phase !== 'running') return;
    blurActive();
    set({ phase: 'locked' });
  },
  unlock: async (pin) => {
    const hash = useSettings.getState().lockPinHash;
    if (!hash) {
      set({ phase: 'running' });
      return { ok: true };
    }
    const now = Date.now();
    if (get().blockedUntil > now) return { ok: false, reason: 'wait', waitMs: get().blockedUntil - now };
    if (await verifyPin(pin ?? '', hash)) {
      set({ phase: 'running', failedAttempts: 0, blockedUntil: 0 });
      return { ok: true };
    }
    const failedAttempts = get().failedAttempts + 1;
    const wait = lockoutMs(failedAttempts);
    set({ failedAttempts, blockedUntil: wait ? Date.now() + wait : 0 });
    return { ok: false, reason: wait ? 'wait' : 'wrong', waitMs: wait };
  },
  shutdown: () => {
    blurActive();
    useWindows.getState().closeAll();
    set({ phase: 'off' });
  },
  powerOn: () => {
    set({ phase: 'booting' });
    window.setTimeout(() => get().start(), BOOT_MS);
  },
  restart: () => {
    blurActive();
    set({ phase: 'restarting' });
    window.setTimeout(() => window.location.reload(), 900);
  },
}));
