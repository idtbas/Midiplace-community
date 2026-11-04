import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Gamepad2, Search, Settings2 } from 'lucide-react';
import type { Game } from '@renos/shared';
import { t } from '@/i18n';
import { cn } from '@/lib/cn';
import { canReadLibrary, useServer } from '@/api/server';
import { launchGame, openApp } from '@/system/actions';
import { APP_META, type AppMeta } from '@/system/appMeta';
import { APP_IDS } from '@/system/appIds';
import { useShell } from '@/system/shell';

type Result =
  | { type: 'app'; key: string; app: AppMeta }
  | { type: 'game'; key: string; game: Game }
  | { type: 'action'; key: string; label: string; detail: string; run: () => void };

const SETTINGS_ACTIONS = [
  { section: 'appearance', label: 'Akzentfarbe & Animationen', words: ['akzent', 'farbe', 'animation', 'design', 'erscheinungsbild', 'transparenz'] },
  { section: 'desktop', label: 'Hintergrundbild ändern', words: ['hintergrund', 'wallpaper', 'desktop', 'bild'] },
  { section: 'dock', label: 'Dock anpassen', words: ['dock', 'leiste', 'ausblenden'] },
  { section: 'keyboard', label: 'Tastenkürzel', words: ['tastatur', 'kürzel', 'shortcut', 'keyboard'] },
  { section: 'storage', label: 'Speicher & Datensicherung', words: ['speicher', 'backup', 'sicherung', 'export', 'löschen', 'daten'] },
  { section: 'games', label: 'Server & Anmeldung', words: ['server', 'anmelden', 'login', 'passwort', 'spiele'] },
  { section: 'about', label: 'Systeminformationen', words: ['info', 'version', 'system', 'über'] },
] as const;

/** Einfache, nachvollziehbare Trefferbewertung (Präfix > Wortanfang > enthalten). */
export function scoreMatch(query: string, ...fields: string[]): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  let best = 0;
  for (const field of fields) {
    const f = field.toLowerCase();
    if (f === q) best = Math.max(best, 100);
    else if (f.startsWith(q)) best = Math.max(best, 80);
    else if (f.split(/[\s\-_/]+/).some((w) => w.startsWith(q))) best = Math.max(best, 60);
    else if (f.includes(q)) best = Math.max(best, 30);
  }
  return best;
}

