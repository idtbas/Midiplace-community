import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { isAppleMobile } from '@/lib/platform';
import { Button } from '@/ui/Button';

/** Empfiehlt auf iPads im Hochformat das Querformat. Lässt sich für die Sitzung ausblenden. */
export function OrientationHint() {
  const [portrait, setPortrait] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem('renos.portraitDismissed') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const query = window.matchMedia('(orientation: portrait)');
    const touchDevice = isAppleMobile() || navigator.maxTouchPoints > 1;
    const update = () => setPortrait(touchDevice && query.matches && window.innerWidth < 1100);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  if (!portrait || dismissed) return null;
  return (
    <div className="os-chrome fixed inset-0 flex items-center justify-center bg-desk/92 p-8" style={{ zIndex: 9800 }} role="dialog" aria-label="Querformat empfohlen">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-2 text-accent">
          <RotateCcw size={30} strokeWidth={1.6} />
        </div>
        <h2 className="text-xl font-semibold">Querformat empfohlen</h2>
        <p className="mt-2 text-base text-fg-muted">
          RenOS ist für das iPad im Querformat mit Magic Keyboard gestaltet. Drehe das iPad, damit Fenster, Dock und Spiele genug Platz haben.
        </p>
        <Button
          className="mt-6"
          onClick={() => {
            setDismissed(true);
            try {
              sessionStorage.setItem('renos.portraitDismissed', '1');
            } catch {
              /* ignorieren */
            }
          }}
        >
          Trotzdem fortfahren
        </Button>
      </div>
    </div>
  );
}
