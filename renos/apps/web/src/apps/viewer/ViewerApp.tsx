import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FolderOpen, ImageIcon, Maximize, Pause, Play, RotateCw, Wallpaper as WallpaperIcon, ZoomIn, ZoomOut } from 'lucide-react';
import { cn } from '@/lib/cn';
import { downloadBlob } from '@/lib/download';
import { formatBytes } from '@/lib/format';
import { kvSet, type FsNode } from '@/persistence/db';
import { getNode, listChildren, readBlob } from '@/persistence/fs';
import { CUSTOM_WALLPAPER_KEY } from '@/desktop/Wallpaper';
import { openFilesAt } from '@/system/actions';
import type { AppProps } from '@/system/apps';
import { fileKind } from '@/system/fileTypes';
import { notify } from '@/system/notifications';
import { useSettings } from '@/system/settings';
import { useShortcut } from '@/system/shortcuts';
import { useWindows } from '@/system/windows';
import { IconButton } from '@/ui/Button';
import { EmptyState, Spinner } from '@/ui/Feedback';
import { WindowHeader, useWindowContext } from '@/wm/WindowContext';

const ZOOMS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
const SLIDESHOW_MS = 4000;

export default function ViewerApp({ windowId, payload }: AppProps) {
  const { focused } = useWindowContext();
  const fileId = typeof payload?.fileId === 'string' ? payload.fileId : null;
  const [siblings, setSiblings] = useState<FsNode[]>([]);
  const [current, setCurrent] = useState<FsNode | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'empty'>(fileId ? 'loading' : 'empty');
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [rotation, setRotation] = useState(0);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [slideshow, setSlideshow] = useState(false);
  const blobRef = useRef<Blob | null>(null);

  // Datei und ihre Nachbarn (Bilder/PDFs im selben Ordner) laden.
  useEffect(() => {
    let cancelled = false;
    if (!fileId) {
      setState('empty');
      return undefined;
    }
    void (async () => {
      const node = await getNode(fileId);
      if (cancelled) return;
      if (!node || node.kind !== 'file') return setState('missing');
      const all = node.parentId ? await listChildren(node.parentId) : [node];
      const viewable = all.filter((n) => n.kind === 'file' && !n.trashed && (fileKind(n) === 'image' || fileKind(n) === 'pdf')).sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
      if (cancelled) return;
      setSiblings(viewable.length ? viewable : [node]);
      setCurrent(node);
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId, payload?.nonce]);

  // Aktuelle Datei als Objekt-URL bereitstellen.
  useEffect(() => {
    if (!current) return undefined;
    let objectUrl: string | null = null;
    let cancelled = false;
    setState('loading');
    setNatural(null);
    setZoom('fit');
    setRotation(0);
    void readBlob(current.id).then((blob) => {
      if (cancelled) return;
      if (!blob) return setState('missing');
      const typed = blob.type ? blob : new Blob([blob], { type: current.mime });
      blobRef.current = typed;
      objectUrl = URL.createObjectURL(typed);
      setUrl(objectUrl);
      setState('ready');
    });
    useWindows.getState().setTitle(windowId, `${current.name} – Bilder`);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [current, windowId]);

  const index = current ? siblings.findIndex((n) => n.id === current.id) : -1;
  const step = useCallback(
    (delta: number) => {
      if (siblings.length < 2) return;
      const next = siblings[(index + delta + siblings.length) % siblings.length];
      if (next) setCurrent(next);
    },
    [siblings, index],
  );

  useEffect(() => {
    if (!slideshow) return undefined;
    const timer = window.setInterval(() => step(1), SLIDESHOW_MS);
    return () => window.clearInterval(timer);
  }, [slideshow, step]);

  const zoomBy = (direction: 1 | -1) => {
    const now = zoom === 'fit' ? 1 : zoom;
    const next = direction > 0 ? ZOOMS.find((z) => z > now + 0.001) : [...ZOOMS].reverse().find((z) => z < now - 0.001);
    if (next) setZoom(next);
  };

  const setAsWallpaper = async () => {
    if (!blobRef.current) return;
    await kvSet(CUSTOM_WALLPAPER_KEY, blobRef.current);
    useSettings.getState().set('wallpaper', 'custom');
    window.dispatchEvent(new Event('renos:wallpaper-changed'));
    notify({ kind: 'success', title: 'Als Hintergrundbild festgelegt.', transient: true });
  };

  const isPdf = current ? fileKind(current) === 'pdf' : false;
  const scope = { scope: 'viewer' as const, group: 'Bilder', enabled: focused };
  useShortcut({ id: `viewer.next.${windowId}`, keys: ['ArrowRight', 'PageDown'], description: 'Nächstes Bild', ...scope, handler: () => step(1) });
  useShortcut({ id: `viewer.prev.${windowId}`, keys: ['ArrowLeft', 'PageUp'], description: 'Vorheriges Bild', ...scope, handler: () => step(-1) });
  // Zoom über das Zeichen (+, −, 0) – unabhängig vom Tastaturlayout.
  useEffect(() => {
    if (!focused) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '+' || e.key === '=') zoomBy(1);
      else if (e.key === '-') zoomBy(-1);
      else if (e.key === '0') setZoom('fit');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useShortcut({ id: `viewer.rotate.${windowId}`, keys: 'R', description: 'Drehen', ...scope, handler: () => setRotation((r) => (r + 90) % 360) });
  useShortcut({ id: `viewer.slideshow.${windowId}`, keys: 'Space', description: 'Diashow', ...scope, handler: () => setSlideshow((v) => !v) });

  const info = useMemo(() => {
    if (!current) return '';
    const parts = [formatBytes(current.size)];
    if (natural) parts.unshift(`${natural.w} × ${natural.h}`);
    if (siblings.length > 1) parts.push(`${index + 1} von ${siblings.length}`);
    return parts.join(' · ');
  }, [current, natural, siblings.length, index]);

  if (state === 'empty') {
    return (
      <EmptyState icon={ImageIcon} title="Kein Bild geöffnet" className="h-full bg-surface-1" actions={<button type="button" className="text-accent underline" onClick={() => openFilesAt('pictures')}>Bilder in Files öffnen</button>}>
        Öffne ein Bild oder eine PDF-Datei aus Files oder vom Schreibtisch.
      </EmptyState>
    );
  }
  if (state === 'missing') return <EmptyState icon={ImageIcon} title="Datei nicht gefunden" className="h-full bg-surface-1">Die Datei wurde gelöscht oder verschoben.</EmptyState>;

  return (
    <div className="flex h-full flex-col bg-[#0b0d11]" data-testid="viewer">
      <WindowHeader>
        <IconButton icon={ChevronLeft} label="Vorheriges (←)" size="sm" disabled={siblings.length < 2} onClick={() => step(-1)} />
        <IconButton icon={ChevronRight} label="Nächstes (→)" size="sm" disabled={siblings.length < 2} onClick={() => step(1)} data-testid="viewer-next" />
        {!isPdf ? (
          <>
            <IconButton icon={ZoomOut} label="Verkleinern (−)" size="sm" onClick={() => zoomBy(-1)} />
            <IconButton icon={ZoomIn} label="Vergrößern (+)" size="sm" onClick={() => zoomBy(1)} />
            <IconButton icon={Maximize} label="Einpassen (0)" size="sm" active={zoom === 'fit'} onClick={() => setZoom('fit')} />
            <IconButton icon={RotateCw} label="Drehen (R)" size="sm" onClick={() => setRotation((r) => (r + 90) % 360)} />
            <IconButton icon={slideshow ? Pause : Play} label="Diashow (Leertaste)" size="sm" active={slideshow} disabled={siblings.length < 2} onClick={() => setSlideshow((v) => !v)} />
            <IconButton icon={WallpaperIcon} label="Als Hintergrundbild" size="sm" onClick={() => void setAsWallpaper()} data-testid="viewer-wallpaper" />
          </>
        ) : null}
        <IconButton icon={Download} label="Exportieren" size="sm" onClick={() => blobRef.current && current && downloadBlob(blobRef.current, current.name)} />
      </WindowHeader>
      <div
        className={cn('relative min-h-0 flex-1', zoom === 'fit' ? 'overflow-hidden' : 'scroll-area overflow-auto')}
        onWheel={(e) => {
          if (!e.ctrlKey && !e.metaKey) return;
          e.preventDefault();
          zoomBy(e.deltaY < 0 ? 1 : -1);
        }}
        onDoubleClick={() => setZoom((z) => (z === 'fit' ? 1 : 'fit'))}
      >
        {state === 'loading' || !url ? (
          <div className="flex h-full items-center justify-center">
            <Spinner size={20} />
          </div>
        ) : isPdf ? (
          <object data={url} type="application/pdf" className="h-full w-full" aria-label={current?.name}>
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-white/70">
              Dieser Browser zeigt PDFs hier nicht an.
              <button type="button" className="rounded-md bg-white/10 px-3 py-1.5 hover:bg-white/20" onClick={() => blobRef.current && current && downloadBlob(blobRef.current, current.name)}>
                PDF öffnen / sichern
              </button>
            </div>
          </object>
        ) : (
          <div className={cn('flex min-h-full min-w-full items-center justify-center p-4', zoom === 'fit' && 'h-full')}>
            <img
              src={url}
              alt={current?.name ?? ''}
              draggable={false}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              className={cn('select-none transition-transform duration-150', zoom === 'fit' && 'max-h-full max-w-full object-contain')}
              style={{
                transform: `rotate(${rotation}deg)`,
                ...(zoom !== 'fit' && natural ? { width: natural.w * zoom, height: natural.h * zoom, maxWidth: 'none' } : {}),
              }}
              data-testid="viewer-image"
            />
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-white/10 px-3 py-1 text-xs text-white/60">
        <span className="truncate" data-testid="viewer-name">
          {current?.name}
        </span>
        <span className="tabular">{info}</span>
        <div className="flex-1" />
        {!isPdf ? <span className="tabular">{zoom === 'fit' ? 'Eingepasst' : `${Math.round(zoom * 100)} %`}</span> : null}
        {current?.parentId ? (
          <button type="button" className="flex items-center gap-1 hover:text-white" onClick={() => openFilesAt(current.parentId!)}>
            <FolderOpen size={12} /> In Files zeigen
          </button>
        ) : null}
      </div>
    </div>
  );
}
