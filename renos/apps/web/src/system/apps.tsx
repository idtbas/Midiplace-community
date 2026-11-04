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
  editor: lazy(() => import('@/apps/editor/EditorApp')),
  viewer: lazy(() => import('@/apps/viewer/ViewerApp')),
  media: lazy(() => import('@/apps/media/MediaApp')),
  calculator: lazy(() => import('@/apps/calculator/CalculatorApp')),
  clock: lazy(() => import('@/apps/clock/ClockApp')),
  monitor: lazy(() => import('@/apps/monitor/MonitorApp')),
  player: lazy(() => import('@/apps/player/PlayerApp')),
};
