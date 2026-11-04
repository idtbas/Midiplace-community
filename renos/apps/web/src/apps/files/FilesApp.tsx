import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  FolderOpen,
  FolderPlus,
  HardDrive,
  LayoutGrid,
  List,
  PackageOpen,
  PanelRight,
  Pencil,
  RotateCcw,
  Scissors,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { t } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatBytes, formatDateTime } from '@/lib/format';
import { db, type FsNode } from '@/persistence/db';
import {
  FsError,
  HOME_ID,
  SPECIAL_FOLDERS,
  copyNodes,
  createFolder,
  deleteNodes,
  emptyTrash,
  getAncestors,
  isSpecialFolder,
  isZipFile,
  kindLabel,
  listChildren,
  listTrash,
  moveNodes,
  renameNode,
  restoreNodes,
  searchNodes,
  trashNodes,
  uniqueName,
  usage,
} from '@/persistence/fs';
import { useLiveQuery } from '@/persistence/useLiveQuery';
import { openApp } from '@/system/actions';
import type { AppProps } from '@/system/apps';
import { showContextMenu, type MenuEntry } from '@/system/contextMenu';
import { confirmDialog } from '@/system/dialogs';
import { notify } from '@/system/notifications';
import { useSettings } from '@/system/settings';
import { useWindows } from '@/system/windows';
import { IconButton } from '@/ui/Button';
import { EmptyState } from '@/ui/Feedback';
import { TextInput } from '@/ui/Form';
import { FileIcon } from './FileIcon';
import { FilePreview } from './FilePreview';
import { exportNodes, importFiles, pickAndImport } from './fileOps';
import { asset } from '@/config';

type Location = string; // Ordner-ID oder 'trash'
type SortKey = 'name' | 'size' | 'modifiedAt' | 'kind';

const DRAG_TYPE = 'application/x-renos-nodes';
let clipboard: { mode: 'cut' | 'copy'; ids: string[] } | null = null;

const PLACE_ICONS: Record<string, string> = { home: 'home' };

function sortNodes(nodes: FsNode[], key: SortKey, dir: 1 | -1): FsNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    let cmp = 0;
    if (key === 'size') cmp = a.size - b.size;
    else if (key === 'modifiedAt') cmp = a.modifiedAt - b.modifiedAt;
    else if (key === 'kind') cmp = kindLabel(a).localeCompare(kindLabel(b), 'de');
    if (cmp === 0) cmp = a.name.localeCompare(b.name, 'de', { numeric: true });
    return cmp * dir;
  });
}

