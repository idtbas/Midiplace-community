import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Keyboard, MousePointer2, PanelBottom, Upload } from 'lucide-react';
import { t } from '@/i18n';
import { cn } from '@/lib/cn';
import { Wallpaper } from '@/desktop/Wallpaper';
import { ACCENTS, useSettings, type AccentId } from '@/system/settings';
import { formatCombo } from '@/system/shortcuts';
import { Button } from '@/ui/Button';
import { Kbd } from '@/ui/Feedback';
import { IS_LOCAL, asset } from '@/config';

const STEPS = 5;

/** Kurzer Einrichtungsassistent beim ersten Start. Kann später in den Einstellungen erneut geöffnet werden. */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const { accent, set, patch } = useSettings();

  const finish = () => {
    patch({ onboardingCompleted: true });
    onDone();
  };

  const content = [
    <div key="welcome" className="text-center">
      <img src={asset('icons/icon-192.png')} alt="" className="mx-auto h-24 w-24" draggable={false} />
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">Willkommen bei RenOS</h1>
      <p className="mx-auto mt-3 max-w-md text-md text-fg-muted">
        Eine ruhige Desktop-Umgebung für dein iPad – mit Fenstern, Dock und einer Bibliothek für deine Ren’Py-Spiele.
      </p>
    </div>,
    <div key="look">
      <h2 className="text-2xl font-semibold">Erscheinungsbild</h2>
      <p className="mt-2 text-base text-fg-muted">Wähle eine Akzentfarbe. Sie wird sparsam für Auswahl und Fokus verwendet und lässt sich jederzeit ändern.</p>
      <div className="mt-6 grid grid-cols-3 gap-3">
        {(Object.keys(ACCENTS) as AccentId[]).map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={accent === id}
            onClick={() => set('accent', id)}
            className={cn(
              'flex items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors',
              accent === id ? 'border-accent bg-accent-softer' : 'border-line-soft bg-surface-2/60 hover:bg-surface-3/60',
            )}
          >
            <span className="h-6 w-6 rounded-full" style={{ background: ACCENTS[id].value }} />
            <span className="text-base">{ACCENTS[id].label}</span>
            {accent === id ? <Check size={16} className="ml-auto text-accent" /> : null}
          </button>
        ))}
      </div>
    </div>,
    <div key="usage">
      <h2 className="text-2xl font-semibold">Bedienung</h2>
      <ul className="mt-5 flex flex-col gap-4">
        <Tip icon={PanelBottom} title="Dock">
          Unten findest du deine Anwendungen. Ein Punkt zeigt laufende Apps. Rechtsklick oder langes Drücken öffnet weitere Optionen.
        </Tip>
        <Tip icon={MousePointer2} title="Fenster & Trackpad">
          Fenster an der Titelleiste verschieben, an Rändern und Ecken in der Größe ändern. An den linken oder rechten Rand ziehen, um sie
          einzurasten. Zwei-Finger-Klick öffnet Kontextmenüs.
        </Tip>
        <Tip icon={Keyboard} title="Tastatur">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Kbd>{formatCombo('Alt+Space')}</Kbd> Suche · <Kbd>{formatCombo('Alt+Tab')}</Kbd> Fenster wechseln · <Kbd>{formatCombo('Alt+W')}</Kbd> schließen ·{' '}
            <Kbd>{formatCombo('Alt+,')}</Kbd> Einstellungen
          </span>
          <span className="mt-1 block text-sm text-fg-subtle">iPadOS kann einzelne Tastenkombinationen für sich reservieren.</span>
        </Tip>
      </ul>
    </div>,
    <div key="library">
      <h2 className="text-2xl font-semibold">Deine Spielebibliothek</h2>
      <p className="mt-2 text-base text-fg-muted">RenOS startet Ren’Py-Spiele, die als <strong className="text-fg">Web-Build</strong> erstellt wurden.</p>
      <ol className="mt-5 flex flex-col gap-3 text-base text-fg-muted">
        {t.library.howToSteps.map((s, i) => (
          <li key={s} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-sm font-semibold text-fg">{i + 1}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      <p className="mt-5 flex items-start gap-2 text-sm text-fg-subtle">
        <Upload size={15} className="mt-0.5 shrink-0" />
        {IS_LOCAL
          ? 'Spiele werden direkt auf diesem iPad installiert – auch große mit mehreren Gigabyte, solange Speicher frei ist. Zum Spielen richtest du einmalig einen kostenlosen Spiele-Host ein (Settings → Spiele).'
          : 'Für Installation und Verwaltung meldest du dich mit dem Owner-Passwort deines RenOS-Servers an.'}{' '}
        Windows- oder Mac-Versionen eines Spiels laufen im Browser nicht.
      </p>
    </div>,
    <div key="start" className="text-center">
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-3xl bg-accent-soft text-accent">
        <Check size={38} strokeWidth={1.8} />
      </div>
      <h2 className="mt-6 text-2xl font-semibold">Alles bereit</h2>
      <p className="mx-auto mt-2 max-w-md text-base text-fg-muted">
        Die Einführung kannst du jederzeit unter Settings → Systeminformationen erneut öffnen.
      </p>
    </div>,
  ];

  return (
    <div className="os-chrome fixed inset-0 overflow-hidden bg-desk" data-testid="onboarding">
      <Wallpaper />
      <div className="absolute inset-0 bg-black/35" />
      <div className="relative flex h-full items-center justify-center p-6">
        <div className="panel-surface flex w-full max-w-[620px] flex-col rounded-2xl p-8" role="dialog" aria-label="Einrichtung">
          <div className="min-h-[340px]">
            <AnimatePresence mode="wait">
              <motion.div key={step} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.18 }}>
                {content[step]}
              </motion.div>
            </AnimatePresence>
          </div>
          <div className="mt-6 flex items-center justify-between">
            <div className="flex gap-1.5" aria-label={`Schritt ${step + 1} von ${STEPS}`}>
              {Array.from({ length: STEPS }, (_, i) => (
                <span key={i} className={cn('h-1.5 rounded-full transition-all', i === step ? 'w-5 bg-accent' : 'w-1.5 bg-surface-4')} />
              ))}
            </div>
            <div className="flex gap-2">
              {step === 0 ? (
                <Button variant="ghost" onClick={finish}>
                  {t.onboarding.skip}
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => setStep(step - 1)}>
                  {t.system.back}
                </Button>
              )}
              {step < STEPS - 1 ? (
                <Button variant="primary" onClick={() => setStep(step + 1)} autoFocus>
                  {t.system.next}
                </Button>
              ) : (
                <Button variant="primary" onClick={finish} autoFocus>
                  {t.onboarding.start}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Tip({ icon: Icon, title, children }: { icon: typeof Keyboard; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-fg-muted">
        <Icon size={19} strokeWidth={1.8} />
      </span>
      <div>
        <div className="text-md font-medium">{title}</div>
        <div className="mt-0.5 text-base text-fg-muted">{children}</div>
      </div>
    </li>
  );
}
