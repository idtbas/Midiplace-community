import { useEffect, useState } from 'react';
import { AlertTriangle, Monitor, PlusSquare, Share, Smartphone, SquareArrowOutUpRight } from 'lucide-react';
import { isAppleMobile } from '@/lib/platform';
import { Button } from '@/ui/Button';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Wird in Safari (ohne Installation) angezeigt. Erklärt das Hinzufügen zum Home-Bildschirm.
 * Es gibt keinen automatischen Installationsdialog in Safari – die Schritte erfolgen im Teilen-Menü.
 */
export function InstallPage({ onContinueInBrowser }: { onContinueInBrowser: () => void }) {
  const apple = isAppleMobile();
  const insecure = window.location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(window.location.hostname);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);

  // Nur Chromium-Browser bieten ein echtes Installationsereignis an; Safari nicht.
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  return (
    <div className="fixed inset-0 overflow-auto bg-desk text-fg" data-testid="install-page">
      <div
        className="absolute inset-0 opacity-60"
        style={{ backgroundImage: 'url("/wallpapers/daemmerung.jpg")', backgroundSize: 'cover', backgroundPosition: 'center' }}
        aria-hidden
      />
      <div className="absolute inset-0 bg-gradient-to-b from-desk/40 via-desk/70 to-desk" aria-hidden />
      <main className="relative mx-auto flex min-h-full max-w-[1180px] flex-col items-center gap-12 px-8 py-14 lg:flex-row lg:items-center lg:gap-16">
        <section className="w-full max-w-[460px] shrink-0">
          <img src="/icons/icon-192.png" alt="" className="h-20 w-20" />
          <h1 className="mt-6 text-3xl font-semibold tracking-tight">RenOS</h1>
          <p className="mt-2 text-lg text-fg-muted">Eine Desktop-Umgebung für dein iPad – mit Fenstern, Dock und einer Bibliothek für Ren’Py-Webspiele.</p>

          <div className="mt-8 rounded-xl border border-line-soft bg-surface-1/90 p-5">
            <h2 className="text-md font-semibold">So installierst du RenOS</h2>
            <ol className="mt-4 flex flex-col gap-4 text-base text-fg-muted">
              <Step n={1} icon={Share}>
                Tippe in Safari auf <strong className="text-fg">Teilen</strong> (Quadrat mit Pfeil nach oben). Je nach iPadOS-Version findest du es in
                der Adressleiste oder im Menü „…“.
              </Step>
              <Step n={2} icon={PlusSquare}>
                Wähle <strong className="text-fg">Zum Home-Bildschirm</strong>.
              </Step>
              <Step n={3} icon={SquareArrowOutUpRight}>
                Lass <strong className="text-fg">Als Web-App öffnen</strong> eingeschaltet, falls die Option erscheint, und tippe auf{' '}
                <strong className="text-fg">Hinzufügen</strong>.
              </Step>
              <Step n={4} icon={Monitor}>
                Starte RenOS über das neue Symbol auf dem Home-Bildschirm. Beim ersten Start führt dich eine kurze Einrichtung durch das System.
              </Step>
            </ol>
          </div>

          {insecure ? (
            <p className="mt-4 flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-sm text-warning">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              Diese Seite wird nicht über HTTPS geladen. Für die Installation als Web-App und für Offline-Funktionen ist HTTPS erforderlich.
            </p>
          ) : null}

          <p className="mt-4 text-sm text-fg-subtle">
            RenOS ersetzt iPadOS nicht. Es läuft als eigenständige Web-App in einem eigenen Fenster. Am besten im Querformat mit Magic Keyboard.
          </p>

          <div className="mt-6 flex flex-wrap gap-2">
            {installEvent ? (
              <Button
                variant="primary"
                onClick={async () => {
                  await installEvent.prompt();
                  setInstallEvent(null);
                }}
              >
                Als App installieren
              </Button>
            ) : null}
            {!apple ? (
              <Button variant={installEvent ? 'secondary' : 'primary'} onClick={onContinueInBrowser}>
                Im Browser öffnen (Entwicklung &amp; Demo)
              </Button>
            ) : null}
          </div>
          {apple ? (
            <p className="mt-4 flex items-center gap-2 text-xs text-fg-faint">
              <Smartphone size={13} /> Erkannt: Safari auf iPadOS/iOS
            </p>
          ) : null}
        </section>

        <DesktopPreview />
      </main>
    </div>
  );
}

