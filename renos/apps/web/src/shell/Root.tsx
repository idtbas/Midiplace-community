import { useEffect, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { AlertTriangle } from 'lucide-react';
import { enableBrowserMode, isStandalone, type AppMode } from '@/lib/platform';
import { db } from '@/persistence/db';
import { initFileSystem } from '@/persistence/fs';
import { requestPersistentStorage } from '@/pwa/register';
import { prefersReducedMotion, useSettings } from '@/system/settings';
import { clearSessionWindows } from '@/system/windows';
import { Desktop } from '@/desktop/Desktop';
import { Button } from '@/ui/Button';
import { InstallPage } from './InstallPage';
import { Onboarding } from './Onboarding';
import { PhoneNotice } from './PhoneNotice';
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

  return <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>{content}</MotionConfig>;
}
