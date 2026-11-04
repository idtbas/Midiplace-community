import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Info, Maximize2, Minimize2, RotateCw, ServerOff, TriangleAlert, X } from 'lucide-react';
import { parseBridgeMessage, type Game } from '@renos/shared';
import { t } from '@/i18n';
import { cn } from '@/lib/cn';
import { ApiError } from '@/api/client';
import { useServer } from '@/api/server';
import { IS_LOCAL } from '@/config';
import { games as gameBackend } from '@/games/backend';
import { attachHostSession } from '@/games/gameHost';
import { BUILTIN_SANDBOX, attachSandboxSession, buildSandboxDocument } from '@/games/sandboxHost';
import { openApp } from '@/system/actions';
import type { AppProps } from '@/system/apps';
import { useSettings } from '@/system/settings';
import { useWindows } from '@/system/windows';
import { Button, IconButton } from '@/ui/Button';
import { ProgressBar } from '@/ui/Feedback';
import { WindowHeader } from '@/wm/WindowContext';
import { GameCover } from '../library/GameCover';

/**
 * Sandbox des Spiel-iframes bei Spielen auf einem eigenen Spiele-Origin (Server oder externer Host) – bewusst minimal:
 *  allow-scripts       Ren'Py-Laufzeit (JavaScript/WebAssembly)
 *  allow-same-origin   eigener (Spiele-)Origin für IndexedDB-Spielstände und Ressourcen.
 *                      Sicher, weil der Origin sich von RenOS unterscheidet.
 *  allow-forms         Texteingaben von Ren'Py (renpy.input) nutzen ein <form>
 *  allow-downloads     „Export Saves“ / „Download Log“ im Ren'Py-Menü
 *  allow-pointer-lock  von manchen Spielen genutzt
 * Nicht erlaubt: Popups, Navigation des Hauptfensters, Modals, Präsentationen.
 */
export const GAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-downloads allow-pointer-lock';
export const GAME_ALLOW = 'autoplay; fullscreen; gamepad';

type Phase =
  | { name: 'resolving' }
  | { name: 'loading'; booted: boolean; progress: number | null; stalled: boolean }
  | { name: 'running' }
  | { name: 'error'; kind: 'notFound' | 'unreachable' | 'runtime' | 'unsafe' | 'host'; detail?: string };

// Lokaler Modus: Ein externer Spiele-Host installiert beim ersten Start seinen Service Worker.
const BOOT_TIMEOUT_MS = IS_LOCAL ? 30_000 : 15_000;
const STALL_MS = 90_000;

