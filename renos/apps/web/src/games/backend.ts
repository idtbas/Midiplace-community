import type { Game, StorageInfoResponse } from '@renos/shared';
import { api } from '@/api/client';
import { IS_LOCAL } from '@/config';
import { useSettings } from '@/system/settings';
import {
  deleteLocalGame,
  getLocalGame,
  listLocalGames,
  localStorageInfo,
  markLocalPlayed,
  removeLocalCover,
  renameLocalGame,
  setLocalCover,
} from './local/localGames';
import { gameHostUrl } from './gameHost';

/**
 * Gemeinsame Schnittstelle für Spiele – unabhängig davon, ob sie auf einem RenOS-Server
 * oder direkt auf diesem Gerät installiert sind.
 */
export interface GameBackend {
  list(): Promise<Game[]>;
  get(id: string): Promise<Game>;
  rename(id: string, title: string): Promise<Game>;
  remove(id: string): Promise<void>;
  markPlayed(id: string): Promise<Game>;
  setCover(id: string, image: Blob): Promise<Game>;
  removeCover(id: string): Promise<Game>;
  storage(): Promise<StorageInfoResponse>;
}

const serverBackend: GameBackend = {
  list: async () => (await api.games()).games,
  get: async (id) => (await api.game(id)).game,
  rename: async (id, title) => (await api.renameGame(id, title)).game,
  remove: (id) => api.deleteGame(id),
  markPlayed: async (id) => (await api.markPlayed(id)).game,
  setCover: async (id, image) => (await api.setCover(id, image)).game,
  removeCover: async (id) => (await api.removeCover(id)).game,
  storage: () => api.storage(),
};

const host = () => gameHostUrl(useSettings.getState().gameHostUrl) ?? '';

const localBackend: GameBackend = {
  list: () => listLocalGames(host()),
  get: (id) => getLocalGame(id, host()),
  rename: (id, title) => renameLocalGame(id, title, host()),
  remove: (id) => deleteLocalGame(id),
  markPlayed: (id) => markLocalPlayed(id, host()),
  setCover: (id, image) => setLocalCover(id, image, host()),
  removeCover: (id) => removeLocalCover(id, host()),
  storage: () => localStorageInfo(),
};

export const games: GameBackend = IS_LOCAL ? localBackend : serverBackend;
