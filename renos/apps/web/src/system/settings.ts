import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { asset } from '@/config';
import type { AppId } from './appIds';

export const ACCENTS = {
  blau: { label: 'Blau', value: '#87a9e8' },
  salbei: { label: 'Salbei', value: '#8dbfae' },
  sand: { label: 'Sand', value: '#d8b98a' },
  rose: { label: 'Rosé', value: '#d9a0a8' },
  lavendel: { label: 'Lavendel', value: '#aba3e3' },
  graphit: { label: 'Graphit', value: '#aeb7c4' },
} as const;
export type AccentId = keyof typeof ACCENTS;

export const WALLPAPERS = {
  daemmerung: { label: 'Dämmerung', src: asset('wallpapers/daemmerung.jpg'), thumb: asset('wallpapers/daemmerung-thumb.jpg') },
  graphit: { label: 'Graphit', src: asset('wallpapers/graphit.jpg'), thumb: asset('wallpapers/graphit-thumb.jpg') },
  tiefsee: { label: 'Tiefsee', src: asset('wallpapers/tiefsee.jpg'), thumb: asset('wallpapers/tiefsee-thumb.jpg') },
} as const;
export type WallpaperId = keyof typeof WALLPAPERS | 'solid' | 'custom';

export const DOCK_SIZES = { small: 40, medium: 48, large: 58 } as const;
export type DockSize = keyof typeof DOCK_SIZES;

export interface Settings {
  accent: AccentId;
  wallpaper: WallpaperId;
  wallpaperDim: number;
  motion: 'system' | 'reduced' | 'full';
  transparency: boolean;
  uiScale: 1 | 1.08 | 1.16;
  clock24h: boolean;
  clockSeconds: boolean;
  clockShowDate: boolean;
  dockSize: DockSize;
  dockAutohide: boolean;
  dockShowRunning: boolean;
  pinnedApps: AppId[];
  windowSnapping: boolean;
  restoreSession: boolean;
  titlebarDoubleClick: 'maximize' | 'minimize' | 'none';
  shortcutsEnabled: boolean;
  typeToSearch: boolean;
  playerImmersive: boolean;
  playerAutohideControls: boolean;
  userName: string;
  onboardingCompleted: boolean;
  filesView: 'list' | 'grid';
  doNotDisturb: boolean;
  libraryCollapsedHelp: boolean;
  /** Adresse eines externen Spiele-Hosts (nur lokaler Modus). Leer = eingebauter Spiele-Host. */
  gameHostUrl: string;
  /** PBKDF2-Hash der Geräte-PIN für den Sperrbildschirm (leer = keine PIN). */
  lockPinHash: string;
  /** Automatisch sperren nach so vielen Minuten ohne Eingabe (0 = nie). */
  autoLockMinutes: number;
  /** Erscheinungsbild: dunkel, hell oder wie iPadOS. */
  theme: 'dark' | 'light' | 'system';
  /** Inhalt des Ordners „Schreibtisch“ als Symbole auf dem Schreibtisch zeigen. */
  desktopIcons: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  accent: 'blau',
  wallpaper: 'daemmerung',
  wallpaperDim: 0,
  motion: 'system',
  transparency: true,
  uiScale: 1,
  clock24h: true,
  clockSeconds: false,
  clockShowDate: true,
  dockSize: 'medium',
  dockAutohide: false,
  dockShowRunning: true,
  pinnedApps: ['files', 'library', 'installer', 'notes', 'terminal', 'settings'],
  windowSnapping: true,
  restoreSession: true,
  titlebarDoubleClick: 'maximize',
  shortcutsEnabled: true,
  typeToSearch: true,
  playerImmersive: true,
  playerAutohideControls: true,
  userName: 'user',
  onboardingCompleted: false,
  filesView: 'list',
  doNotDisturb: false,
  libraryCollapsedHelp: false,
  // Leer = eingebauter Spiele-Host. Eine Adresse wählt einen externen Host (optional).
  gameHostUrl: '',
  lockPinHash: '',
  autoLockMinutes: 0,
  theme: 'dark',
  desktopIcons: true,
};

interface SettingsStore extends Settings {
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  patch: (values: Partial<Settings>) => void;
  reset: () => void;
}

export const SETTINGS_STORAGE_KEY = 'renos.settings';

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      set: (key, value) => set({ [key]: value } as Partial<Settings>),
      patch: (values) => set(values),
      reset: () => set({ ...DEFAULT_SETTINGS, onboardingCompleted: true }),
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      version: 1,
      partialize: (state) => {
        const out: Partial<Settings> = {};
        for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
          (out as Record<string, unknown>)[key] = state[key];
        }
        return out as Settings;
      },
      merge: (persisted, current) => {
        const values = (persisted ?? {}) as Partial<Settings>;
        const merged = { ...current, ...values };
        // Ungültige Werte (z. B. aus älteren Versionen) auf Standard zurücksetzen.
        if (!(merged.accent in ACCENTS)) merged.accent = DEFAULT_SETTINGS.accent;
        if (!(merged.dockSize in DOCK_SIZES)) merged.dockSize = DEFAULT_SETTINGS.dockSize;
        if (!Array.isArray(merged.pinnedApps)) merged.pinnedApps = DEFAULT_SETTINGS.pinnedApps;
        if (typeof merged.gameHostUrl !== 'string') merged.gameHostUrl = '';
        if (typeof merged.lockPinHash !== 'string' || (merged.lockPinHash && !merged.lockPinHash.startsWith('pbkdf2$'))) merged.lockPinHash = '';
        if (![0, 1, 2, 5, 10, 15, 30, 60].includes(merged.autoLockMinutes)) merged.autoLockMinutes = 0;
        if (!['dark', 'light', 'system'].includes(merged.theme)) merged.theme = 'dark';
        if (typeof merged.desktopIcons !== 'boolean') merged.desktopIcons = true;
        if (typeof merged.userName !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(merged.userName)) merged.userName = DEFAULT_SETTINGS.userName;
        return merged;
      },
    },
  ),
);

/** Ob Animationen reduziert werden sollen (Einstellung oder Systemvorgabe). */
export function prefersReducedMotion(motion: Settings['motion']): boolean {
  if (motion === 'reduced') return true;
  if (motion === 'full') return false;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}
