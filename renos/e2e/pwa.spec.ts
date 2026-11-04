import { expect, test } from '@playwright/test';
import { openDesktop } from './helpers';

test.describe('PWA & Darstellungsmodi', () => {
  test('liefert ein gültiges Web-App-Manifest mit erreichbaren Icons', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.ok()).toBeTruthy();
    const manifest = await res.json();
    expect(manifest).toMatchObject({ name: 'RenOS', short_name: 'RenOS', display: 'standalone', start_url: '/?source=pwa', scope: '/', lang: 'de' });
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true);
    for (const icon of manifest.icons) {
      const img = await request.get(icon.src);
      expect(img.headers()['content-type']).toBe('image/png');
    }
    const touch = await request.get('/icons/apple-touch-icon.png');
    expect(touch.ok()).toBeTruthy();
  });

  test('index.html enthält die Apple-Metaangaben', async ({ request }) => {
    const html = await (await request.get('/')).text();
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('viewport-fit=cover');
    expect(html).toContain('rel="manifest"');
  });

  test('zeigt im normalen Browser-Tab die Installationsseite', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('install-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'So installierst du RenOS' })).toBeVisible();
    await expect(page.getByTestId('desktop')).toHaveCount(0);
  });

  test('startet im Standalone-Modus direkt den Desktop (Safari: navigator.standalone)', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(window.navigator, 'standalone', { value: true }));
    await page.goto('/?source=pwa');
    await expect(page.getByTestId('onboarding')).toBeVisible();
  });

  test('blendet auf iPad-Safari die Browser-Option aus', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1180, height: 820 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.addInitScript(() => Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 }));
    await page.goto('/');
    await expect(page.getByTestId('install-page')).toBeVisible();
    await expect(page.getByText('Erkannt: Safari auf iPadOS/iOS')).toBeVisible();
    await expect(page.getByRole('button', { name: /Im Browser öffnen/ })).toHaveCount(0);
    await context.close();
  });

  test('zeigt auf Smartphones einen Hinweis statt des Desktops', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, screen: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto('/?mode=desktop');
    await expect(page.getByTestId('phone-notice')).toBeVisible();
    await expect(page.getByText('RenOS ist für das iPad gemacht')).toBeVisible();
    await context.close();
  });

  test('registriert den Service Worker und startet offline', async ({ page, context }) => {
    await openDesktop(page);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // Warten, bis der Service Worker die Seite kontrolliert.
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('desktop')).toBeVisible();
    await expect(page.getByTestId('server-status')).toHaveAttribute('data-status', 'offline');
    // Apps, die den Server brauchen, zeigen einen verständlichen Offline-Zustand.
    await page.locator('[data-dock-item="library"]').click();
    await expect(page.getByText('Server nicht erreichbar')).toBeVisible();
    await context.setOffline(false);
  });
});
