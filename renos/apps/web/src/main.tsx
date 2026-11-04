import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/index.css';
import { detectMode } from '@/lib/platform';
import { registerServiceWorker } from '@/pwa/register';
import { ErrorBoundary } from '@/shell/ErrorBoundary';
import { FatalScreen, Root } from '@/shell/Root';

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing');

registerServiceWorker();

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary
      fallback={(error) => (
        <FatalScreen title="RenOS wurde unerwartet beendet" message={`Ein Fehler in der Oberfläche ist aufgetreten (${error.message}). Deine Daten sind lokal gespeichert.`} />
      )}
    >
      <Root initialMode={detectMode()} />
    </ErrorBoundary>
  </StrictMode>,
);
