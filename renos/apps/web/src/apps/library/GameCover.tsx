import { useState } from 'react';
import type { Game } from '@renos/shared';
import { cn } from '@/lib/cn';

/** Deterministischer, ruhiger Farbton aus dem Titel – für Spiele ohne Cover (keine erfundenen Bilder). */
function hueFor(title: string): number {
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function initials(title: string): string {
  const words = title.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : title.slice(0, 2)).toUpperCase();
}

export function GameCover({ game, className, large }: { game: Pick<Game, 'title' | 'coverUrl'>; className?: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (game.coverUrl && !failed) {
    return <img src={game.coverUrl} alt="" draggable={false} onError={() => setFailed(true)} className={cn('h-full w-full object-cover', className)} />;
  }
  const hue = hueFor(game.title);
  return (
    <div
      className={cn('flex h-full w-full items-center justify-center', className)}
      style={{ background: `linear-gradient(140deg, hsl(${hue} 22% 26%), hsl(${(hue + 40) % 360} 18% 16%))` }}
      aria-hidden
    >
      <span className={cn('font-semibold tracking-wide text-white/70', large ? 'text-3xl' : 'text-xl')}>{initials(game.title)}</span>
    </div>
  );
}
