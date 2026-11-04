import { Suspense, lazy, useEffect, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { AlertTriangle } from 'lucide-react';
import { enableBrowserMode, isStandalone, type AppMode } from '@/lib/platform';
import { db } from '@/persistence/db';
import { initFileSystem } from '@/persistence/fs';
import { requestPersistentStorage } from '@/pwa/register';
import { prefersReducedMotion, useSettings } from '@/system/settings';
import { clearSessionWindows } from '@/system/windows';
import { Button } from '@/ui/Button';
import { PhoneNotice } from './PhoneNotice';

// Getrennt geladen: Die Installationsseite braucht keinen Desktop-Code und umgekehrt.
const Desktop = lazy(() => import('@/desktop/Desktop').then((m) => ({ default: m.Desktop })));
const Onboarding = lazy(() => import('./Onboarding').then((m) => ({ default: m.Onboarding })));
const InstallPage = lazy(() => import('./InstallPage').then((m) => ({ default: m.InstallPage })));
import { useApplySettings } from './useApplySettings';

export function FatalScreen({ title, message }: { title: string; message: string }) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-desk p-8 text-fg" role="alert">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-xl bg-danger-soft text-danger">
          <AlertTriangle size={26} strokeWidth={1.7} />
        </div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-base text-fg-muted">{message}</p>
        <Button className="mt-6" variant="primary" onClick={() => window.location.reload()}>
          RenOS neu laden
        </Button>
      </div>
    </div>
  );
}

function DesktopBoot() {
  const [state, setState] = useState<'booting' | 'ready' | 'error'>('booting');
  const onboarded = useSettings((s) => s.onboardingCompleted);
  const [showOnboarding, setShowOnboarding] = useState(!onboarded);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await db.open();
        await initFileSystem();
        if (!useSettings.getState().restoreSession) clearSessionWindows();
        if (isStandalone()) void requestPersistentStorage();
        if (!cancelled) setState('ready');
      } catch (error) {
        console.error(error);
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onRerun = () => setShowOnboarding(true);
    window.addEventListener('renos:onboarding', onRerun);
    return () => window.removeEventListener('renos:onboarding', onRerun);
  }, []);

  if (state === 'error') {
    return (
      <FatalScreen
        title="Lokaler Speicher nicht verfügbar"
        message="RenOS konnte seine lokale Datenbank (IndexedDB) nicht öffnen. Das passiert z. B. im privaten Surfmodus oder wenn Website-Daten blockiert werden."
      />
    );
  }
  if (state === 'booting') return null;
  if (showOnboarding) return <Onboarding onDone={() => setShowOnboarding(false)} />;
  return <Desktop />;
}

export function Root({ initialMode }: { initialMode: AppMode }) {
  useApplySettings();
  const motion = useSettings((s) => s.motion);
  const [mode, setMode] = useState(initialMode);
  const reduced = prefersReducedMotion(motion);

  let content;
  if (mode === 'phone') content = <PhoneNotice />;
  else if (mode === 'install')
    content = (
      <InstallPage
        onContinueInBrowser={() => {
          enableBrowserMode();
          setMode('desktop');
        }}
      />
    );
  else content = <DesktopBoot />;

  // Während Teile nachladen, bleibt der CSS-Startbildschirm aus index.html sichtbar.
  return (
    <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
      <Suspense fallback={null}>{content}</Suspense>
    </MotionConfig>
  );
}
