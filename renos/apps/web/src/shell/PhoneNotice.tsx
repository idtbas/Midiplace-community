import { Tablet } from 'lucide-react';
import { asset } from '@/config';

/** Auf Smartphones wird RenOS nicht gestartet – die Oberfläche ist für iPad-Bildschirme gestaltet. */
export function PhoneNotice() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-desk p-8 text-center text-fg" data-testid="phone-notice">
      <div className="max-w-xs">
        <img src={asset('icons/icon-192.png')} alt="" className="mx-auto h-16 w-16" />
        <h1 className="mt-6 text-xl font-semibold">RenOS ist für das iPad gemacht</h1>
        <p className="mt-3 text-base text-fg-muted">
          Fenster, Dock und Spiele brauchen einen großen Bildschirm. Öffne diese Seite auf einem iPad – am besten im Querformat mit Magic Keyboard.
        </p>
        <div className="mx-auto mt-8 flex h-12 w-12 items-center justify-center rounded-xl bg-surface-2 text-fg-subtle">
          <Tablet size={22} strokeWidth={1.7} />
        </div>
      </div>
    </div>
  );
}
