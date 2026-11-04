import { normalizeGameHost } from '@/config';
import { readInstalledGameFile } from './local/localGames';

/** Normalisierte Adresse des Spiele-Hosts oder null, wenn keine gültige Adresse eingetragen ist. */
export function gameHostUrl(setting: string): string | null {
  const result = normalizeGameHost(setting);
  return result.ok ? result.url : null;
}

export type HostCheck = { ok: true } | { ok: false; reason: 'empty' | 'invalid' | 'insecure' | 'same-origin' | 'unreachable' | 'not-a-host' };

/** Prüft, ob unter der Adresse ein RenOS-Spiele-Host erreichbar ist (GitHub Pages erlaubt CORS). */
export async function verifyGameHost(setting: string): Promise<HostCheck> {
  const normalized = normalizeGameHost(setting);
  if (!normalized.ok) return normalized;
  try {
    const response = await fetch(`${normalized.url}renos-gamehost.json`, { cache: 'no-store', mode: 'cors', credentials: 'omit' });
    if (!response.ok) return { ok: false, reason: 'not-a-host' };
    const body = (await response.json()) as { name?: string; protocol?: number };
    return body.name === 'renos-gamehost' && body.protocol === 1 ? { ok: true } : { ok: false, reason: 'not-a-host' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

export interface HostSessionHandlers {
  onBridgeMessage: (data: unknown) => void;
  onHostError: (reason: string) => void;
  onStarted: () => void;
}

/**
 * Verbindet RenOS mit der Host-Seite im Player-iframe (lokaler Modus).
 * - Handshake nur mit dem eigenen iframe und nur vom erwarteten Spiele-Origin
 * - Dateianfragen werden ausschließlich für das laufende Spiel und nur lesend beantwortet
 */
export function attachHostSession(iframe: HTMLIFrameElement, gameId: string, hostOrigin: string, handlers: HostSessionHandlers): () => void {
  let channel: MessageChannel | null = null;

  const onPortMessage = (event: MessageEvent) => {
    const msg = event.data as { type?: string; reqId?: number; path?: unknown; payload?: unknown; reason?: unknown } | null;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'file' && typeof msg.reqId === 'number' && typeof msg.path === 'string' && msg.path.length <= 1024) {
      const reqId = msg.reqId;
      void readInstalledGameFile(gameId, msg.path).then(
        (file) => channel?.port1.postMessage(file ? { type: 'file', reqId, ok: true, file } : { type: 'file', reqId, ok: false }),
        () => channel?.port1.postMessage({ type: 'file', reqId, ok: false }),
      );
    } else if (msg.type === 'bridge') {
      handlers.onBridgeMessage(msg.payload);
    } else if (msg.type === 'host-started') {
      handlers.onStarted();
    } else if (msg.type === 'host-error') {
      handlers.onHostError(String(msg.reason ?? '').slice(0, 300));
    }
  };

  const onWindowMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || event.origin !== hostOrigin) return;
    const data = event.data as { source?: string; v?: number; type?: string; reason?: unknown } | null;
    if (!data || data.source !== 'renos-host' || data.v !== 1) return;
    if (data.type === 'ready') {
      channel?.port1.close();
      channel = new MessageChannel();
      channel.port1.onmessage = onPortMessage;
      iframe.contentWindow?.postMessage({ source: 'renos', v: 1, type: 'init', gameId }, hostOrigin, [channel.port2]);
    } else if (data.type === 'host-error') {
      handlers.onHostError(String(data.reason ?? '').slice(0, 300));
    }
  };

  window.addEventListener('message', onWindowMessage);
  return () => {
    window.removeEventListener('message', onWindowMessage);
    channel?.port1.close();
    channel = null;
  };
}
