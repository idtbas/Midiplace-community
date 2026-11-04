/**
 * Plattform- und Darstellungsmodus-Erkennung.
 * Es werden ausschließlich standardisierte bzw. von Safari dokumentierte Signale verwendet –
 * keine vermeintliche Hardware-Erkennung des Magic Keyboards.
 */

declare global {
  interface Navigator {
    /** Safari auf iOS/iPadOS: true, wenn als Home-Bildschirm-Web-App gestartet. */
    standalone?: boolean;
  }
}

function media(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/** Läuft RenOS als installierte Web-App (Home-Bildschirm / Standalone-Fenster)? */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.navigator.standalone === true ||
    media('(display-mode: standalone)') ||
    media('(display-mode: fullscreen)') ||
    media('(display-mode: minimal-ui)')
  );
}

/** iOS/iPadOS-Gerät (iPadOS meldet sich als „Macintosh“ mit Touch-Unterstützung). */
export function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Kleiner Touch-Bildschirm (Smartphone). iPad mini hat eine kürzere Seite von 744 CSS-Pixeln. */
export function isPhone(): boolean {
  if (typeof window === 'undefined') return false;
  const shortSide = Math.min(window.screen.width, window.screen.height);
  return shortSide < 600 && (media('(pointer: coarse)') || navigator.maxTouchPoints > 0);
}

export function hasFinePointer(): boolean {
  return media('(any-pointer: fine)');
}

export function hasHover(): boolean {
  return media('(any-hover: hover)');
}

export function isPortrait(): boolean {
  return media('(orientation: portrait)');
}

export type AppMode = 'phone' | 'install' | 'desktop';

const BROWSER_MODE_KEY = 'renos.browserMode';

/** Entwickler-/Demo-Option: Desktop auch im normalen Browser-Tab öffnen. */
export function browserModeEnabled(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'desktop') {
      window.localStorage.setItem(BROWSER_MODE_KEY, '1');
      return true;
    }
    if (params.get('mode') === 'install') {
      window.localStorage.removeItem(BROWSER_MODE_KEY);
      return false;
    }
    return window.localStorage.getItem(BROWSER_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

export function enableBrowserMode(): void {
  try {
    window.localStorage.setItem(BROWSER_MODE_KEY, '1');
  } catch {
    /* Speicher nicht verfügbar */
  }
}

export function disableBrowserMode(): void {
  try {
    window.localStorage.removeItem(BROWSER_MODE_KEY);
  } catch {
    /* Speicher nicht verfügbar */
  }
}

export function detectMode(): AppMode {
  if (isPhone()) return 'phone';
  if (isStandalone()) return 'desktop';
  if (browserModeEnabled()) return 'desktop';
  return 'install';
}

/** Kurzbeschreibung des Browsers anhand des User-Agents (nur zur Anzeige). */
export function browserName(): string {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Microsoft Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/CriOS|Chrome\//.test(ua) && !/Edg\//.test(ua)) return 'Chrome / Chromium';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'Safari (WebKit)';
  if (/AppleWebKit/.test(ua)) return 'WebKit';
  return 'Unbekannter Browser';
}

export function displayModeLabel(): string {
  if (window.navigator.standalone === true || media('(display-mode: standalone)')) return 'Installierte Web-App (Standalone)';
  if (media('(display-mode: fullscreen)')) return 'Vollbild';
  return 'Browser-Tab';
}
