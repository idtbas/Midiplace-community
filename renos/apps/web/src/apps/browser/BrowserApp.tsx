import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Download, ExternalLink, FolderOpen, Globe, Home, ListChecks, RotateCw, Settings2, X } from 'lucide-react';
import { IS_LOCAL } from '@/config';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { db } from '@/persistence/db';
import { openApp, openFilesAt } from '@/system/actions';
import type { AppProps } from '@/system/apps';
import { openDialog } from '@/system/dialogs';
import { cancelDownload, normalizeUrl, startDownload, useDownloads, type DownloadItem, type PageResult } from '@/system/downloads';
import { openFileWith } from '@/system/fileTypes';
import { useSettings } from '@/system/settings';
import { useShortcut } from '@/system/shortcuts';
import { useWindows } from '@/system/windows';
import { Button, IconButton } from '@/ui/Button';
import { ProgressBar } from '@/ui/Feedback';
import { TextInput } from '@/ui/Form';
import { WindowHeader } from '@/wm/WindowContext';

/**
 * Browser von RenOS. Zeigt Webseiten in einem eingebetteten Rahmen und lädt Dateien direkt nach RenOS
 * (Files → Downloads) statt in die Dateien-App des iPads.
 *
 * Grenzen des Browsers (nicht von RenOS): Viele Seiten verbieten das Einbetten (dann bleibt der Rahmen
 * leer), und Downloads aus Web-Apps sind nur erlaubt, wenn der Server es zulässt (CORS). Für beides gibt
 * es „In Safari öffnen“ und optional einen eigenen Weiterleitungsdienst für Downloads.
 */

const QUICK_LINKS = [
  { label: 'Student Transfer', url: 'https://student-transfer.com/' },
  { label: 'Ren’Py', url: 'https://www.renpy.org/' },
  { label: 'Wikipedia', url: 'https://de.wikipedia.org/' },
];

/** Seiten auf der Adresse von RenOS selbst bekämen dessen Rechte – sie werden nicht eingebettet. */
function sameOriginAsRenos(url: string): boolean {
  try {
    return new URL(url).origin === window.location.origin;
  } catch {
    return false;
  }
}

function DownloadRow({ item }: { item: DownloadItem }) {
  const open = async () => {
    if (!item.nodeId) return;
    const node = await db.nodes.get(item.nodeId);
    if (node && !openFileWith(node)) openFilesAt('downloads');
  };
  return (
    <li className="border-b border-line-soft px-3 py-2.5 text-sm" data-testid="download-item" data-state={item.state}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium" title={item.url}>
          {item.name}
        </span>
        {item.state === 'running' ? <IconButton icon={X} label="Abbrechen" size="sm" onClick={() => cancelDownload(item.id)} /> : null}
      </div>
      {item.state === 'running' ? (
        <>
          <ProgressBar className="mt-1.5" value={item.total ? item.received / item.total : null} label="Fortschritt" />
          <div className="tabular mt-1 text-xs text-fg-subtle">
            {formatBytes(item.received)}
            {item.total ? ` von ${formatBytes(item.total)}` : ''}
            {item.viaProxy ? ' · über Weiterleitung' : ''}
          </div>
        </>
      ) : item.state === 'done' ? (
        <div className="mt-1 flex items-center gap-3 text-xs">
          <span className="text-success">Fertig · {formatBytes(item.received)}</span>
          {item.nodeId ? (
            <>
              <button type="button" className="text-accent hover:underline" onClick={() => void open()}>
                Öffnen
              </button>
              <button type="button" className="text-accent hover:underline" onClick={() => openFilesAt('downloads')}>
                In Files zeigen
              </button>
            </>
          ) : null}
        </div>
      ) : (
        <p className={cn('mt-1 text-xs', item.state === 'error' ? 'text-danger' : 'text-fg-subtle')}>{item.error ?? 'Abgebrochen.'}</p>
      )}
    </li>
  );
}

