import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ACCENTS, useSettings, type Settings } from '@/system/settings';

const LIGHT_QUERY = '(prefers-color-scheme: light)';

/** Tatsächlich verwendetes Erscheinungsbild („system“ folgt iPadOS). */
export function useEffectiveTheme(): 'dark' | 'light' {
  const theme = useSettings((s) => s.theme);
  const [systemLight, setSystemLight] = useState(() => typeof window !== 'undefined' && Boolean(window.matchMedia?.(LIGHT_QUERY).matches));
  useEffect(() => {
    const query = window.matchMedia?.(LIGHT_QUERY);
    if (!query) return undefined;
    const update = () => setSystemLight(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return resolveTheme(theme, systemLight);
}

export function resolveTheme(theme: Settings['theme'], systemLight: boolean): 'dark' | 'light' {
  if (theme === 'system') return systemLight ? 'light' : 'dark';
  return theme;
}

/** Akzentfarbe für das Erscheinungsbild: Im hellen Design etwas dunkler, damit Schrift und Symbole lesbar bleiben. */
export function accentFor(value: string, theme: 'dark' | 'light'): string {
  return theme === 'light' ? `color-mix(in srgb, ${value} 64%, #1b2330)` : value;
}

/** Überträgt Darstellungseinstellungen auf das Dokument (CSS-Variablen und Datenattribute). */
export function useApplySettings(): void {
  const { accent, motion, transparency, uiScale } = useSettings(
    useShallow((s) => ({ accent: s.accent, motion: s.motion, transparency: s.transparency, uiScale: s.uiScale })),
  );
  const theme = useEffectiveTheme();
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--accent', accentFor(ACCENTS[accent]?.value ?? ACCENTS.blau.value, theme));
    root.style.setProperty('--ui-scale', String(uiScale));
    if (motion === 'system') delete root.dataset.motion;
    else root.dataset.motion = motion;
    root.dataset.transparency = transparency ? 'on' : 'off';
    root.dataset.theme = theme;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  }, [accent, motion, transparency, uiScale, theme]);
}
