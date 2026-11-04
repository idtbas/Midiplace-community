import { create } from 'zustand';
import type { ApiErrorCode, Game, HealthResponse, SessionResponse, StorageInfoResponse } from '@renos/shared';
import { ApiError, api, setCsrfToken } from './client';

/**
 * Zustand der Verbindung zum RenOS-Server: Erreichbarkeit, Anmeldung und Spieleliste.
 * Der Desktop funktioniert auch ohne Server – betroffene Apps zeigen dann einen Offline-Zustand.
 */

export type ServerStatus = 'unknown' | 'online' | 'offline';
export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

interface ServerStore {
  status: ServerStatus;
  health: HealthResponse | null;
  session: SessionResponse | null;
  games: Game[];
  gamesState: LoadState;
  gamesError: ApiErrorCode | 'network' | 'aborted' | null;
  storage: StorageInfoResponse | null;
  lastCheck: number;

  refreshHealth: () => Promise<boolean>;
  refreshSession: () => Promise<void>;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  loadGames: () => Promise<void>;
  loadStorage: () => Promise<void>;
  upsertGame: (game: Game) => void;
  removeGame: (id: string) => void;
}

export const useServer = create<ServerStore>()((set, get) => ({
  status: 'unknown',
  health: null,
  session: null,
  games: [],
  gamesState: 'idle',
  gamesError: null,
  storage: null,
  lastCheck: 0,

  refreshHealth: async () => {
    try {
      const health = await api.health();
      set({ health, status: 'online', lastCheck: Date.now() });
      return true;
    } catch {
      set({ status: 'offline', lastCheck: Date.now() });
      return false;
    }
  },

  refreshSession: async () => {
    try {
      const session = await api.session();
      setCsrfToken(session.csrfToken);
      set({ session, status: 'online' });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'network') set({ status: 'offline' });
    }
  },

  login: async (password) => {
    const session = await api.login(password);
    setCsrfToken(session.csrfToken);
    set({ session, status: 'online' });
    void get().loadGames();
  },

  logout: async () => {
    try {
      await api.logout();
    } finally {
      setCsrfToken(null);
      const health = get().health;
      set({
        session: { authenticated: false, ownerConfigured: health?.ownerConfigured ?? true, csrfToken: null, expiresAt: null },
        games: health?.publicLibrary ? get().games : [],
        gamesState: health?.publicLibrary ? get().gamesState : 'idle',
        storage: null,
      });
    }
  },

  loadGames: async () => {
    set({ gamesState: get().games.length ? 'ready' : 'loading', gamesError: null });
    try {
      const { games } = await api.games();
      set({ games, gamesState: 'ready', status: 'online' });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'internal_error';
      set({ gamesState: 'error', gamesError: code, ...(code === 'network' ? { status: 'offline' as const } : {}) });
    }
  },

  loadStorage: async () => {
    try {
      set({ storage: await api.storage() });
    } catch {
      /* Anzeige bleibt leer */
    }
  },

  upsertGame: (game) =>
    set((s) => ({ games: s.games.some((g) => g.id === game.id) ? s.games.map((g) => (g.id === game.id ? game : g)) : [...s.games, game] })),

  removeGame: (id) => set((s) => ({ games: s.games.filter((g) => g.id !== id) })),
}));

/** Darf der aktuelle Nutzer die Bibliothek lesen? */
export function canReadLibrary(state: Pick<ServerStore, 'health' | 'session'>): boolean {
  return Boolean(state.health?.publicLibrary || state.session?.authenticated);
}

let pollTimer: number | null = null;

/** Startet die regelmäßige Prüfung der Servererreichbarkeit. */
export function startServerMonitor(): () => void {
  const store = useServer.getState();
  const check = async () => {
    const wasOnline = useServer.getState().status === 'online';
    const ok = await store.refreshHealth();
    if (ok && (!wasOnline || !useServer.getState().session)) {
      await store.refreshSession();
      const state = useServer.getState();
      if (canReadLibrary(state)) void state.loadGames();
    }
  };
  void check();
  const onVisible = () => {
    if (document.visibilityState === 'visible') void check();
  };
  window.addEventListener('online', check);
  window.addEventListener('offline', () => useServer.setState({ status: 'offline' }));
  document.addEventListener('visibilitychange', onVisible);
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void check();
  }, 30_000);
  return () => {
    if (pollTimer) window.clearInterval(pollTimer);
    window.removeEventListener('online', check);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