/** Dialog „Herunterladen nach RenOS“ – Adresse prüfen, laden, bei Webseiten gefundene Datei-Links anbieten. */
function DownloadDialog({ initialUrl, close }: { initialUrl: string; close: () => void }) {
  const [value, setValue] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<PageResult | null>(null);

  const run = async (target: string, allowPage = true) => {
    setBusy(true);
    setError(null);
    try {
      const result = await startDownload(target, { allowPage });
      if (result.kind === 'page') setPage(result);
      else close();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="download-dialog">
      <h2 className="text-lg font-semibold text-fg">Herunterladen nach RenOS</h2>
      <p className="mt-1 text-sm text-fg-muted">Die Datei landet in Files → Downloads – nicht in der Dateien-App des iPads.</p>
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(value);
        }}
      >
        <TextInput value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://…" aria-label="Adresse der Datei" autoFocus data-testid="download-url" />
        <Button type="submit" variant="primary" loading={busy} data-testid="download-start">
          Laden
        </Button>
      </form>
      {error ? (
        <p className="mt-3 text-sm text-danger" role="alert" data-testid="download-error">
          {error}
        </p>
      ) : null}
      {page ? (
        <div className="mt-4">
          <p className="text-sm text-fg-muted">
            Das ist eine Webseite, keine Datei. {page.links.length ? 'Gefundene Datei-Links:' : 'Auf ihr wurden keine Datei-Links gefunden.'}
          </p>
          <ul className="scroll-area mt-2 max-h-56 overflow-auto rounded-md border border-line-soft">
            {page.links.map((link) => (
              <li key={link.url}>
                <button
                  type="button"
                  className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-surface-2"
                  onClick={() => void run(link.url, false)}
                  data-testid="download-link"
                >
                  <span className="truncate font-medium">{link.label}</span>
                  <span className="w-full truncate text-xs text-fg-subtle">{link.url}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="mt-4 text-xs text-fg-subtle">
        Tipp: Einen Download-Link auf der Seite gedrückt halten → „Link kopieren“ und hier einfügen. Manche Server erlauben Downloads aus Web-Apps nicht – dann hilft „In Safari
        öffnen“ (danach in Files importieren) oder ein eigener Weiterleitungsdienst (Einstellungen → Browser & Downloads).
      </p>
      <div className="mt-4 flex justify-end">
        <Button variant="ghost" onClick={close}>
          Schließen
        </Button>
      </div>
    </div>
  );
}

export function openDownloadDialog(initialUrl = ''): Promise<void> {
  return openDialog({ title: 'Herunterladen nach RenOS', width: 560, render: (close) => <DownloadDialog initialUrl={initialUrl} close={close} /> });
}

/** Im Server-Modus erlaubt die Sicherheitsrichtlinie von RenOS keine fremden Seiten und Downloads. */
function ServerModeNotice() {
  return (
    <div className="flex h-full items-center justify-center bg-surface-1 p-8" data-testid="browser-unavailable">
      <div className="max-w-md text-center">
        <Globe size={40} className="mx-auto text-fg-subtle" />
        <h2 className="mt-3 text-lg font-semibold">Browser im Server-Modus nicht verfügbar</h2>
        <p className="mt-2 text-sm text-fg-muted">
          Auf einem eigenen Server schützt RenOS sich mit einer strengen Sicherheitsrichtlinie: keine fremden Webseiten, keine Verbindungen zu anderen Servern. Den Browser gibt es
          deshalb in RenOS auf GitHub Pages (lokaler Modus).
        </p>
      </div>
    </div>
  );
}

export default function BrowserApp(props: AppProps) {
  return IS_LOCAL ? <LocalBrowser {...props} /> : <ServerModeNotice />;
}

function LocalBrowser({ windowId, payload }: AppProps) {
  const home = useSettings((s) => s.browserHome);
  const proxy = useSettings((s) => s.downloadProxy);
  const downloads = useDownloads((s) => s.items);
  const clearFinished = useDownloads((s) => s.clearFinished);
  const [history, setHistory] = useState<string[]>([]);
  const [index, setIndex] = useState(-1);
  const [input, setInput] = useState('');
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showDownloads, setShowDownloads] = useState(false);
  const [hintHidden, setHintHidden] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const current = index >= 0 ? (history[index] ?? null) : null;
  const running = downloads.filter((d) => d.state === 'running').length;

  const navigate = (raw: string) => {
    const url = normalizeUrl(raw);
    if (!url) {
      setError('Bitte eine Adresse wie „student-transfer.com“ oder „https://…“ eingeben.');
      return;
    }
    if (sameOriginAsRenos(url)) {
      setError('Seiten von RenOS selbst werden aus Sicherheitsgründen nicht im Browser geöffnet.');
      return;
    }
    setError(null);
    setHistory((h) => [...h.slice(0, index + 1), url]);
    setIndex((i) => i + 1);
    setInput(url);
  };

  // Aufruf mit Adresse (z. B. aus dem Terminal: „open https://…“).
  const payloadUrl = typeof payload?.url === 'string' ? payload.url : null;
  useEffect(() => {
    if (payloadUrl) navigate(payloadUrl);
    else if (home && index < 0) navigate(home);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur beim Öffnen bzw. bei neuer Adresse
  }, [payloadUrl, payload?.nonce]);

  useEffect(() => {
    let title = 'Browser';
    try {
      if (current) title = `${new URL(current).hostname} – Browser`;
    } catch {
      /* Titel bleibt */
    }
    useWindows.getState().setTitle(windowId, title);
  }, [current, windowId]);

  useShortcut({
    id: 'browser.address',
    keys: ['Mod+L'],
    scope: 'browser',
    group: 'Browser',
    description: 'Adressleiste',
    allowInInput: true,
    handler: () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  });
  useShortcut({ id: 'browser.reload', keys: ['Mod+R'], scope: 'browser', group: 'Browser', description: 'Neu laden', handler: () => setNonce((n) => n + 1) });

  return (
    <div className="flex h-full flex-col bg-surface-1" data-testid="browser">
      <WindowHeader>
        <IconButton icon={ArrowLeft} label="Zurück" size="sm" disabled={index <= 0} onClick={() => setIndex((i) => Math.max(0, i - 1))} />
        <IconButton icon={ArrowRight} label="Vor" size="sm" disabled={index >= history.length - 1} onClick={() => setIndex((i) => Math.min(history.length - 1, i + 1))} />
        <IconButton icon={RotateCw} label="Neu laden (⌘R)" size="sm" disabled={!current} onClick={() => setNonce((n) => n + 1)} />
        <IconButton
          icon={Home}
          label="Startseite"
          size="sm"
          onClick={() => {
            setIndex(-1);
            setInput('');
          }}
        />
      </WindowHeader>
      <form
        className="flex items-center gap-2 border-b border-line-soft px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(input);
        }}
      >
        <Globe size={16} className="shrink-0 text-fg-subtle" />
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          placeholder="Adresse eingeben, z. B. student-transfer.com"
          aria-label="Adresse"
          className="selectable h-8 min-w-0 flex-1 rounded-md border border-line-soft bg-surface-0 px-2.5 text-sm text-fg outline-none focus:border-accent"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
          data-testid="browser-address"
        />
        <Button size="sm" icon={Download} onClick={() => void openDownloadDialog(current ?? input)} data-testid="browser-download">
          Herunterladen
        </Button>
        <IconButton icon={ExternalLink} label="In Safari öffnen" size="sm" disabled={!current} onClick={() => current && window.open(current, '_blank', 'noopener')} />
        <span className="relative">
          <IconButton icon={ListChecks} label="Downloads" size="sm" active={showDownloads} onClick={() => setShowDownloads((v) => !v)} data-testid="browser-downloads" />
          {running ? <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent" /> : null}
        </span>
      </form>
      {error ? (
        <div className="bg-danger-soft px-3 py-1.5 text-sm text-danger" role="alert">
          {error}
        </div>
      ) : null}
      {current && !hintHidden ? (
        <div className="flex items-center gap-2 border-b border-line-soft bg-surface-0 px-3 py-1.5 text-xs text-fg-subtle">
          <span className="min-w-0 flex-1">Bleibt die Seite leer, erlaubt sie kein Einbetten – dann „In Safari öffnen“. Dateien lädst du mit „Herunterladen“ direkt nach RenOS.</span>
          <button type="button" className="text-accent hover:underline" onClick={() => current && window.open(current, '_blank', 'noopener')}>
            In Safari öffnen
          </button>
          <IconButton icon={X} label="Hinweis ausblenden" size="sm" onClick={() => setHintHidden(true)} />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 bg-white">
          {current ? (
            <iframe
              key={`${current}#${nonce}`}
              src={current}
              title="Webseite"
              className="h-full w-full border-0"
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
              referrerPolicy="strict-origin-when-cross-origin"
              data-testid="browser-frame"
            />
          ) : (
            <div className="scroll-area h-full overflow-auto bg-surface-1 p-8" data-testid="browser-home">
              <div className="mx-auto max-w-xl">
                <h2 className="text-xl font-semibold">Browser</h2>
                <p className="mt-2 text-sm text-fg-muted">
                  Webseiten ansehen und Dateien – z. B. Szenarien – direkt in RenOS laden. Heruntergeladenes liegt in Files → Downloads, und Spiele finden es in ihrer Dateiauswahl.
                </p>
                <div className="mt-5 flex flex-wrap gap-2">
                  {QUICK_LINKS.map((link) => (
                    <Button key={link.url} size="sm" icon={Globe} onClick={() => navigate(link.url)}>
                      {link.label}
                    </Button>
                  ))}
                  <Button size="sm" icon={Download} variant="primary" onClick={() => void openDownloadDialog('')}>
                    Datei-Link herunterladen …
                  </Button>
                </div>
                <div className="mt-6 rounded-lg border border-line-soft p-4 text-sm text-fg-muted">
                  <p className="font-medium text-fg">Gut zu wissen</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    <li>Viele Seiten (Google Drive, Mediafire, Foren) verbieten das Einbetten. Dann: „In Safari öffnen“.</li>
                    <li>Downloads klappen direkt, wenn der Server es Web-Apps erlaubt. Sonst die Datei in Safari laden und in Files importieren.</li>
                    <li>
                      {proxy ? 'Eigener Weiterleitungsdienst ist eingerichtet – er wird genutzt, wenn der direkte Weg scheitert.' : 'Optional: eigener Weiterleitungsdienst für Downloads von Seiten ohne Freigabe.'}{' '}
                      <button type="button" className="text-accent hover:underline" onClick={() => openApp('settings', { section: 'browser' })}>
                        <Settings2 size={12} className="mr-0.5 inline" />
                        Einstellungen
                      </button>
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>
        {showDownloads ? (
          <aside className="scroll-area flex w-72 shrink-0 flex-col overflow-auto border-l border-line-soft bg-surface-0" aria-label="Downloads">
            <div className="flex items-center justify-between px-3 py-2 text-sm font-medium">
              Downloads
              <div className="flex gap-1">
                <IconButton icon={FolderOpen} label="Ordner Downloads öffnen" size="sm" onClick={() => openFilesAt('downloads')} />
                <IconButton icon={X} label="Fertige entfernen" size="sm" onClick={clearFinished} />
              </div>
            </div>
            {downloads.length === 0 ? <p className="px-3 py-2 text-sm text-fg-subtle">Noch nichts heruntergeladen.</p> : null}
            <ul>
              {downloads.map((d) => (
                <DownloadRow key={d.id} item={d} />
              ))}
            </ul>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
