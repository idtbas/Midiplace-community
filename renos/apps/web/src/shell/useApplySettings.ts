import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ACCENTS, useSettings } from '@/system/settings';

/** Überträgt Darstellungseinstellungen auf das Dokument (CSS-Variablen und Datenattribute). */
export function useApplySettings(): void {
  const { accent, motion, transparency, uiScale } = useSettings(
    useShallow((s) => ({ accent: s.accent, motion: s.motion, transparency: s.transparency, uiScale: s.uiScale })),
  );
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--accent', ACCENTS[accent]?.value ?? ACCENTS.blau.value);
    root.style.setProperty('--ui-scale', String(uiScale));
    if (motion === 'system') delete root.dataset.motion;
    else root.dataset.motion = motion;
    root.dataset.transparency = transparency ? 'on' : 'off';
  }, [accent, motion, transparency, uiScale]);
}
