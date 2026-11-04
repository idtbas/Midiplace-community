import { useEffect, useState } from 'react';
import { AppWindow, Database, Gamepad2, Info, Keyboard, LayoutPanelTop, Monitor, Palette, PanelBottom } from 'lucide-react';
import { t } from '@/i18n';
import { cn } from '@/lib/cn';
import type { AppProps } from '@/system/apps';
import { useWindows } from '@/system/windows';
import { AboutSection, AppearanceSection, DesktopSection, DockSection, GamesSection, KeyboardSection, StorageSection, WindowsSection } from './sections';

const SECTIONS = [
  { id: 'appearance', label: t.settings.sections.appearance, icon: Palette, component: AppearanceSection },
  { id: 'desktop', label: t.settings.sections.desktop, icon: Monitor, component: DesktopSection },
  { id: 'dock', label: t.settings.sections.dock, icon: PanelBottom, component: DockSection },
  { id: 'windows', label: t.settings.sections.windows, icon: AppWindow, component: WindowsSection },
  { id: 'keyboard', label: t.settings.sections.keyboard, icon: Keyboard, component: KeyboardSection },
  { id: 'storage', label: t.settings.sections.storage, icon: Database, component: StorageSection },
  { id: 'games', label: t.settings.sections.games, icon: Gamepad2, component: GamesSection },
  { id: 'about', label: t.settings.sections.about, icon: Info, component: AboutSection },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

function isSection(value: unknown): value is SectionId {
  return SECTIONS.some((s) => s.id === value);
}

export default function SettingsApp({ windowId, payload }: AppProps) {
  const [section, setSection] = useState<SectionId>(isSection(payload?.section) ? payload.section : 'appearance');

  // Abschnitt kann von außen gewählt werden (Launcher, Desktop-Kontextmenü).
  useEffect(() => {
    if (isSection(payload?.section)) setSection(payload.section);
  }, [payload?.section]);

  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  useEffect(() => {
    useWindows.getState().setTitle(windowId, `${current.label} – Settings`);
  }, [windowId, current.label]);

  const onNavKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const index = SECTIONS.findIndex((s) => s.id === section);
    const next = SECTIONS[(index + (e.key === 'ArrowDown' ? 1 : -1) + SECTIONS.length) % SECTIONS.length]!;
    setSection(next.id);
    (e.currentTarget.querySelector(`[data-section="${next.id}"]`) as HTMLElement | null)?.focus();
  };

  const Section = current.component;
  return (
    <div className="flex h-full">
      <nav className="flex w-[210px] shrink-0 flex-col gap-0.5 border-r border-line-soft bg-surface-0 p-2" aria-label="Kategorien" onKeyDown={onNavKey}>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            data-section={s.id}
            aria-current={section === s.id ? 'page' : undefined}
            onClick={() => setSection(s.id)}
            className={cn('flex h-9 items-center gap-2.5 rounded-md px-2.5 text-left text-base', section === s.id ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg')}
          >
            <s.icon size={16} strokeWidth={1.8} />
            {s.label}
          </button>
        ))}
        <div className="mt-auto flex items-center gap-2 px-2.5 py-2 text-xs text-fg-faint">
          <LayoutPanelTop size={12} /> RenOS
        </div>
      </nav>
      <div className="scroll-area min-w-0 flex-1 bg-surface-1">
        <div className="mx-auto max-w-[640px] px-8 py-6">
          <h2 className="mb-5 text-xl font-semibold">{current.label}</h2>
          <Section />
        </div>
      </div>
    </div>
  );
}