export default function FilesApp({ windowId, payload }: AppProps) {
  const view = useSettings((s) => s.filesView);
  const setSetting = useSettings((s) => s.set);
  const initial = typeof payload?.location === 'string' ? payload.location : HOME_ID;
  const [location, setLocation] = useState<Location>(initial);
  const [back, setBack] = useState<Location[]>([]);
  const [forward, setForward] = useState<Location[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [everywhere, setEverywhere] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [showPreview, setShowPreview] = useState(true);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const isTrash = location === 'trash';

  // Navigation von außen (z. B. Papierkorb im Dock).
  const nonce = payload?.nonce;
  useEffect(() => {
    if (nonce && typeof payload?.location === 'string') navigate(payload.location);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const nodes = useLiveQuery(
    async () => {
      if (query.trim() && everywhere) return searchNodes(query);
      if (isTrash) return listTrash();
      const folder = await db.nodes.get(location);
      if (!folder || folder.trashed) return null;
      return listChildren(location);
    },
    [location, query, everywhere, isTrash],
    [] as FsNode[] | null,
  );
  const ancestors = useLiveQuery(() => (isTrash ? Promise.resolve([]) : getAncestors(location)), [location, isTrash], [] as FsNode[]);
  const stats = useLiveQuery(() => usage(), [], { files: 0, folders: 0, bytes: 0 });
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  useEffect(() => {
    void navigator.storage?.estimate?.().then((e) => e.quota && setEstimate({ usage: e.usage ?? 0, quota: e.quota }));
  }, [stats.bytes]);

  // Ordner existiert nicht mehr (gelöscht) → zum persönlichen Ordner.
  useEffect(() => {
    if (nodes === null) setLocation(HOME_ID);
  }, [nodes]);

  const visible = useMemo(() => {
    const list = nodes ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q && !everywhere ? list.filter((n) => n.name.toLowerCase().includes(q)) : list;
    return sortNodes(filtered, sort.key, sort.dir);
  }, [nodes, query, everywhere, sort]);

  const selectedNodes = visible.filter((n) => selection.includes(n.id));
  const primary = selectedNodes.length === 1 ? selectedNodes[0]! : null;

  useEffect(() => {
    const name = isTrash ? t.files.trash : (ancestors[ancestors.length - 1]?.name ?? t.files.home);
    useWindows.getState().setTitle(windowId, `${name} – Files`);
    if (!isTrash || location === 'trash') useWindows.getState().setPayload(windowId, { location });
  }, [windowId, ancestors, isTrash, location]);

  const navigate = useCallback(
    (target: Location) => {
      if (target === location) return;
      setBack((b) => [...b, location].slice(-50));
      setForward([]);
      setLocation(target);
      setSelection([]);
      setRenaming(null);
      setQuery('');
      setEverywhere(false);
    },
    [location],
  );

  const goBack = () => {
    const prev = back[back.length - 1];
    if (!prev) return;
    setBack(back.slice(0, -1));
    setForward([location, ...forward]);
    setLocation(prev);
    setSelection([]);
  };
  const goForward = () => {
    const next = forward[0];
    if (!next) return;
    setForward(forward.slice(1));
    setBack([...back, location]);
    setLocation(next);
    setSelection([]);
  };
  const goUp = () => {
    const parent = ancestors[ancestors.length - 2];
    if (parent) navigate(parent.id);
  };

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      notify({ kind: 'error', title: error instanceof FsError ? error.message : t.errors.generic });
    }
  };

  const open = (node: FsNode) => {
    if (isTrash) return;
    if (node.kind === 'folder') navigate(node.id);
    else {
      setSelection([node.id]);
      setShowPreview(true);
    }
  };

  const newFolder = () =>
    run(async () => {
      if (isTrash) return;
      const name = await uniqueName(location, t.files.newFolderName);
      const node = await createFolder(location, name);
      setSelection([node.id]);
      setRenaming(node.id);
    });

  const trash = (ids: string[]) =>
    run(async () => {
      const removable = ids.filter((id) => !isSpecialFolder(id));
      if (removable.length === 0) return;
      await trashNodes(removable);
      setSelection([]);
      notify({
        kind: 'info',
        title: t.files.moveToTrash,
        message: t.files.items(removable.length),
        action: { label: t.notes.undo, run: () => void restoreNodes(removable) },
      });
    });

  const deleteForever = (ids: string[]) =>
    run(async () => {
      const ok = await confirmDialog({ title: t.files.deleteForever, message: t.files.confirmDelete(ids.length), confirmLabel: t.system.delete, destructive: true });
      if (!ok) return;
      await deleteNodes(ids);
      setSelection([]);
    });

  const doEmptyTrash = () =>
    run(async () => {
      const ok = await confirmDialog({ title: t.files.emptyTrash, message: t.files.confirmEmptyTrash, confirmLabel: t.files.emptyTrash, destructive: true });
      if (ok) await emptyTrash();
    });

  const commitRename = (id: string, name: string) =>
    run(async () => {
      setRenaming(null);
      const node = visible.find((n) => n.id === id);
      if (!node || node.name === name.trim()) return;
      await renameNode(id, name);
    });

  const paste = () =>
    run(async () => {
      if (!clipboard || isTrash) return;
      if (clipboard.mode === 'cut') {
        await moveNodes(clipboard.ids, location);
        clipboard = null;
      } else {
        await copyNodes(clipboard.ids, location);
      }
    });

  const sendToInstaller = (node: FsNode) => openApp('installer', { fileNodeId: node.id, nonce: Date.now() });

  // ----- Auswahl -------------------------------------------------------------
  const onItemClick = (e: React.MouseEvent, node: FsNode) => {
    if (e.shiftKey && anchor) {
      const a = visible.findIndex((n) => n.id === anchor);
      const b = visible.findIndex((n) => n.id === node.id);
      const [from, to] = a < b ? [a, b] : [b, a];
      setSelection(visible.slice(from, to + 1).map((n) => n.id));
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      setSelection((s) => (s.includes(node.id) ? s.filter((id) => id !== node.id) : [...s, node.id]));
      setAnchor(node.id);
      return;
    }
    setSelection([node.id]);
    setAnchor(node.id);
  };

  const itemMenu = (e: React.MouseEvent, node: FsNode) => {
    const ids = selection.includes(node.id) ? selection : [node.id];
    if (!selection.includes(node.id)) setSelection([node.id]);
    const special = ids.some(isSpecialFolder);
    const items: MenuEntry[] = isTrash
      ? [
          { id: 'restore', label: t.files.restore, icon: RotateCcw, run: () => void run(() => restoreNodes(ids)) },
          'separator',
          { id: 'delete', label: t.files.deleteForever, icon: Trash2, danger: true, run: () => void deleteForever(ids) },
        ]
      : [
          { id: 'open', label: t.system.open, icon: FolderOpen, run: () => open(node) },
          ...(isZipFile(node) && ids.length === 1 ? [{ id: 'install', label: t.files.openInInstaller, icon: PackageOpen, run: () => sendToInstaller(node) }] : []),
          'separator',
          { id: 'rename', label: t.system.rename, icon: Pencil, shortcut: '⌥R', disabled: ids.length !== 1 || special, run: () => setRenaming(node.id) },
          { id: 'cut', label: t.files.cut, icon: Scissors, shortcut: '⌘X', disabled: special, run: () => (clipboard = { mode: 'cut', ids }) },
          { id: 'copy', label: t.files.copy, icon: Copy, shortcut: '⌘C', run: () => (clipboard = { mode: 'copy', ids }) },
          { id: 'export', label: t.files.export, icon: Download, run: () => void run(() => exportNodes(ids)) },
          'separator',
          { id: 'trash', label: t.files.moveToTrash, icon: Trash2, danger: true, shortcut: '⌘⌫', disabled: special, run: () => void trash(ids) },
        ];
    showContextMenu(e, items);
  };

  const backgroundMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-node-id]')) return;
    setSelection([]);
    const items: MenuEntry[] = isTrash
      ? [{ id: 'empty', label: t.files.emptyTrash, icon: Trash2, danger: true, disabled: visible.length === 0, run: () => void doEmptyTrash() }]
      : [
          { id: 'newfolder', label: t.files.newFolder, icon: FolderPlus, shortcut: '⌘⇧N', run: () => void newFolder() },
          { id: 'import', label: `${t.files.import} …`, icon: Upload, run: () => void pickAndImport(location) },
          { id: 'paste', label: t.files.paste, icon: ClipboardPaste, shortcut: '⌘V', disabled: !clipboard, run: () => void paste() },
          'separator',
          { id: 'list', label: t.files.listView, icon: List, checked: view === 'list', run: () => setSetting('filesView', 'list') },
          { id: 'grid', label: t.files.gridView, icon: LayoutGrid, checked: view === 'grid', run: () => setSetting('filesView', 'grid') },
        ];
    showContextMenu(e, items);
  };

  // ----- Tastatur --------------------------------------------------------------
  const columns = () => {
    if (view !== 'grid') return 1;
    const grid = rootRef.current?.querySelector('[data-grid]');
    return grid ? Math.max(1, Math.floor(grid.clientWidth / 112)) : 1;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') {
      if (e.key === 'Escape' && e.target === searchRef.current) {
        setQuery('');
        rootRef.current?.focus();
      }
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    const index = visible.findIndex((n) => n.id === (selection[selection.length - 1] ?? ''));
    const move = (delta: number) => {
      e.preventDefault();
      const next = visible[Math.min(Math.max(index < 0 ? 0 : index + delta, 0), visible.length - 1)];
      if (next) {
        setSelection(e.shiftKey ? [...new Set([...selection, next.id])] : [next.id]);
        setAnchor(next.id);
        rootRef.current?.querySelector(`[data-node-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    if (mod && e.key === 'ArrowUp') {
      e.preventDefault();
      goUp();
    } else if (mod && e.key === 'ArrowDown' && primary) {
      e.preventDefault();
      open(primary);
    } else if (e.key === 'ArrowDown') move(columns());
    else if (e.key === 'ArrowUp') move(-columns());
    else if (e.key === 'ArrowRight' && view === 'grid') move(1);
    else if (e.key === 'ArrowLeft' && view === 'grid') move(-1);
    else if (e.key === 'Enter' && primary) {
      e.preventDefault();
      if (!isTrash) open(primary);
    } else if ((e.key === 'F2' || (e.altKey && e.code === 'KeyR')) && primary && !isTrash && !isSpecialFolder(primary.id)) {
      e.preventDefault();
      setRenaming(primary.id);
    } else if ((e.key === 'Delete' || (mod && e.key === 'Backspace')) && selection.length) {
      e.preventDefault();
      if (isTrash) void deleteForever(selection);
      else void trash(selection);
    } else if (mod && e.shiftKey && e.code === 'KeyN') {
      e.preventDefault();
      void newFolder();
    } else if (mod && e.code === 'KeyA') {
      e.preventDefault();
      setSelection(visible.map((n) => n.id));
    } else if (mod && e.code === 'KeyC' && selection.length) {
      clipboard = { mode: 'copy', ids: selection };
    } else if (mod && e.code === 'KeyX' && selection.length && !isTrash) {
      clipboard = { mode: 'cut', ids: selection.filter((id) => !isSpecialFolder(id)) };
    } else if (mod && e.code === 'KeyV') {
      e.preventDefault();
      void paste();
    } else if (mod && e.code === 'KeyF') {
      e.preventDefault();
      searchRef.current?.focus();
    } else if (mod && e.code === 'BracketLeft') {
      e.preventDefault();
      goBack();
    } else if (mod && e.code === 'BracketRight') {
      e.preventDefault();
      goForward();
    } else if (e.key === 'Escape') {
      setSelection([]);
    }
  };

  // ----- Drag & Drop -----------------------------------------------------------
  const onDragStart = (e: React.DragEvent, node: FsNode) => {
    if (isTrash) return;
    const ids = selection.includes(node.id) ? selection : [node.id];
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
  };
  const acceptsDrop = (e: React.DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE) || e.dataTransfer.types.includes('Files');
  const onDropTo = (targetId: string) => async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    if (targetId === 'trash') {
      const raw = e.dataTransfer.getData(DRAG_TYPE);
      if (raw) await trash(JSON.parse(raw) as string[]);
      return;
    }
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (raw) {
      const ids = (JSON.parse(raw) as string[]).filter((id) => id !== targetId);
      await run(() => moveNodes(ids, targetId));
    } else if (e.dataTransfer.files.length) {
      await importFiles([...e.dataTransfer.files], targetId);
    }
  };
  const dropProps = (targetId: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!acceptsDrop(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(targetId);
    },
    onDragLeave: () => setDropTarget((d) => (d === targetId ? null : d)),
    onDrop: (e: React.DragEvent) => void onDropTo(targetId)(e),
  });

  const places = [{ id: HOME_ID, name: t.files.home }, ...SPECIAL_FOLDERS.map((f) => ({ id: f.id, name: f.name }))];
  const sortHeader = (key: SortKey, label: string, className: string) => (
    <button
      type="button"
      className={cn('flex items-center gap-1 truncate text-left hover:text-fg', className, sort.key === key && 'text-fg')}
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}
    >
      {label}
      {sort.key === key ? <span aria-hidden>{sort.dir === 1 ? '↑' : '↓'}</span> : null}
    </button>
  );

  const renderName = (node: FsNode) =>
    renaming === node.id ? (
      <RenameInput initial={node.name} onDone={(name) => (name === null ? setRenaming(null) : void commitRename(node.id, name))} />
    ) : (
      <span className="truncate">{node.name}</span>
    );

  return (
    <div ref={rootRef} className="flex h-full flex-col outline-none" tabIndex={-1} onKeyDown={onKeyDown} data-testid="files-app">
      {/* Werkzeugleiste */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line-soft bg-surface-1 px-2">
        <IconButton icon={ArrowLeft} label={`${t.system.back} (⌘[)`} size="sm" onClick={goBack} disabled={back.length === 0} />
        <IconButton icon={ArrowRight} label="Vorwärts (⌘])" size="sm" onClick={goForward} disabled={forward.length === 0} />
        <IconButton icon={ArrowUp} label="Übergeordneter Ordner (⌘↑)" size="sm" onClick={goUp} disabled={isTrash || ancestors.length < 2} />
        <nav aria-label="Pfad" className="ml-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-base">
          {isTrash ? (
            <span className="px-1.5 font-medium">{t.files.trash}</span>
          ) : (
            ancestors.map((node, i) => (
              <span key={node.id} className="flex min-w-0 items-center gap-0.5">
                {i > 0 ? <ChevronRight size={14} className="shrink-0 text-fg-faint" /> : null}
                <button
                  type="button"
                  className={cn('truncate rounded-sm px-1.5 py-0.5 hover:bg-surface-3', i === ancestors.length - 1 ? 'font-medium text-fg' : 'text-fg-muted', dropTarget === node.id && 'bg-accent-soft')}
                  onClick={() => navigate(node.id)}
                  {...dropProps(node.id)}
                >
                  {node.name}
                </button>
              </span>
            ))
          )}
        </nav>
        <div className="relative w-[200px]">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <TextInput ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.files.searchPlaceholder} aria-label={t.files.searchPlaceholder} className="h-7 pl-8 text-sm" />
        </div>
        <IconButton icon={view === 'list' ? LayoutGrid : List} label={view === 'list' ? t.files.gridView : t.files.listView} size="sm" onClick={() => setSetting('filesView', view === 'list' ? 'grid' : 'list')} />
        {isTrash ? (
          <IconButton icon={Trash2} label={t.files.emptyTrash} size="sm" onClick={() => void doEmptyTrash()} disabled={visible.length === 0} />
        ) : (
          <>
            <IconButton icon={FolderPlus} label={`${t.files.newFolder} (⌘⇧N)`} size="sm" onClick={() => void newFolder()} />
            <IconButton icon={Upload} label={t.files.import} size="sm" onClick={() => void pickAndImport(location)} />
          </>
        )}
        <IconButton icon={PanelRight} label={t.files.preview} size="sm" active={showPreview} onClick={() => setShowPreview(!showPreview)} />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Seitenleiste */}
        <aside className="flex w-[196px] shrink-0 flex-col border-r border-line-soft bg-surface-0 py-2">
          <div className="px-4 pb-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{t.files.places}</div>
          {places.map((place) => (
            <button
              key={place.id}
              type="button"
              onClick={() => navigate(place.id)}
              className={cn(
                'mx-2 flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-base',
                location === place.id ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
                dropTarget === place.id && 'ring-1 ring-accent',
              )}
              {...dropProps(place.id)}
              data-place={PLACE_ICONS[place.id] ?? place.id}
            >
              <img src={asset('icons/apps/files.png')} alt="" className="h-[18px] w-[18px]" draggable={false} />
              <span className="truncate">{place.name}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => navigate('trash')}
            className={cn(
              'mx-2 mt-1 flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-base',
              isTrash ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
              dropTarget === 'trash' && 'ring-1 ring-accent',
            )}
            {...dropProps('trash')}
          >
            <img src={asset('icons/apps/trash.png')} alt="" className="h-[18px] w-[18px]" draggable={false} />
            <span>{t.files.trash}</span>
          </button>
          <div className="mt-auto px-4 pt-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              <HardDrive size={12} /> {t.files.storage}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-accent" style={{ width: estimate ? `${Math.min(100, (estimate.usage / estimate.quota) * 100)}%` : '0%' }} />
            </div>
            <p className="mt-1.5 text-xs text-fg-subtle">
              {formatBytes(stats.bytes)} in {t.files.items(stats.files)}
              {estimate ? ` · ${formatBytes(estimate.quota - estimate.usage)} frei` : ''}
            </p>
          </div>
        </aside>

        {/* Inhalt */}
        <section
          className={cn('relative flex min-w-0 flex-1 flex-col', dropTarget === location && 'bg-accent-softer')}
          onContextMenu={backgroundMenu}
          onPointerDown={(e) => {
            if (!(e.target as HTMLElement).closest('[data-node-id]')) setSelection([]);
          }}
          {...(isTrash ? {} : dropProps(location))}
        >
          {query.trim() ? (
            <div className="flex items-center gap-2 border-b border-line-faint px-3 py-1.5 text-sm text-fg-muted">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} className="accent-[var(--accent)]" />
                {t.files.searchEverywhere}
              </label>
            </div>
          ) : null}
          {visible.length === 0 ? (
            <EmptyState icon={isTrash ? Trash2 : query ? Search : FolderOpen} title={isTrash ? t.files.emptyTrashState : query ? t.files.noResults : t.files.emptyFolder}>
              {!isTrash && !query ? t.files.emptyFolderHint : null}
            </EmptyState>
          ) : view === 'list' ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_96px_150px_120px] gap-3 border-b border-line-faint px-4 py-1.5 text-xs font-medium text-fg-subtle">
                {sortHeader('name', t.files.columns.name, '')}
                {sortHeader('size', t.files.columns.size, 'justify-end')}
                {sortHeader('modifiedAt', isTrash ? t.files.trashedOn : t.files.columns.modified, '')}
                {sortHeader('kind', t.files.columns.kind, '')}
              </div>
              <div className="scroll-area min-h-0 flex-1 px-1.5 py-1" role="listbox" aria-multiselectable aria-label="Dateien">
                {visible.map((node) => (
                  <div
                    key={node.id}
                    data-node-id={node.id}
                    role="option"
                    aria-selected={selection.includes(node.id)}
                    draggable={!isTrash && renaming !== node.id}
                    onDragStart={(e) => onDragStart(e, node)}
                    onClick={(e) => onItemClick(e, node)}
                    onDoubleClick={() => open(node)}
                    onContextMenu={(e) => itemMenu(e, node)}
                    {...(node.kind === 'folder' && !isTrash ? dropProps(node.id) : {})}
                    className={cn(
                      'grid h-9 grid-cols-[minmax(0,1fr)_96px_150px_120px] items-center gap-3 rounded-md px-2.5 text-base',
                      selection.includes(node.id) ? 'bg-accent-soft' : 'hover:bg-surface-2/70',
                      dropTarget === node.id && 'ring-1 ring-accent',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <FileIcon node={node} size={20} />
                      {renderName(node)}
                    </span>
                    <span className="tabular truncate text-right text-sm text-fg-muted">{node.kind === 'folder' ? '–' : formatBytes(node.size)}</span>
                    <span className="tabular truncate text-sm text-fg-muted">{formatDateTime(isTrash ? node.trashedAt : node.modifiedAt)}</span>
                    <span className="truncate text-sm text-fg-muted">{kindLabel(node)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="scroll-area min-h-0 flex-1 p-3">
              <div data-grid className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2" role="listbox" aria-multiselectable aria-label="Dateien">
                {visible.map((node) => (
                  <div
                    key={node.id}
                    data-node-id={node.id}
                    role="option"
                    aria-selected={selection.includes(node.id)}
                    draggable={!isTrash && renaming !== node.id}
                    onDragStart={(e) => onDragStart(e, node)}
                    onClick={(e) => onItemClick(e, node)}
                    onDoubleClick={() => open(node)}
                    onContextMenu={(e) => itemMenu(e, node)}
                    {...(node.kind === 'folder' && !isTrash ? dropProps(node.id) : {})}
                    className={cn(
                      'flex flex-col items-center gap-1.5 rounded-lg px-2 py-3 text-center text-sm',
                      selection.includes(node.id) ? 'bg-accent-soft' : 'hover:bg-surface-2/70',
                      dropTarget === node.id && 'ring-1 ring-accent',
                    )}
                  >
                    <FileIcon node={node} size={48} />
                    <span className="line-clamp-2 w-full break-words">{renaming === node.id ? renderName(node) : node.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-line-faint px-3 text-xs text-fg-subtle">
            <span className="shrink-0 whitespace-nowrap">{selection.length ? t.files.selected(selection.length) : t.files.items(visible.length)}</span>
            <span className="truncate" title={t.files.localNote}>
              {t.files.localNote}
            </span>
          </footer>
        </section>

        {showPreview && !isTrash ? (
          <aside className="w-[240px] shrink-0 border-l border-line-soft bg-surface-1">
            <FilePreview
              node={primary}
              onExport={() => primary && void run(() => exportNodes([primary.id]))}
              onInstall={() => primary && sendToInstaller(primary)}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const dot = initial.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      ref={ref}
      value={value}
      aria-label={t.system.rename}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(value);
        else if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(value)}
      className="h-6 w-full min-w-0 rounded-xs border border-accent bg-surface-0 px-1.5 text-base text-fg focus:outline-none"
    />
  );
}
