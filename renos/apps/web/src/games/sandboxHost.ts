import runtimeSource from './sandbox/runtime.js?raw';
import { applySaveChanges, loadSaves } from './local/saves';
import { readInstalledGameFile } from './local/localGames';

/**
 * Eingebauter Spiele-Host (lokaler Modus).
 *
 * Jedes Spiel läuft in einem iframe mit sandbox OHNE allow-same-origin. Der Browser gibt ihm damit
 * einen eigenen, anonymen Origin: Es kann weder RenOS noch andere Spiele lesen oder verändern –
 * dieselbe Trennung wie bei einer zweiten Adresse, aber ohne zweite Website.
 *
 * Die Laufzeit im iframe (sandbox/runtime.js) bekommt Dateien und Spielstände ausschließlich über
 * einen MessagePort von hier. Alle Anfragen werden geprüft: nur Dateien des laufenden, installierten
 * Spiels, nur lesend; Spielstände nur für dieses Spiel und mit Größenlimits.
 */

/** Virtuelle Adresse, unter der das Spiel seine Dateien sieht (.invalid ist reserviert und nie erreichbar). */
export const SANDBOX_BASE = 'https://renos-game.invalid/';

/**
 * Sandbox des Spiel-iframes im eingebauten Host:
 *  allow-scripts       Ren'Py-Laufzeit (JavaScript/WebAssembly)
 *  allow-forms         Texteingaben von Ren'Py (renpy.input) nutzen ein <form>
 *  allow-downloads     „Export Saves“ / „Download Log“ im Ren'Py-Menü
 *  allow-pointer-lock  von manchen Spielen genutzt
 * Bewusst NICHT: allow-same-origin (sonst liefe das Spiel mit den Rechten von RenOS), Popups,
 * Navigation des Hauptfensters, Modals.
 */
export const BUILTIN_SANDBOX = 'allow-scripts allow-forms allow-downloads allow-pointer-lock';

/**
 * Content-Security-Policy des Spieldokuments. Ren'Py braucht Inline-Skripte, eval und WebAssembly.
 * Netzwerkzugriffe sind nicht erlaubt – alle Dateien kommen über RenOS (blob:/data:).
 */
export const BUILTIN_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "style-src 'unsafe-inline' blob: data:",
  'img-src blob: data:',
  'media-src blob: data:',
  'font-src blob: data:',
  'connect-src blob: data:',
  'worker-src blob:',
  `base-uri ${SANDBOX_BASE}`,
  "form-action 'none'",
  "object-src 'none'",
  "frame-src 'none'",
].join('; ');

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** HTML für das srcdoc des Spiel-iframes. */
export function buildSandboxDocument(parentOrigin: string): string {
  const config = JSON.stringify({ base: SANDBOX_BASE, parentOrigin }).replace(/</g, '\\u003c');
  const script = runtimeSource.replace('})(__RENOS_CONFIG__);', () => `})(${config});`).replace(/<\/script/gi, '<\\/script');
  return [
    '<!doctype html>',
    '<html><head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(BUILTIN_CSP)}">`,
    `<base href="${SANDBOX_BASE}">`,
    '<style>html,body{margin:0;height:100%;background:#000}</style>',
    `<script>${script}</script>`,
    '</head><body></body></html>',
  ].join('');
}

export interface SandboxSessionHandlers {
  onBridgeMessage: (data: unknown) => void;
  onUnsafe: () => void;
}

/**
 * Verbindet RenOS mit der Laufzeit im iframe.
 * - Handshake nur mit dem eigenen iframe und nur, wenn dessen Origin wirklich anonym ist („null“)
 * - danach ausschließlich über einen MessagePort (nicht über window.postMessage an „*“)
 */
export function attachSandboxSession(iframe: HTMLIFrameElement, gameId: string, handlers: SandboxSessionHandlers): () => void {
  let channel: MessageChannel | null = null;
  let closed = false;
  // Spielstand-Änderungen nacheinander anwenden, damit ihre Reihenfolge erhalten bleibt.
  let saveQueue: Promise<unknown> = Promise.resolve();

  const reply = (msg: Record<string, unknown>) => {
    if (!closed) channel?.port1.postMessage(msg);
  };

  const onPortMessage = (event: MessageEvent) => {
    const msg = event.data as { type?: unknown; reqId?: unknown; path?: unknown; payload?: unknown; put?: unknown; del?: unknown } | null;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    const reqId = typeof msg.reqId === 'number' && Number.isSafeInteger(msg.reqId) ? msg.reqId : null;
    switch (msg.type) {
      case 'file':
        if (reqId === null || typeof msg.path !== 'string' || msg.path.length > 1024) return;
        void readInstalledGameFile(gameId, msg.path).then(
          (file) => reply(file ? { type: 'file', reqId, ok: true, file } : { type: 'file', reqId, ok: false }),
          () => reply({ type: 'file', reqId, ok: false }),
        );
        return;
      case 'saves':
        if (reqId === null) return;
        saveQueue = saveQueue.then(() =>
          applySaveChanges(gameId, msg.put, msg.del).then(
            (result) => reply({ type: 'saves', reqId, ...result }),
            () => reply({ type: 'saves', reqId, ok: false, reason: 'Der Spielstand konnte nicht gespeichert werden.' }),
          ),
        );
        return;
      case 'bridge':
        handlers.onBridgeMessage(msg.payload);
        return;
      default:
        return;
    }
  };

  const onWindowMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || event.origin !== 'null') return;
    const data = event.data as { source?: unknown; v?: unknown; type?: unknown } | null;
    if (!data || data.source !== 'renos-sandbox' || data.v !== 1 || data.type !== 'ready') return;
    // Gegenprobe: Kann RenOS das Dokument des Spiels lesen, wäre die Trennung aufgehoben.
    let readable: boolean;
    try {
      readable = Boolean(iframe.contentDocument);
    } catch {
      readable = false;
    }
    if (readable) {
      handlers.onUnsafe();
      return;
    }
    channel?.port1.close();
    channel = new MessageChannel();
    channel.port1.onmessage = onPortMessage;
    const port = channel.port2;
    const current = channel;
    void loadSaves(gameId).then(
      (saves) => {
        if (closed || channel !== current) return;
        // Ein anonymer Origin lässt sich nicht als Ziel angeben; die Nachricht enthält nur den Port.
        iframe.contentWindow?.postMessage({ source: 'renos', v: 1, type: 'init' }, '*', [port]);
        current.port1.postMessage({ type: 'init', saves });
      },
      () => {
        if (closed || channel !== current) return;
        iframe.contentWindow?.postMessage({ source: 'renos', v: 1, type: 'init' }, '*', [port]);
        current.port1.postMessage({ type: 'init', saves: [] });
      },
    );
  };

  window.addEventListener('message', onWindowMessage);
  return () => {
    closed = true;
    window.removeEventListener('message', onWindowMessage);
    channel?.port1.close();
    channel = null;
  };
}
