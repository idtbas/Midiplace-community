import { create } from 'zustand';

/** Zustand der Desktop-Shell (Overlays der Systemleiste, Launcher). */
type Panel = 'notifications' | 'quick' | null;

interface ShellStore {
  launcherOpen: boolean;
  launcherQuery: string;
  panel: Panel;
  dockRevealed: boolean;
  openLauncher: (query?: string) => void;
  closeLauncher: () => void;
  toggleLauncher: () => void;
  setLauncherQuery: (query: string) => void;
  togglePanel: (panel: Exclude<Panel, null>) => void;
  closePanel: () => void;
  setDockRevealed: (revealed: boolean) => void;
}

export const useShell = create<ShellStore>()((set, get) => ({
  launcherOpen: false,
  launcherQuery: '',
  panel: null,
  dockRevealed: false,
  openLauncher: (query = '') => set({ launcherOpen: true, launcherQuery: query, panel: null }),
  closeLauncher: () => set({ launcherOpen: false, launcherQuery: '' }),
  toggleLauncher: () => (get().launcherOpen ? get().closeLauncher() : get().openLauncher()),
  setLauncherQuery: (launcherQuery) => set({ launcherQuery }),
  togglePanel: (panel) => set((s) => ({ panel: s.panel === panel ? null : panel, launcherOpen: false })),
  closePanel: () => set({ panel: null }),
  setDockRevealed: (dockRevealed) => set({ dockRevealed }),
}));
