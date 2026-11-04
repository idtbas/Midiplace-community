import { Workbox } from 'workbox-window';
import { BASE_URL, asset } from '@/config';
import { notify } from '@/system/notifications';

/**
 * Service Worker: lädt die App-Shell vor, damit RenOS nach dem ersten Laden auch offline startet.
 * Updates werden nicht automatisch aktiviert – der Nutzer startet sie über eine Benachrichtigung.
 * Spiele (anderer Origin) und API-Antworten werden nie zwischengespeichert.
 */
let workbox: Workbox | null = null;
let registrationState: 'unsupported' | 'pending' | 'active' | 'failed' | 'dev' = 'pending';

export function serviceWorkerState(): typeof registrationState {
  return registrationState;
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) {
    registrationState = 'unsupported';
    return;
  }
  if (import.meta.env.DEV) {
    registrationState = 'dev';
    return;
  }
  workbox = new Workbox(asset('sw.js'), { scope: BASE_URL });
  workbox.addEventListener('waiting', () => {
    notify({
      kind: 'info',
      title: 'Update verfügbar',
      message: 'Eine neue Version von RenOS ist bereit. Offene Fenster werden nach dem Neustart wiederhergestellt.',
      duration: 60_000,
      action: {
        label: 'Jetzt aktualisieren',
        run: () => {
          workbox?.addEventListener('controlling', () => window.location.reload());
          workbox?.messageSkipWaiting();
        },
      },
    });
  });
  workbox
    .register()
    .then(() => {
      registrationState = 'active';
    })
    .catch(() => {
      registrationState = 'failed';
    });
}

/** Fragt dauerhaften Speicher an, damit iPadOS lokale Daten seltener entfernt (keine Garantie). */
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}