export function Launcher() {
  const { launcherOpen, launcherQuery, setLauncherQuery, closeLauncher } = useShell();
  const games = useServer((s) => s.games);
  const libraryReadable = useServer((s) => canReadLibrary(s) && s.status !== 'offline');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const query = launcherQuery;

  const results = useMemo<Result[]>(() => {
    const apps = APP_IDS.map((id) => APP_META[id]).filter((a) => a.showInLauncher);
    if (!query.trim()) {
      return [
        ...apps.map((app) => ({ type: 'app' as const, key: `app-${app.id}`, app })),
        ...[...games]
          .sort((a, b) => (b.lastPlayedAt ?? b.installedAt).localeCompare(a.lastPlayedAt ?? a.installedAt))
          .slice(0, 6)
          .map((game) => ({ type: 'game' as const, key: `game-${game.id}`, game })),
      ];
    }
    const scoredApps = apps
      .map((app) => ({ app, score: scoreMatch(query, app.name, app.description, ...app.keywords) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ app }) => ({ type: 'app' as const, key: `app-${app.id}`, app }));
    const scoredGames = games
      .map((game) => ({ game, score: scoreMatch(query, game.title, game.sourceFileName) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.game.title.localeCompare(b.game.title))
      .slice(0, 12)
      .map(({ game }) => ({ type: 'game' as const, key: `game-${game.id}`, game }));
    const actions = SETTINGS_ACTIONS.map((a) => ({ a, score: scoreMatch(query, a.label, ...a.words) }))
      .filter((r) => r.score >= 60)
      .map(({ a }) => ({
        type: 'action' as const,
        key: `action-${a.section}`,
        label: a.label,
        detail: APP_META.settings.name,
        run: () => openApp('settings', { section: a.section }),
      }));
    return [...scoredApps, ...scoredGames, ...actions];
  }, [query, games]);

  useEffect(() => setActive(0), [query, launcherOpen]);
  useEffect(() => {
    if (!launcherOpen) return undefined;
    inputRef.current?.focus();
    // Schnell getippte Zeichen, bevor das Suchfeld den Fokus hat, nicht verlieren.
    const onKeyDown = (e: KeyboardEvent) => {
      const input = inputRef.current;
      if (!input || e.target === input || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
      e.preventDefault();
      useShell.getState().setLauncherQuery(useShell.getState().launcherQuery + e.key);
      input.focus();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [launcherOpen]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const appCount = results.filter((r) => r.type === 'app').length;
  const gridMode = !query.trim();
  const columns = 6;

  const activate = (result: Result | undefined) => {
    if (!result) return;
    closeLauncher();
    if (result.type === 'app') openApp(result.app.id);
    else if (result.type === 'game') void launchGame(result.game.id);
    else result.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const max = results.length - 1;
    const move = (delta: number) => {
      e.preventDefault();
      setActive((a) => Math.min(Math.max(a + delta, 0), max));
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      if (query) setLauncherQuery('');
      else closeLauncher();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(results[active]);
    } else if (e.key === 'ArrowDown') {
      move(gridMode && active < appCount ? Math.min(columns, Math.max(appCount - active, 1)) : 1);
    } else if (e.key === 'ArrowUp') {
      move(gridMode && active < appCount + columns && active >= columns ? -columns : -1);
    } else if (e.key === 'ArrowRight' && gridMode) {
      move(1);
    } else if (e.key === 'ArrowLeft' && gridMode) {
      move(-1);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      move(e.shiftKey ? -1 : 1);
    }
  };

  const apps = results.filter((r): r is Extract<Result, { type: 'app' }> => r.type === 'app');
  const rest = results.filter((r) => r.type !== 'app');

  return (
    <AnimatePresence>
      {launcherOpen ? (
        <motion.div
          key="launcher"
          className="os-chrome fixed inset-0 flex items-start justify-center bg-black/40 px-6"
          style={{ zIndex: 8000, paddingTop: 'calc(var(--topbar-h) + var(--safe-top) + 7vh)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) closeLauncher();
          }}
        >
          <motion.div
            role="dialog"
            aria-label={t.system.apps}
            className="panel-surface flex max-h-[72vh] w-full max-w-[640px] flex-col overflow-hidden rounded-xl"
            initial={{ opacity: 0, y: -10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.99 }}
            transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
            onKeyDown={onKeyDown}
          >
            <div className="flex items-center gap-3 border-b border-line-soft px-4">
              <Search size={18} strokeWidth={2} className="text-fg-subtle" />
              <input
                ref={inputRef}
                autoFocus
                value={query}
                onChange={(e) => setLauncherQuery(e.target.value)}
                placeholder={t.launcher.placeholder}
                aria-label={t.launcher.placeholder}
                className="h-12 flex-1 bg-transparent text-md text-fg placeholder:text-fg-faint focus:outline-none"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
            <div ref={listRef} className="scroll-area min-h-0 flex-1 p-2" role="listbox" aria-label={t.system.apps}>
              {results.length === 0 ? (
                <p className="px-3 py-8 text-center text-base text-fg-muted">{t.launcher.noResults(query)}</p>
              ) : null}
              {apps.length ? (
                <>
                  <SectionLabel>{t.launcher.apps}</SectionLabel>
                  <div className={cn(gridMode ? 'grid grid-cols-6 gap-1 px-1 pb-2' : 'flex flex-col')}>
                    {apps.map((r) => {
                      const index = results.indexOf(r);
                      return gridMode ? (
                        <button
                          key={r.key}
                          type="button"
                          role="option"
                          aria-selected={index === active}
                          data-index={index}
                          onPointerEnter={() => setActive(index)}
                          onClick={() => activate(r)}
                          className={cn('flex flex-col items-center gap-1.5 rounded-lg px-1 py-3', index === active ? 'bg-surface-3' : 'hover:bg-surface-3/60')}
                        >
                          <img src={r.app.icon} alt="" className="h-12 w-12" draggable={false} />
                          <span className="text-sm text-fg">{r.app.name}</span>
                        </button>
                      ) : (
                        <Row key={r.key} index={index} active={index === active} onHover={setActive} onClick={() => activate(r)} icon={<img src={r.app.icon} alt="" className="h-7 w-7" />} title={r.app.name} detail={r.app.description} />
                      );
                    })}
                  </div>
                </>
              ) : null}
              {rest.some((r) => r.type === 'game') ? <SectionLabel>{t.launcher.games}</SectionLabel> : null}
              {rest
                .filter((r): r is Extract<Result, { type: 'game' }> => r.type === 'game')
                .map((r) => {
                  const index = results.indexOf(r);
                  return (
                    <Row
                      key={r.key}
                      index={index}
                      active={index === active}
                      onHover={setActive}
                      onClick={() => activate(r)}
                      icon={
                        r.game.coverUrl ? (
                          <img src={r.game.coverUrl} alt="" className="h-7 w-11 rounded-xs object-cover" />
                        ) : (
                          <span className="flex h-7 w-11 items-center justify-center rounded-xs bg-surface-3 text-fg-subtle">
                            <Gamepad2 size={15} />
                          </span>
                        )
                      }
                      title={r.game.title}
                      detail={t.library.play}
                    />
                  );
                })}
              {rest.some((r) => r.type === 'action') ? <SectionLabel>{t.launcher.actions}</SectionLabel> : null}
              {rest
                .filter((r): r is Extract<Result, { type: 'action' }> => r.type === 'action')
                .map((r) => {
                  const index = results.indexOf(r);
                  return (
                    <Row
                      key={r.key}
                      index={index}
                      active={index === active}
                      onHover={setActive}
                      onClick={() => activate(r)}
                      icon={
                        <span className="flex h-7 w-7 items-center justify-center rounded-sm bg-surface-3 text-fg-muted">
                          <Settings2 size={15} />
                        </span>
                      }
                      title={r.label}
                      detail={r.detail}
                    />
                  );
                })}
              {!libraryReadable && query.trim() ? <p className="px-3 py-2 text-sm text-fg-subtle">{t.launcher.gamesUnavailable}</p> : null}
            </div>
            <div className="border-t border-line-soft px-4 py-2 text-xs text-fg-subtle">{t.launcher.hint}</div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{children}</div>;
}

function Row({
  index,
  active,
  onHover,
  onClick,
  icon,
  title,
  detail,
}: {
  index: number;
  active: boolean;
  onHover: (i: number) => void;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-index={index}
      onPointerEnter={() => onHover(index)}
      onClick={onClick}
      className={cn('flex w-full items-center gap-3 rounded-md px-3 py-2 text-left', active ? 'bg-surface-3' : 'hover:bg-surface-3/60')}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base text-fg">{title}</span>
      </span>
      <span className="text-sm text-fg-subtle">{detail}</span>
    </button>
  );
}
