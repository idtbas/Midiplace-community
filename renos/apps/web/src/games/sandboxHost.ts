import runtimeSource from './sandbox/runtime.js?raw';
import { applySaveChanges, loadSaves } from './local/saves';
import { readInstalledGameFile } from './local/localGames';
import { removeOverlayFiles, saveOverlayFile } from './local/overlay';

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

export interface PickOptions {
  title: string;
  patterns: string[];
  multiple: boolean;
}

export interface PickedFile {
  name: string;
  data: ArrayBuffer;
}

export interface SandboxSessionHandlers {
  onBridgeMessage: (data: unknown) => void;
  onUnsafe: () => void;
  /** Dateiauswahl von RenOS für das Spiel (null = abgebrochen). */
  onPickFiles?: (options: PickOptions) => Promise<PickedFile[] | null>;
  /** „Speichern unter“ im Spiel: Datei in RenOS ablegen. */
  onExportFile?: (name: string, data: Blob) => Promise<void>;
}

/** Höchstens so viele Exporte pro Spielsitzung (Schutz vor einem Spiel, das Files zuschüttet). */
const MAX_EXPORTS = 50;
const MAX_EXPORT_BYTES = 512 * 1024 * 1024;

function pickOptions(value: unknown): PickOptions {
  const o = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    title: typeof o.title === 'string' ? o.title.slice(0, 200) : '',
    patterns: Array.isArray(o.patterns) ? o.patterns.filter((p): p is string => typeof p === 'string').map((p) => p.slice(0, 40)).slice(0, 20) : [],
    multiple: o.multiple === true,
  };
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
  // Vom Spiel angelegte Dateien ebenfalls nacheinander (Speicherplatz, Reihenfolge).
  let overlayQueue: Promise<unknown> = Promise.resolve();
  let picking = false;
  let exports = 0;

  const reply = (msg: Record<string, unknown>, transfer: Transferable[] = []) => {
    if (!closed) channel?.port1.postMessage(msg, transfer);
  };

  const onPortMessage = (event: MessageEvent) => {
    const msg = event.data as {
      type?: unknown;
      reqId?: unknown;
      path?: unknown;
      payload?: unknown;
      put?: unknown;
      del?: unknown;
      options?: unknown;
      data?: unknown;
      paths?: unknown;
      name?: unknown;
    } | null;
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
      case 'pick': {
        if (reqId === null) return;
        if (!handlers.onPickFiles || picking) {
          reply({ type: 'pick', reqId, ok: false });
          return;
        }
        picking = true;
        void handlers
          .onPickFiles(pickOptions(msg.options))
          .then(
            (files) => (files ? reply({ type: 'pick', reqId, ok: true, files }, files.map((f) => f.data)) : reply({ type: 'pick', reqId, ok: false })),
            () => reply({ type: 'pick', reqId, ok: false }),
          )
          .finally(() => {
            picking = false;
          });
        return;
      }
      case 'persist':
        if (reqId === null) return;
        overlayQueue = overlayQueue.then(() =>
          saveOverlayFile(gameId, msg.path, msg.data).then(
            (result) => reply({ type: 'persist', reqId, ...result }),
            () => reply({ type: 'persist', reqId, ok: false, reason: 'Die Datei konnte nicht gespeichert werden.' }),
          ),
        );
        return;
      case 'forget':
        if (reqId === null) return;
        overlayQueue = overlayQueue.then(() =>
          removeOverlayFiles(gameId, msg.paths).then(
            (count) => reply({ type: 'forget', reqId, ok: true, count }),
            () => reply({ type: 'forget', reqId, ok: false }),
          ),
        );
        return;
      case 'export': {
        if (reqId === null) return;
        const name = typeof msg.name === 'string' ? [...msg.name].map((c) => (c === '/' || c === '\\' || c.charCodeAt(0) < 32 ? '_' : c)).join('').slice(0, 200) : '';
        if (!handlers.onExportFile || !(msg.data instanceof ArrayBuffer) || !name || msg.data.byteLength > MAX_EXPORT_BYTES || exports >= MAX_EXPORTS) {
          reply({ type: 'export', reqId, ok: false });
          return;
        }
        exports += 1;
        void handlers.onExportFile(name, new Blob([msg.data])).then(
          () => reply({ type: 'export', reqId, ok: true }),
          () => reply({ type: 'export', reqId, ok: false }),
        );
        return;
      }
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
