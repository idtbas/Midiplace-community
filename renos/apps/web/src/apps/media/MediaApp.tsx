import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, ListMusic, Music, Repeat, Repeat1, Shuffle, SkipBack, SkipForward } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import type { FsNode } from '@/persistence/db';
import { getNode, listChildren, readBlob } from '@/persistence/fs';
import { openFilesAt } from '@/system/actions';
import type { AppProps } from '@/system/apps';
import { fileKind } from '@/system/fileTypes';
import { useWindows } from '@/system/windows';
import { IconButton } from '@/ui/Button';
import { EmptyState } from '@/ui/Feedback';
import { WindowHeader, useWindowContext } from '@/wm/WindowContext';

type RepeatMode = 'off' | 'all' | 'one';

function isMedia(node: FsNode): boolean {
  const kind = fileKind(node);
  return node.kind === 'file' && !node.trashed && (kind === 'audio' || kind === 'video');
}

export default function MediaApp({ windowId, payload }: AppProps) {
  const { focused } = useWindowContext();
  const fileId = typeof payload?.fileId === 'string' ? payload.fileId : null;
  const [playlist, setPlaylist] = useState<FsNode[]>([]);
  const [current, setCurrent] = useState<FsNode | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repeat, setRepeat] = useState<RepeatMode>('all');
  const [shuffle, setShuffle] = useState(false);
  const [showList, setShowList] = useState(true);
  const mediaRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let cancelled = false;
    if (!fileId) return undefined;
    void (async () => {
      const node = await getNode(fileId);
      if (cancelled || !node) return;
      const siblings = node.parentId ? (await listChildren(node.parentId)).filter(isMedia) : [node];
      siblings.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
      if (cancelled) return;
      setPlaylist(siblings.length ? siblings : [node]);
      setCurrent(node);
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId, payload?.nonce]);

  useEffect(() => {
    if (!current) return undefined;
    let objectUrl: string | null = null;
    let cancelled = false;
    setError(null);
    void readBlob(current.id).then((blob) => {
      if (cancelled) return;
      if (!blob) return setError('Datei nicht gefunden.');
      objectUrl = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: current.mime }));
      setUrl(objectUrl);
    });
    useWindows.getState().setTitle(windowId, `${current.name} – Medien`);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [current, windowId]);

  // Neue Quelle: abspielen (Autoplay ist nach einer Nutzeraktion – Öffnen – erlaubt).
  useEffect(() => {
    const el = mediaRef.current;
    if (!el || !url) return;
    el.load();
    void el.play().catch(() => undefined);
  }, [url]);

  const index = current ? playlist.findIndex((n) => n.id === current.id) : -1;
  const go = useCallback(
    (delta: number, fromEnd = false) => {
      if (!playlist.length) return;
      if (fromEnd && repeat === 'one') {
        const el = mediaRef.current;
        if (el) {
          el.currentTime = 0;
          void el.play();
        }
        return;
      }
      let next: number;
      if (shuffle && playlist.length > 1) {
        do next = Math.floor(Math.random() * playlist.length);
        while (next === index);
      } else next = index + delta;
      if (next >= playlist.length || next < 0) {
        if (fromEnd && repeat === 'off') return;
        next = (next + playlist.length) % playlist.length;
      }
      setCurrent(playlist[next]!);
    },
    [playlist, index, repeat, shuffle],
  );

  useEffect(() => {
    if (!focused) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const el = mediaRef.current;
      if (!el || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement)?.tagName === 'VIDEO') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (el.paused) void el.play();
        else el.pause();
      } else if (e.key === 'ArrowRight') el.currentTime = Math.min(el.duration || 0, el.currentTime + 5);
      else if (e.key === 'ArrowLeft') el.currentTime = Math.max(0, el.currentTime - 5);
      else if (e.key === 'n' || e.key === 'N') go(1);
      else if (e.key === 'p' || e.key === 'P') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, go]);

  if (!fileId) {
    return (
      <EmptyState
        icon={Music}
        title="Nichts geöffnet"
        className="h-full bg-surface-1"
        actions={
          <button type="button" className="text-accent underline" onClick={() => openFilesAt('home')}>
            Files öffnen
          </button>
        }
      >
        Öffne Musik oder Videos (MP3, OGG, Opus, WAV, M4A, MP4, WebM …) aus Files oder vom Schreibtisch.
      </EmptyState>
    );
  }

  const isVideo = current ? fileKind(current) === 'video' : false;
  const RepeatIcon = repeat === 'one' ? Repeat1 : Repeat;

  return (
    <div className="flex h-full flex-col bg-surface-1" data-testid="media">
      <WindowHeader>
        <IconButton icon={SkipBack} label="Vorheriger Titel (P)" size="sm" onClick={() => go(-1)} disabled={playlist.length < 2} />
        <IconButton icon={SkipForward} label="Nächster Titel (N)" size="sm" onClick={() => go(1)} disabled={playlist.length < 2} data-testid="media-next" />
        <IconButton icon={Shuffle} label="Zufällige Reihenfolge" size="sm" active={shuffle} onClick={() => setShuffle((v) => !v)} />
        <IconButton
          icon={RepeatIcon}
          label={repeat === 'off' ? 'Wiederholen: aus' : repeat === 'all' ? 'Wiederholen: alle' : 'Wiederholen: Titel'}
          size="sm"
          active={repeat !== 'off'}
          onClick={() => setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'))}
        />
        <IconButton icon={ListMusic} label="Wiedergabeliste" size="sm" active={showList} onClick={() => setShowList((v) => !v)} />
      </WindowHeader>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col bg-black">
          <div className="relative flex min-h-0 flex-1 items-center justify-center">
            {!isVideo ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-white/80">
                <div className="flex h-32 w-32 items-center justify-center rounded-2xl bg-gradient-to-br from-white/15 to-white/5">
                  <Music size={56} strokeWidth={1.4} />
                </div>
                <div className="mt-4 max-w-[80%] truncate text-lg font-medium" data-testid="media-title">
                  {current?.name}
                </div>
              </div>
            ) : null}
            <video
              ref={mediaRef}
              src={url ?? undefined}
              controls
              playsInline
              onEnded={() => go(1, true)}
              onError={() => setError('Dieses Format kann der Browser nicht abspielen.')}
              className={cn('max-h-full max-w-full', !isVideo && 'absolute inset-x-4 bottom-4 h-12 w-[calc(100%-2rem)] max-w-none')}
              data-testid="media-element"
            />
          </div>
          {error ? <div className="bg-danger-soft px-3 py-1.5 text-sm text-danger">{error}</div> : null}
        </div>
        {showList ? (
          <div className="scroll-area w-60 shrink-0 overflow-auto border-l border-line-soft bg-surface-0" aria-label="Wiedergabeliste">
            {playlist.map((n, i) => (
              <button
                key={n.id}
                type="button"
                onClick={() => setCurrent(n)}
                className={cn('flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2', n.id === current?.id ? 'text-accent' : 'text-fg-muted')}
              >
                <span className="tabular w-5 shrink-0 text-xs text-fg-faint">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">{n.name}</span>
                <span className="tabular shrink-0 text-xs text-fg-faint">{formatBytes(n.size)}</span>
              </button>
            ))}
            {current?.parentId ? (
              <button type="button" className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-fg-subtle hover:text-fg" onClick={() => openFilesAt(current.parentId!)}>
                <FolderOpen size={12} /> Ordner in Files zeigen
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
