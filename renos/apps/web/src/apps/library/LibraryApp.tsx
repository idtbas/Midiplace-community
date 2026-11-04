import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Gamepad2, ImagePlus, Info, LibraryBig, LogOut, Pencil, Play, Plus, RefreshCw, Search, ServerOff, Trash2, X } from 'lucide-react';
import type { Game } from '@renos/shared';
import { t } from '@/i18n';
import { cn } from '@/lib/cn';
import { pickFiles } from '@/lib/download';
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format';
import { api, describeError, errorMessage } from '@/api/client';
import { canReadLibrary, useServer } from '@/api/server';
import { launchGame, openApp } from '@/system/actions';
import type { AppProps } from '@/system/apps';
import { showContextMenu, type MenuEntry } from '@/system/contextMenu';
import { confirmDialog, promptDialog } from '@/system/dialogs';
import { notify } from '@/system/notifications';
import { useSettings } from '@/system/settings';
import { Button, IconButton } from '@/ui/Button';
import { EmptyState, Notice, Spinner } from '@/ui/Feedback';
import { Segmented, TextInput } from '@/ui/Form';
import { LoginForm } from '@/ui/LoginForm';
import { GameCover } from './GameCover';

type Filter = 'all' | 'recent';
type Sort = 'name' | 'recent' | 'installed';

