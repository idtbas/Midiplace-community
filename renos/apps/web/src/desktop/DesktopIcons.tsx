import { useState } from 'react';
import { ExternalLink, FolderOpen, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { FileIcon } from '@/apps/files/FileIcon';
import { importFiles } from '@/apps/files/fileOps';
import { db, type FsNode } from '@/persistence/db';
import { FsError, renameNode, trashNodes, validateName } from '@/persistence/fs';
import { useLiveQuery } from '@/persistence/useLiveQuery';
import { openFilesAt } from '@/system/actions';
import { APP_META } from '@/system/appMeta';
import { showContextMenu, type MenuEntry } from '@/system/contextMenu';
import { promptDialog } from '@/system/dialogs';
import { openFileWith, openersFor } from '@/system/fileTypes';
import { notify } from '@/system/notifications';
import { useSettings } from '@/system/settings';
import { useWindows } from '@/system/windows';

export const DESKTOP_FOLDER = 'desktop';

/** Öffnet ein Element vom Schreibtisch: Ordner in Files, Dateien in ihrer Standard-App. */
export function openDesktopNode(node: FsNode): void {
  if (node.kind === 'folder') openFilesAt(node.id);
  else if (!openFileWith(node)) openFilesAt(DESKTOP_FOLDER);
}

/**
 * Symbole auf dem Schreibtisch: der Inhalt des Ordners „Schreibtisch“ (in Files unter Orte).
 * Doppelklick/Doppeltippen öffnet, Kontextmenü wie in Files, Dateien lassen sich hineinziehen.
 */
export function DesktopIcons() {
  const enabled = useSettings((s) => s.desktopIcons);
  const nodes = useLiveQuery(
    () =>
      db.nodes
        .where('[parentId+trashed]')
        .equals([DESKTOP_FOLDER, 0])
        .toArray()
        .then((list) => list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'de', { numeric: true }) : a.kind === 'folder' ? -1 : 1))),
    [],
    [] as FsNode[],
  );
  const [selected, setSelected] = useState<string | null>(null);
  if (!enabled) return null;

  const rename = async (node: FsNode) => {
    const name = await promptDialog({ title: 'Umbenennen', label: 'Name', defaultValue: node.name, confirmLabel: 'Umbenennen', validate: validateName, selectBaseName: node.kind === 'file' });
    if (!name || name === node.name) return;
    try {
      await renameNode(node.id, name);
    } catch (error) {
      notify({ kind: 'error', title: error instanceof FsError ? error.message : 'Umbenennen fehlgeschlagen' });
    }
  };

  const menu = (e: React.MouseEvent, node: FsNode) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(node.id);
    const items: MenuEntry[] = [
      { id: 'open', label: 'Öffnen', icon: FolderOpen, run: () => openDesktopNode(node) },
      ...openersFor(node)
        .filter((appId) => appId !== 'installer')
        .map((appId) => ({ id: `open-${appId}`, label: `Öffnen mit ${APP_META[appId].name}`, icon: ExternalLink, run: () => void openFileWith(node, appId) })),
      ...(node.kind === 'file' && /\.zip$/i.test(node.name) ? [{ id: 'install', label: 'Mit Installer öffnen', icon: ExternalLink, run: () => void openFileWith(node, 'installer') }] : []),
      'separator',
      { id: 'rename', label: 'Umbenennen …', icon: Pencil, run: () => void rename(node) },
      { id: 'reveal', label: 'In Files zeigen', icon: FolderOpen, run: () => openFilesAt(DESKTOP_FOLDER) },
      'separator',
      { id: 'trash', label: 'In den Papierkorb', icon: Trash2, danger: true, run: () => void trashNodes([node.id]) },
    ];
    showContextMenu(e, items);
  };

  return (
    <div
      className="pointer-events-none absolute inset-0 z-0 flex flex-col flex-wrap content-start gap-1 p-3"
      style={{ paddingTop: 'calc(var(--topbar-h) + var(--safe-top) + 12px)', paddingBottom: 96 }}
      data-testid="desktop-icons"
    >
      {nodes.map((node) => (
        <button
          key={node.id}
          type="button"
          className={cn(
            'pointer-events-auto flex w-[92px] flex-col items-center gap-1 rounded-lg p-1.5 text-center outline-none focus-visible:ring-2 focus-visible:ring-accent',
            selected === node.id ? 'bg-white/20' : 'hover:bg-white/10',
          )}
          onPointerDown={(e) => {
            e.stopPropagation();
            useWindows.getState().blur();
            setSelected(node.id);
          }}
          onDoubleClick={() => openDesktopNode(node)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') openDesktopNode(node);
          }}
          onContextMenu={(e) => menu(e, node)}
          onBlur={() => setSelected((s) => (s === node.id ? null : s))}
          title={node.name}
          data-testid="desktop-icon"
          data-name={node.name}
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-black/25 text-white backdrop-blur-sm">
            <FileIcon node={node} size={40} />
          </span>
          <span className="line-clamp-2 w-full break-words text-xs font-medium text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.8)]">{node.name}</span>
        </button>
      ))}
    </div>
  );
}

/** Dateien auf den Schreibtisch ziehen (aus der iPad-Dateien-App). */
export async function dropOnDesktop(files: File[]): Promise<void> {
  if (files.length) await importFiles(files, DESKTOP_FOLDER);
}
