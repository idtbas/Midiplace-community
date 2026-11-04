import { useEffect, useState } from 'react';
import { kvGet } from '@/persistence/db';
import { WALLPAPERS, useSettings } from '@/system/settings';

export const CUSTOM_WALLPAPER_KEY = 'wallpaper.custom';

/** Liefert die URL des aktuellen Hintergrunds (eigene Bilder liegen als Blob in IndexedDB). */
export function useWallpaperUrl(): string | null {
  const wallpaper = useSettings((s) => s.wallpaper);
  const [customUrl, setCustomUrl] = useState<string | null>(null);
  useEffect(() => {
    if (wallpaper !== 'custom') return undefined;
    let url: string | null = null;
    let cancelled = false;
    void kvGet<Blob>(CUSTOM_WALLPAPER_KEY).then((blob) => {
      if (cancelled || !(blob instanceof Blob)) return;
      url = URL.createObjectURL(blob);
      setCustomUrl(url);
    });
    const onChange = () => {
      void kvGet<Blob>(CUSTOM_WALLPAPER_KEY).then((blob) => {
        if (cancelled || !(blob instanceof Blob)) return;
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(blob);
        setCustomUrl(url);
      });
    };
    window.addEventListener('renos:wallpaper-changed', onChange);
    return () => {
      cancelled = true;
      window.removeEventListener('renos:wallpaper-changed', onChange);
      if (url) URL.revokeObjectURL(url);
    };
  }, [wallpaper]);
  if (wallpaper === 'solid') return null;
  if (wallpaper === 'custom') return customUrl;
  return WALLPAPERS[wallpaper]?.src ?? WALLPAPERS.daemmerung.src;
}

export function Wallpaper() {
  const url = useWallpaperUrl();
  const dim = useSettings((s) => s.wallpaperDim);
  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden>
      <div
        className="absolute inset-0"
        style={
          url
            ? { backgroundImage: `url("${url}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
            : { background: 'radial-gradient(120% 90% at 70% 20%, #1d2533 0%, #141922 55%, #10141b 100%)' }
        }
      />
      {dim > 0 ? <div className="absolute inset-0 bg-black" style={{ opacity: dim }} /> : null}
    </div>
  );
}