export default function LibraryApp(_props: AppProps) {
  const server = useServer();
  const readable = canReadLibrary(server);
  const isOwner = server.session?.authenticated ?? false;
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('name');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (readable && server.status !== 'offline') {
      void server.loadGames();
      void server.loadStorage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readable, server.status]);

  const games = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = server.games.filter((g) => !q || g.title.toLowerCase().includes(q) || g.sourceFileName.toLowerCase().includes(q));
    if (filter === 'recent') list = list.filter((g) => g.lastPlayedAt);
    const by = filter === 'recent' ? 'recent' : sort;
    return [...list].sort((a, b) => {
      if (by === 'recent') return (b.lastPlayedAt ?? '').localeCompare(a.lastPlayedAt ?? '') || a.title.localeCompare(b.title, 'de');
      if (by === 'installed') return b.installedAt.localeCompare(a.installedAt);
      return a.title.localeCompare(b.title, 'de', { numeric: true });
    });
  }, [server.games, query, filter, sort]);

  const selected = server.games.find((g) => g.id === selectedId) ?? null;

  const changeCover = async (game: Game) => {
    const [file] = await pickFiles({ accept: 'image/png,image/jpeg,image/webp' });
    if (!file) return;
    const maxBytes = server.health?.limits.maxCoverBytes ?? 8 * 1024 * 1024;
    if (file.size > maxBytes || !/^image\/(png|jpeg|webp)$/.test(file.type)) {
      notify({ kind: 'error', title: t.errors.api.image_invalid });
      return;
    }
    try {
      const { game: updated } = await api.setCover(game.id, file);
      server.upsertGame(updated);
      notify({ kind: 'success', title: t.library.coverUpdated, transient: true });
    } catch (error) {
      notify({ kind: 'error', title: errorMessage(error) });
    }
  };

  const removeCover = async (game: Game) => {
    try {
      const { game: updated } = await api.removeCover(game.id);
      server.upsertGame(updated);
    } catch (error) {
      notify({ kind: 'error', title: errorMessage(error) });
    }
  };

  const rename = async (game: Game) => {
    const title = await promptDialog({
      title: t.library.renameGame.replace(' …', ''),
      label: t.library.renamePrompt,
      defaultValue: game.title,
      confirmLabel: t.system.save,
      validate: (v) => (v.trim() ? null : t.files.nameInvalid.empty),
    });
    if (!title || title === game.title) return;
    try {
      const { game: updated } = await api.renameGame(game.id, title);
      server.upsertGame(updated);
      notify({ kind: 'success', title: t.library.renamed, transient: true });
    } catch (error) {
      notify({ kind: 'error', title: errorMessage(error) });
    }
  };

  const remove = async (game: Game) => {
    const ok = await confirmDialog({
      title: t.library.removeConfirmTitle(game.title),
      message: t.library.removeConfirm,
      confirmLabel: t.library.removeGame.replace(' …', ''),
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteGame(game.id);
      server.removeGame(game.id);
      if (selectedId === game.id) setSelectedId(null);
      void server.loadStorage();
      notify({ kind: 'success', title: t.library.removed(game.title) });
    } catch (error) {
      notify({ kind: 'error', title: errorMessage(error) });
    }
  };

  const menuFor = (e: React.MouseEvent, game: Game) => {
    setSelectedId(game.id);
    const items: MenuEntry[] = [
      { id: 'play', label: t.library.play, icon: Play, run: () => void launchGame(game.id) },
      { id: 'details', label: t.library.details, icon: Info, run: () => setSelectedId(game.id) },
      'separator',
      { id: 'cover', label: t.library.changeCover, icon: ImagePlus, disabled: !isOwner, run: () => void changeCover(game) },
      { id: 'nocover', label: t.library.removeCover, icon: X, disabled: !isOwner || !game.coverUrl, run: () => void removeCover(game) },
      { id: 'rename', label: t.library.renameGame, icon: Pencil, disabled: !isOwner, run: () => void rename(game) },
      'separator',
      { id: 'remove', label: t.library.removeGame, icon: Trash2, danger: true, disabled: !isOwner, run: () => void remove(game) },
    ];
    showContextMenu(e, items);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.code === 'KeyF') {
      e.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const index = games.findIndex((g) => g.id === selectedId);
    const grid = gridRef.current;
    const cols = grid ? Math.max(1, Math.round(grid.clientWidth / 216)) : 1;
    const move = (delta: number) => {
      e.preventDefault();
      const next = games[Math.min(Math.max(index < 0 ? 0 : index + delta, 0), games.length - 1)];
      if (next) {
        setSelectedId(next.id);
        grid?.querySelector(`[data-game-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    if (e.key === 'ArrowRight') move(1);
    else if (e.key === 'ArrowLeft') move(-1);
    else if (e.key === 'ArrowDown') move(cols);
    else if (e.key === 'ArrowUp') move(-cols);
    else if (e.key === 'Enter' && selected) {
      e.preventDefault();
      void launchGame(selected.id);
    } else if ((e.key === 'Delete' || (mod && e.key === 'Backspace')) && selected && isOwner) {
      e.preventDefault();
      void remove(selected);
    } else if (e.key === 'Escape') setSelectedId(null);
  };

  // ----- Zustände ohne Spieleliste ---------------------------------------------
  let body: React.ReactNode;
  if (server.status === 'offline') {
    body = (
      <EmptyState
        icon={ServerOff}
        title={t.library.offlineTitle}
        actions={
          <Button icon={RefreshCw} onClick={() => void server.refreshHealth().then(async (ok) => { if (ok) await server.refreshSession(); })}>
            {t.system.retry}
          </Button>
        }
      >
        {t.library.offlineText}
      </EmptyState>
    );
  } else if (server.status === 'unknown' || !server.session) {
    body = (
      <div className="flex h-full items-center justify-center">
        <Spinner size={22} />
      </div>
    );
  } else if (!readable) {
    body = (
      <div className="flex h-full items-center justify-center p-8">
        <LoginForm readOnly />
      </div>
    );
  } else if (server.gamesState === 'loading' && server.games.length === 0) {
    body = (
      <div className="flex h-full items-center justify-center">
        <Spinner size={22} />
      </div>
    );
  } else if (server.gamesState === 'error' && server.games.length === 0) {
    body = (
      <EmptyState icon={ServerOff} title={t.errors.generic} actions={<Button onClick={() => void server.loadGames()}>{t.system.retry}</Button>}>
        {server.gamesError ? describeError(server.gamesError) : null}
      </EmptyState>
    );
  } else if (server.games.length === 0) {
    body = <LibraryEmpty />;
  } else {
    body = (
      <div className="flex h-full min-h-0">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line-soft px-4">
            <div className="relative w-[260px]">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
              <TextInput ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.library.searchPlaceholder} aria-label={t.library.searchPlaceholder} className="pl-8" />
            </div>
            <div className="flex-1" />
            {filter === 'all' ? (
              <Segmented
                label={t.library.sort}
                size="sm"
                value={sort}
                onChange={setSort}
                options={[
                  { value: 'name', label: t.library.sortName },
                  { value: 'recent', label: t.library.sortRecent },
                  { value: 'installed', label: t.library.sortInstalled },
                ]}
              />
            ) : null}
          </div>
          <div className="scroll-area min-h-0 flex-1 p-4" onPointerDown={(e) => e.target === e.currentTarget && setSelectedId(null)}>
            {games.length === 0 ? (
              <EmptyState icon={Search} title={t.library.noResults} />
            ) : (
              <div ref={gridRef} className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4" role="listbox" aria-label={t.library.all}>
                {games.map((game) => (
                  <button
                    key={game.id}
                    type="button"
                    role="option"
                    aria-selected={selectedId === game.id}
                    data-game-id={game.id}
                    onClick={() => setSelectedId(game.id)}
                    onDoubleClick={() => void launchGame(game.id)}
                    onContextMenu={(e) => menuFor(e, game)}
                    className="group flex flex-col text-left"
                  >
                    <div
                      className={cn(
                        'relative aspect-video w-full overflow-hidden rounded-lg border bg-surface-2 shadow-sm transition-[transform,box-shadow,border-color] duration-[var(--dur)] ease-[var(--ease-out)] group-hover:-translate-y-0.5 group-hover:shadow-md',
                        selectedId === game.id ? 'border-accent ring-2 ring-accent/40' : 'border-line-faint',
                      )}
                    >
                      <GameCover game={game} />
                      <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-[var(--dur)] group-hover:bg-black/25 group-hover:opacity-100">
                        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white">
                          <Play size={20} fill="currentColor" />
                        </span>
                      </span>
                    </div>
                    <span className="mt-2 truncate text-base font-medium text-fg">{game.title}</span>
                    <span className="text-sm text-fg-subtle">
                      {game.lastPlayedAt ? `${t.library.lastPlayed} ${formatRelative(game.lastPlayedAt)}` : `${t.library.installed} ${formatRelative(game.installedAt)}`}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {selected ? (
          <GameDetails
            game={selected}
            isOwner={isOwner}
            onClose={() => setSelectedId(null)}
            onCover={() => void changeCover(selected)}
            onRemoveCover={() => void removeCover(selected)}
            onRename={() => void rename(selected)}
            onRemove={() => void remove(selected)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full" onKeyDown={onKeyDown}>
      <aside className="flex w-[210px] shrink-0 flex-col border-r border-line-soft bg-surface-0 py-3">
        {[
          { id: 'all' as const, label: t.library.all, icon: LibraryBig, count: server.games.length },
          { id: 'recent' as const, label: t.library.recent, icon: Clock, count: server.games.filter((g) => g.lastPlayedAt).length },
        ].map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setFilter(item.id)}
            className={cn(
              'mx-2 flex h-9 items-center gap-2.5 rounded-md px-2.5 text-left text-base',
              filter === item.id ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            <item.icon size={16} strokeWidth={1.8} />
            <span className="flex-1">{item.label}</span>
            {readable ? <span className="tabular text-sm text-fg-subtle">{item.count}</span> : null}
          </button>
        ))}
        <div className="mx-3 mt-3">
          <Button className="w-full" icon={Plus} onClick={() => openApp('installer')}>
            {t.library.addGame}
          </Button>
        </div>
        <div className="mt-auto flex flex-col gap-3 px-4">
          {server.storage ? (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">{t.library.serverStorage}</div>
              <p className="mt-1 text-sm text-fg-muted">
                {t.library.gamesCount(server.storage.gamesCount)} · {formatBytes(server.storage.gamesBytes)}
              </p>
              {server.storage.diskFreeBytes !== null ? <p className="text-xs text-fg-subtle">{t.library.freeOnServer(formatBytes(server.storage.diskFreeBytes))}</p> : null}
            </div>
          ) : null}
          {isOwner ? (
            <button type="button" className="flex items-center gap-2 text-sm text-fg-subtle hover:text-fg" onClick={() => void server.logout()}>
              <LogOut size={14} /> {t.auth.logout}
            </button>
          ) : null}
        </div>
      </aside>
      <section className="min-w-0 flex-1 bg-surface-1">{body}</section>
    </div>
  );
}

function GameDetails({
  game,
  isOwner,
  onClose,
  onCover,
  onRemoveCover,
  onRename,
  onRemove,
}: {
  game: Game;
  isOwner: boolean;
  onClose: () => void;
  onCover: () => void;
  onRemoveCover: () => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  return (
    <aside className="scroll-area flex w-[300px] shrink-0 flex-col border-l border-line-soft bg-surface-1" aria-label={t.library.details} data-testid="game-details">
      <div className="relative aspect-video w-full overflow-hidden border-b border-line-soft bg-surface-2">
        <GameCover game={game} large />
        <IconButton icon={X} label={t.system.close} size="sm" onClick={onClose} className="absolute right-2 top-2 bg-black/40 text-white hover:bg-black/60" />
      </div>
      <div className="flex flex-col gap-4 p-4">
        <div>
          <h2 className="selectable text-lg font-semibold leading-snug">{game.title}</h2>
          <p className="mt-0.5 truncate text-sm text-fg-subtle" title={game.sourceFileName}>
            {game.sourceFileName}
          </p>
        </div>
        <Button variant="primary" size="lg" icon={Play} onClick={() => void launchGame(game.id)} data-testid="play-button">
          {t.library.play}
        </Button>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-fg-subtle">{t.library.lastPlayed}</dt>
          <dd className="text-fg-muted">{game.lastPlayedAt ? formatDateTime(game.lastPlayedAt) : t.system.never}</dd>
          <dt className="text-fg-subtle">{t.library.installed}</dt>
          <dd className="text-fg-muted">{formatDateTime(game.installedAt)}</dd>
          <dt className="text-fg-subtle">{t.library.size}</dt>
          <dd className="tabular text-fg-muted">{formatBytes(game.sizeBytes)}</dd>
          <dt className="text-fg-subtle">{t.library.files}</dt>
          <dd className="tabular text-fg-muted">{game.fileCount}</dd>
          <dt className="text-fg-subtle">{t.library.runtime}</dt>
          <dd className="text-fg-muted">{game.runtime === 'legacy' ? t.library.runtimeLegacy : t.library.runtimeWasm}</dd>
        </dl>
        <Notice className="text-sm">
          <strong className="text-fg">{t.library.savesTitle}.</strong> {t.library.savesText}
        </Notice>
        {isOwner ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={ImagePlus} onClick={onCover}>
              {t.library.changeCover.replace(' …', '')}
            </Button>
            {game.coverUrl ? (
              <Button size="sm" variant="ghost" onClick={onRemoveCover}>
                {t.library.removeCover}
              </Button>
            ) : null}
            <Button size="sm" icon={Pencil} onClick={onRename}>
              {t.system.rename}
            </Button>
            <Button size="sm" variant="danger" icon={Trash2} onClick={onRemove}>
              {t.library.removeGame.replace(' …', '')}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-fg-subtle">{t.auth.description}</p>
        )}
      </div>
    </aside>
  );
}

function LibraryEmpty() {
  const collapsed = useSettings((s) => s.libraryCollapsedHelp);
  const set = useSettings((s) => s.set);
  return (
    <EmptyState
      icon={Gamepad2}
      title={t.library.emptyTitle}
      actions={
        <>
          <Button variant="primary" icon={Plus} onClick={() => openApp('installer')}>
            {t.library.emptyAction}
          </Button>
          <Button variant="ghost" onClick={() => set('libraryCollapsedHelp', !collapsed)}>
            {t.library.howTo}
          </Button>
        </>
      }
    >
      <p>{t.library.emptyText}</p>
      {!collapsed ? (
        <ol className="mx-auto mt-5 max-w-md space-y-2 text-left text-base">
          {t.library.howToSteps.map((step, i) => (
            <li key={step} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-sm font-semibold text-fg">{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </EmptyState>
  );
}
