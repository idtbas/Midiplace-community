import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { AppId } from './appIds';
import type { WindowPayload } from './windows';

export interface AppProps {
  windowId: string;
  payload: WindowPayload | null;
}

/**
 * Anwendungen werden erst beim ersten Öffnen geladen (Code-Splitting),
 * damit der Desktop schnell startet.
 */
export const APP_COMPONENTS: Record<AppId, LazyExoticComponent<ComponentType<AppProps>>> = {
  files: lazy(() => import('@/apps/files/FilesApp')),
  library: lazy(() => import('@/apps/library/LibraryApp')),
  installer: lazy(() => import('@/apps/installer/InstallerApp')),
  notes: lazy(() => import('@/apps/notes/NotesApp')),
  terminal: lazy(() => import('@/apps/terminal/TerminalApp')),
  settings: lazy(() => import('@/apps/settings/SettingsApp')),
  player: lazy(() => import('@/apps/player/PlayerApp')),
};
