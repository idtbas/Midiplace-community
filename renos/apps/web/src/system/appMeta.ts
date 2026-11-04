import { t } from '@/i18n';
import type { AppId } from './appIds';
import type { Size } from './geometry';
import { asset } from '@/config';

/** Metadaten der Systemanwendungen (ohne React-Komponenten, damit der Window Manager testbar bleibt). */
export interface AppMeta {
  id: AppId;
  name: string;
  description: string;
  icon: string;
  keywords: string[];
  defaultSize: Size;
  minSize: Size;
  singleInstance: boolean;
  showInLauncher: boolean;
}

export const APP_META: Record<AppId, AppMeta> = {
  files: {
    id: 'files',
    name: t.apps.files.name,
    description: t.apps.files.description,
    icon: asset('icons/apps/files.png'),
    keywords: ['dateien', 'ordner', 'dateimanager', 'files', 'finder', 'import', 'export'],
    defaultSize: { w: 860, h: 560 },
    minSize: { w: 520, h: 340 },
    singleInstance: false,
    showInLauncher: true,
  },
  library: {
    id: 'library',
    name: t.apps.library.name,
    description: t.apps.library.description,
    icon: asset('icons/apps/library.png'),
    keywords: ['spiele', 'bibliothek', 'library', 'renpy', 'games', 'visual novel'],
    defaultSize: { w: 980, h: 620 },
    minSize: { w: 600, h: 400 },
    singleInstance: true,
    showInLauncher: true,
  },
  installer: {
    id: 'installer',
    name: t.apps.installer.name,
    description: t.apps.installer.description,
    icon: asset('icons/apps/installer.png'),
    keywords: ['installieren', 'installer', 'zip', 'web-build', 'hinzufügen', 'upload'],
    defaultSize: { w: 680, h: 600 },
    minSize: { w: 480, h: 420 },
    singleInstance: true,
    showInLauncher: true,
  },
  notes: {
    id: 'notes',
    name: t.apps.notes.name,
    description: t.apps.notes.description,
    icon: asset('icons/apps/notes.png'),
    keywords: ['notizen', 'notes', 'text', 'schreiben', 'editor'],
    defaultSize: { w: 820, h: 540 },
    minSize: { w: 460, h: 320 },
    singleInstance: true,
    showInLauncher: true,
  },
  terminal: {
    id: 'terminal',
    name: t.apps.terminal.name,
    description: t.apps.terminal.description,
    icon: asset('icons/apps/terminal.png'),
    keywords: ['terminal', 'konsole', 'shell', 'kommandozeile', 'befehle'],
    defaultSize: { w: 720, h: 440 },
    minSize: { w: 420, h: 240 },
    singleInstance: false,
    showInLauncher: true,
  },
  settings: {
    id: 'settings',
    name: t.apps.settings.name,
    description: t.apps.settings.description,
    icon: asset('icons/apps/settings.png'),
    keywords: ['einstellungen', 'settings', 'hintergrund', 'dock', 'akzent', 'system', 'speicher'],
    defaultSize: { w: 860, h: 600 },
    minSize: { w: 560, h: 400 },
    singleInstance: true,
    showInLauncher: true,
  },
  player: {
    id: 'player',
    name: t.apps.player.name,
    description: t.apps.player.description,
    icon: asset('icons/apps/web.png'),
    keywords: [],
    defaultSize: { w: 1024, h: 640 },
    minSize: { w: 480, h: 320 },
    singleInstance: true,
    showInLauncher: false,
  },
};
