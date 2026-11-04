import { t } from '@/i18n';
import { useServer } from '@/api/server';
import type { AppId } from './appIds';
import { APP_META } from './appMeta';
import { confirmDialog } from './dialogs';
import { useSettings } from './settings';
import { useWindows, type WindowPayload } from './windows';

/** Öffnet eine App (oder holt ein vorhandenes Fenster einer Single-Instance-App nach vorn). */
export function openApp(appId: AppId, payload: WindowPayload | null = null, options: { newInstance?: boolean } = {}): string {
  return useWindows.getState().open(appId, payload, options);
}

/**
 * Verhalten beim Klick auf ein Dock-Symbol:
 * - App läuft nicht → öffnen
 * - oberstes Fenster der App ist fokussiert → minimieren
 * - sonst → zuletzt benutztes Fenster der App nach vorn holen
 */
export function activateApp(appId: AppId): void {
  const { windows, order, focusedId, focus, minimize } = useWindows.getState();
  const appWindows = order.filter((id) => windows[id]?.appId === appId);
  if (appWindows.length === 0) {
    openApp(appId);
    return;
  }
  const topId = appWindows[appWindows.length - 1]!;
  if (focusedId === topId && !windows[topId]!.minimized) {
    minimize(topId);
    return;
  }
  focus(topId);
}

export function closeApp(appId: AppId): void {
  const { windows, close } = useWindows.getState();
  for (const w of Object.values(windows)) if (w.appId === appId) close(w.id);
}

/** Startet ein Spiel im Player. Läuft bereits ein anderes Spiel, wird vorher nachgefragt. */
export async function launchGame(gameId: string): Promise<void> {
  const ws = useWindows.getState();
  const existing = Object.values(ws.windows).find((w) => w.appId === 'player');
  if (existing && existing.payload?.gameId !== gameId) {
    const running = useServer.getState().games.find((g) => g.id === existing.payload?.gameId);
    const ok = await confirmDialog({
      title: t.player.switchGameTitle,
      message: t.player.switchGameText(running?.title ?? APP_META.player.name),
      confirmLabel: t.player.switchGameConfirm,
      destructive: true,
    });
    if (!ok) return;
    useWindows.getState().close(existing.id);
  }
  const id = useWindows.getState().open('player', { gameId });
  if (useSettings.getState().playerImmersive) useWindows.getState().setImmersive(id);
}

/** Öffnet Files an einem Ort (Ordner-ID oder „trash“). Ein vorhandenes Fenster wird wiederverwendet. */
export function openFilesAt(location: string): void {
  const ws = useWindows.getState();
  const existing = ws.order.map((id) => ws.windows[id]).filter((w) => w?.appId === 'files').pop();
  if (existing) {
    ws.setPayload(existing.id, { location, nonce: Date.now() });
    ws.focus(existing.id);
    return;
  }
  ws.open('files', { location, nonce: Date.now() });
}