function Step({ n, icon: Icon, children }: { n: number; icon: typeof Share; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-sm font-semibold text-fg">{n}</span>
      <span className="flex-1">{children}</span>
      <Icon size={18} strokeWidth={1.8} className="mt-0.5 shrink-0 text-fg-subtle" />
    </li>
  );
}

/** Nicht interaktive Vorschau des Desktops (reine Darstellung, keine Funktion). */
function DesktopPreview() {
  const icons = ['files', 'library', 'installer', 'notes', 'terminal', 'settings'];
  return (
    <figure className="pointer-events-none w-full max-w-[640px] select-none" aria-label="Vorschau des RenOS-Desktops">
      <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-line-soft shadow-[var(--shadow-window)]">
        <div className="absolute inset-0" style={{ backgroundImage: 'url("/wallpapers/daemmerung.jpg")', backgroundSize: 'cover' }} />
        <div className="absolute inset-x-0 top-0 flex h-[5%] items-center justify-between bg-[#0c0f14]/90 px-3 text-[9px] text-fg-muted">
          <span className="font-semibold text-fg">Anwendungen</span>
          <span>Di. 4. Nov. 10:30</span>
          <span>● ● ●</span>
        </div>
        <div className="absolute left-[9%] top-[13%] h-[62%] w-[64%] overflow-hidden rounded-lg border border-line-soft bg-surface-1 shadow-xl">
          <div className="flex h-[9%] items-center gap-1.5 border-b border-line-soft bg-surface-2 px-2">
            <img src="/icons/apps/library.png" alt="" className="h-3 w-3" />
            <span className="text-[8px] font-semibold">Library</span>
          </div>
          <div className="flex h-[91%]">
            <div className="w-[24%] border-r border-line-soft bg-surface-0 p-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="mb-1.5 h-2 rounded-sm bg-surface-3" style={{ width: `${80 - i * 15}%` }} />
              ))}
            </div>
            <div className="grid flex-1 grid-cols-3 gap-2 p-2.5">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="aspect-video rounded-sm bg-gradient-to-br from-surface-3 to-surface-2" />
              ))}
            </div>
          </div>
        </div>
        <div className="absolute right-[7%] top-[30%] h-[42%] w-[36%] overflow-hidden rounded-lg border border-line-soft bg-[#12161d] shadow-xl">
          <div className="flex h-[12%] items-center gap-1.5 border-b border-line-soft bg-surface-2 px-2">
            <img src="/icons/apps/terminal.png" alt="" className="h-3 w-3" />
            <span className="text-[8px] font-semibold">Terminal</span>
          </div>
          <div className="p-2 font-mono text-[7px] leading-relaxed text-fg-muted">
            <div>
              <span className="text-accent">user@renos</span>:~$ neofetch
            </div>
            <div>OS: RenOS 1.0.0</div>
            <div>Shell: rsh</div>
          </div>
        </div>
        <div className="absolute bottom-[3%] left-1/2 flex -translate-x-1/2 gap-1.5 rounded-lg border border-line-soft bg-surface-1/90 px-2 py-1.5">
          {icons.map((icon) => (
            <img key={icon} src={`/icons/apps/${icon}.png`} alt="" className="h-6 w-6" />
          ))}
        </div>
      </div>
      <figcaption className="mt-3 text-center text-sm text-fg-subtle">Vorschau – nach der Installation voll bedienbar</figcaption>
    </figure>
  );
}