export default function PlayerApp({ windowId, payload }: AppProps) {
  const gameId = typeof payload?.gameId === 'string' ? payload.gameId : null;
  const storedGame = useServer((s) => s.games.find((g) => g.id === gameId) ?? null);
  const upsertGame = useServer((s) => s.upsertGame);
  const immersive = useWindows((s) => s.immersiveId === windowId);
  const autohide = useSettings((s) => s.playerAutohideControls);
  const [game, setGame] = useState<Game | null>(storedGame);
  const [phase, setPhase] = useState<Phase>({ name: 'resolving' });
  const [reloadKey, setReloadKey] = useState(0);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [showSavesHint, setShowSavesHint] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hideTimer = useRef<number | null>(null);
  const expectedOrigin = game?.playUrl ? new URL(game.playUrl).origin : null;
  // Lokaler Modus ohne externe Adresse: eingebauter Spiele-Host (anonymer Origin im iframe).
  const builtin = IS_LOCAL && game !== null && !game.playUrl;
  const sandboxDocument = useMemo(() => (IS_LOCAL ? buildSandboxDocument(window.location.origin) : ''), []);

  // 1. Spiel auflösen und Start vermerken.
  useEffect(() => {
    if (!gameId) {
      setPhase({ name: 'error', kind: 'notFound' });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const fresh = await gameBackend.markPlayed(gameId);
        if (cancelled) return;
        upsertGame(fresh);
        if (!fresh.playUrl && !IS_LOCAL) {
          setPhase({ name: 'error', kind: 'unreachable' });
          return;
        }
        if (fresh.playUrl && new URL(fresh.playUrl).origin === window.location.origin) {
          // Spiele dürfen niemals im Origin von RenOS laufen.
          setPhase({ name: 'error', kind: 'unsafe' });
          return;
        }
        setGame(fresh);
        setPhase({ name: 'loading', booted: false, progress: null, stalled: false });
      } catch (error) {
        if (cancelled) return;
        setPhase({ name: 'error', kind: error instanceof ApiError && error.code === 'not_found' ? 'notFound' : 'unreachable' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameId, upsertGame, reloadKey]);

  useEffect(() => {
    useWindows.getState().setTitle(windowId, game?.title ?? t.apps.player.name);
  }, [windowId, game?.title]);

  // 2. Statusmeldungen der Bridge (im Spiel). Beide Modi verwenden denselben, streng prüfenden Handler.
  const handleBridge = useCallback(
    (data: unknown) => {
      const msg = parseBridgeMessage(data);
      if (!msg) return;
      switch (msg.type) {
        case 'boot':
          setPhase((p) => (p.name === 'loading' ? { ...p, booted: true } : p));
          break;
        case 'progress':
          setPhase((p) => (p.name === 'loading' ? { ...p, booted: true, progress: msg.done / msg.total } : p));
          break;
        case 'running':
          setPhase({ name: 'running' });
          window.setTimeout(() => iframeRef.current?.focus(), 50);
          break;
        case 'error':
          setPhase({ name: 'error', kind: 'runtime', detail: msg.message });
          break;
        case 'storage':
          setPersisted(msg.persisted);
          break;
        case 'exit-request':
          if (useWindows.getState().immersiveId === windowId) useWindows.getState().setImmersive(null);
          else iframeRef.current?.blur();
          break;
      }
    },
    [windowId],
  );

  const frameReady = phase.name === 'loading' || phase.name === 'running';
  useEffect(() => {
    if (!builtin || !frameReady || !game) return undefined;
    const frame = iframeRef.current;
    if (!frame) return undefined;
    // Spielstände liegen im Speicher von RenOS – maßgeblich ist dessen dauerhafter Speicher.
    void navigator.storage?.persisted?.().then(setPersisted, () => setPersisted(null));
    return attachSandboxSession(frame, game.id, {
      onBridgeMessage: handleBridge,
      onUnsafe: () => setPhase({ name: 'error', kind: 'unsafe' }),
    });
  }, [builtin, frameReady, handleBridge, game, reloadKey]);

  useEffect(() => {
    if (builtin || !expectedOrigin || !frameReady) return undefined;
    if (IS_LOCAL) {
      // Lokaler Modus: Die Host-Seite fordert Spieldateien an und reicht Bridge-Meldungen über einen MessagePort weiter.
      const frame = iframeRef.current;
      if (!frame || !game) return undefined;
      return attachHostSession(frame, game.id, expectedOrigin, {
        onBridgeMessage: handleBridge,
        onStarted: () => undefined,
        onHostError: (reason) => setPhase({ name: 'error', kind: 'host', detail: reason }),
      });
    }
    // Server-Modus: Nachrichten nur vom eigenen iframe und nur vom Spiele-Origin.
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin || event.source !== iframeRef.current?.contentWindow) return;
      handleBridge(event.data);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [builtin, expectedOrigin, frameReady, handleBridge, game, reloadKey]);

  // 3. Zeitüberwachung: keine Bridge-Meldung → Server/Spiel nicht erreichbar; sehr langes Laden → Hinweis.
  const loading = phase.name === 'loading';
  const booted = phase.name === 'loading' && phase.booted;
  useEffect(() => {
    if (!loading || booted) return undefined;
    const timer = window.setTimeout(() => setPhase({ name: 'error', kind: 'unreachable' }), BOOT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [loading, booted, reloadKey]);
  useEffect(() => {
    if (!loading) return undefined;
    const timer = window.setTimeout(() => setPhase((p) => (p.name === 'loading' ? { ...p, stalled: true } : p)), STALL_MS);
    return () => window.clearTimeout(timer);
  }, [loading, reloadKey]);

  // 4. Ressourcen freigeben: iframe vor dem Entfernen leeren (beendet Audio, WebAssembly, Speicher).
  useEffect(
    () => () => {
      // Bewusst erst beim Aufräumen lesen: das iframe entsteht erst nach dem Auflösen des Spiels.
      const frame = iframeRef.current;
      if (frame) {
        frame.removeAttribute('srcdoc');
        frame.src = 'about:blank';
      }
    },
    [reloadKey],
  );

  const reload = useCallback(() => {
    setPhase({ name: 'resolving' });
    setReloadKey((k) => k + 1);
  }, []);

  const close = () => useWindows.getState().close(windowId);
  const toLibrary = () => {
    close();
    openApp('library');
  };
  const toggleImmersive = () => useWindows.getState().setImmersive(immersive ? null : windowId);

  const revealControls = () => {
    setControlsVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), 3000);
  };
  useEffect(() => () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
  }, []);

  const controls = (
    <>
      <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={toLibrary}>
        {t.player.backToLibrary}
      </Button>
      <div className="flex-1" />
      <IconButton icon={Info} label={t.library.savesTitle} size="sm" onClick={() => setShowSavesHint((v) => !v)} active={showSavesHint} />
      <IconButton icon={RotateCw} label={t.player.reload} size="sm" onClick={reload} />
      <IconButton icon={immersive ? Minimize2 : Maximize2} label={immersive ? t.player.windowed : t.player.immersive} size="sm" onClick={toggleImmersive} />
      {immersive ? <IconButton icon={X} label={t.player.close} size="sm" onClick={close} /> : null}
    </>
  );

  const pinnedBar = immersive && !autohide;
  const barShown = immersive && (pinnedBar || controlsVisible);

  return (
    <div className={cn('relative flex h-full flex-col bg-black', immersive && 'h-full')} data-testid="player" data-phase={phase.name} data-booted={phase.name === 'loading' && phase.booted ? 'true' : undefined}>
      {!immersive ? (
        <WindowHeader>
          <IconButton icon={Info} label={t.library.savesTitle} size="sm" onClick={() => setShowSavesHint((v) => !v)} active={showSavesHint} />
          <IconButton icon={RotateCw} label={t.player.reload} size="sm" onClick={reload} />
          <IconButton icon={Maximize2} label={t.player.immersive} size="sm" onClick={toggleImmersive} />
        </WindowHeader>
      ) : null}

      {immersive ? (
        <>
          {/* Steuerleiste: oben einblendbar (Zeiger an den Rand oder Griff antippen). */}
          {!pinnedBar ? (
            <>
              <div className="absolute inset-x-0 top-0 z-30 h-2" onPointerEnter={revealControls} aria-hidden />
              <button
                type="button"
                aria-label={t.player.showControls}
                onClick={revealControls}
                className={cn('absolute left-1/2 top-1.5 z-30 h-1.5 w-14 -translate-x-1/2 rounded-full bg-white/25 transition-opacity hover:bg-white/45', barShown && 'opacity-0')}
                style={{ marginTop: 'var(--safe-top)' }}
              />
            </>
          ) : null}
          <div
            className={cn(
              'os-chrome theme-dark z-40 flex items-center gap-1 border-b border-white/10 bg-[#0c0f14]/92 px-2 py-1.5 transition-[transform,opacity] duration-[var(--dur)] ease-[var(--ease-out)]',
              pinnedBar ? 'relative' : 'absolute inset-x-0 top-0',
              barShown ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-full opacity-0',
            )}
            style={{ paddingTop: 'calc(var(--safe-top) + 6px)' }}
            onPointerEnter={() => hideTimer.current && window.clearTimeout(hideTimer.current)}
            onPointerLeave={revealControls}
            data-testid="player-controls"
          >
            {controls}
          </div>
        </>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {game && phase.name !== 'error' && phase.name !== 'resolving' ? (
          <iframe
            key={reloadKey}
            ref={iframeRef}
            src={builtin ? undefined : game.playUrl}
            srcDoc={builtin ? sandboxDocument : undefined}
            title={game.title}
            sandbox={builtin ? BUILTIN_SANDBOX : GAME_SANDBOX}
            allow={GAME_ALLOW}
            referrerPolicy="no-referrer"
            className={cn('absolute inset-0 h-full w-full border-0 bg-black', phase.name === 'running' ? 'opacity-100' : 'opacity-0')}
            data-testid="game-frame"
            data-host={builtin ? 'builtin' : 'origin'}
          />
        ) : null}

        {phase.name === 'resolving' || phase.name === 'loading' ? (
          <div className="absolute inset-0 flex items-center justify-center overflow-hidden" data-testid="player-loading">
            {game ? (
              <div className="absolute inset-0 scale-110 opacity-30 blur-2xl">
                <GameCover game={game} />
              </div>
            ) : null}
            <div className="relative w-[340px] max-w-[80%] text-center">
              {game ? (
                <div className="mx-auto mb-5 aspect-video w-56 overflow-hidden rounded-lg border border-white/10 shadow-xl">
                  <GameCover game={game} />
                </div>
              ) : null}
              <div className="text-lg font-semibold text-white">{game?.title ?? t.player.connecting}</div>
              <div className="mt-1 text-sm text-white/60">
                {phase.name === 'resolving' || !phase.booted ? t.player.connecting : phase.progress === null ? t.player.starting : t.player.loadingEngine}
              </div>
              <ProgressBar className="mt-4 bg-white/10" value={phase.name === 'loading' ? phase.progress : null} label={t.player.loadingEngine} />
              {phase.name === 'loading' && phase.stalled ? (
                <div className="mt-4 text-sm text-white/70">
                  {t.player.stalled}
                  <div className="mt-3 flex justify-center gap-2">
                    <Button size="sm" onClick={() => setPhase({ ...phase, stalled: false })}>
                      {t.player.keepWaiting}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={reload}>
                      {t.player.reload}
                    </Button>
                  </div>
                </div>
              ) : null}
              <p className="mt-6 text-xs text-white/40">{immersive ? t.player.exitHint : t.player.savesHint}</p>
            </div>
          </div>
        ) : null}

        {phase.name === 'error' ? (
          <div className="absolute inset-0 flex items-center justify-center bg-surface-1 p-8" role="alert" data-testid="player-error">
            <div className="max-w-md text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-danger-soft text-danger">
                {phase.kind === 'unreachable' ? <ServerOff size={26} /> : <TriangleAlert size={26} />}
              </div>
              <h3 className="text-lg font-semibold text-fg">{t.player.errorTitle}</h3>
              <p className="mt-2 text-base text-fg-muted">
                {phase.kind === 'notFound'
                  ? t.player.notFound
                  : phase.kind === 'unreachable'
                    ? builtin
                      ? t.player.errorBuiltinTimeout
                      : IS_LOCAL
                        ? t.player.errorUnreachableLocal
                        : t.player.errorUnreachable
                    : phase.kind === 'unsafe'
                      ? t.player.errorUnsafe
                      : phase.kind === 'host'
                          ? t.player.errorHost
                          : t.player.errorRuntime}
              </p>
              {phase.detail ? (
                <pre className="selectable mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-0 p-3 text-left font-mono text-xs text-fg-muted">{phase.detail}</pre>
              ) : null}
              <div className="mt-6 flex justify-center gap-2">
                {phase.kind !== 'notFound' && phase.kind !== 'unsafe' ? (
                  <Button icon={RotateCw} onClick={reload}>
                    {t.system.retry}
                  </Button>
                ) : null}
                <Button variant="primary" icon={ArrowLeft} onClick={toLibrary}>
                  {t.player.backToLibrary}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {showSavesHint ? (
          <div className="os-chrome panel-surface absolute right-3 top-3 z-50 w-[300px] rounded-lg p-4 text-sm" role="note">
            <div className="mb-1 font-semibold text-fg">{t.library.savesTitle}</div>
            <p className="text-fg-muted">{builtin ? t.library.savesTextBuiltin : t.library.savesText}</p>
            {persisted !== null ? <p className={cn('mt-2', persisted ? 'text-success' : 'text-warning')}>{persisted ? t.player.storagePersisted : t.player.storageNotPersisted}</p> : null}
            <Button size="sm" className="mt-3" onClick={() => setShowSavesHint(false)}>
              {t.system.close}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
