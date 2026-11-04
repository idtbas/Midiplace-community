import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Frame, type Page } from '@playwright/test';
import { chooseFile, webBuildEntries, windowOf, writeZip } from '../helpers';

/**
 * Lokaler Modus (RenOS ohne Server, wie auf GitHub Pages):
 * Spiele werden im OPFS von RenOS installiert und über den statischen Spiele-Host (zweiter Origin) ausgeführt.
 */
const HOST = 'http://localhost:4321/renos-games/';
const HOST_ORIGIN = 'http://localhost:4321';
const BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/generated/RenOSTestspiel-1.0-web.zip');

async function openDesktop(page: Page, withHost = true) {
  await page.addInitScript(
    ([host, withHostFlag]) => {
      if (!localStorage.getItem('renos.settings')) {
        localStorage.setItem('renos.settings', JSON.stringify({ state: { onboardingCompleted: true, gameHostUrl: withHostFlag ? host : '' }, version: 1 }));
      }
    },
    [HOST, withHost] as const,
  );
  await page.goto('./?mode=desktop');
  await expect(page.getByTestId('desktop')).toBeVisible();
}

async function openApp(page: Page, appId: string) {
  const existing = windowOf(page, appId).last();
  if ((await existing.count()) && (await existing.getAttribute('data-focused')) === 'true') return existing;
  await page.locator(`[data-dock-item="${appId}"]`).click();
  await expect(windowOf(page, appId).last()).toBeVisible();
  return windowOf(page, appId).last();
}

async function installLocally(page: Page, file: string) {
  const win = await openApp(page, 'installer');
  await chooseFile(page, () => win.getByTestId('installer-choose').click(), file);
  await expect(win.getByTestId('installer-analysis')).toBeVisible({ timeout: 120_000 });
  await expect(win.getByTestId('installer-space')).toBeVisible();
  await win.getByTestId('installer-install').click();
  await expect(win.getByTestId('installer-done')).toBeVisible({ timeout: 180_000 });
  return win;
}

test.describe('Lokaler Modus (ohne Server)', () => {
  test('läuft ohne Server, verlangt keine Anmeldung und richtet den Spiele-Host ein', async ({ page }) => {
    await openDesktop(page, false);
    // Keine Anfrage an eine API: Der Desktop kommt ohne Server aus.
    const apiCalls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/')) apiCalls.push(r.url());
    });
    const library = await openApp(page, 'library');
    await expect(library.getByText('Noch keine Spiele installiert')).toBeVisible();
    await expect(library.getByText(/braucht RenOS noch die Adresse deines Spiele-Hosts/)).toBeVisible();

    const settings = windowOf(page, 'settings');
    await library.getByRole('button', { name: 'Spiele-Einstellungen öffnen' }).click();
    await expect(settings.getByRole('heading', { name: 'Spiele', exact: true })).toBeVisible();
    // Gleiche Adresse wie RenOS wird abgelehnt.
    await settings.getByTestId('gamehost-input').fill('http://localhost:4320/renos/');
    await settings.getByTestId('gamehost-save').click();
    await expect(settings.getByText(/darf nicht dieselbe Adresse wie RenOS haben/)).toBeVisible();
    await settings.getByTestId('gamehost-input').fill('http://localhost:4320/irgendwas/');
    await settings.getByTestId('gamehost-save').click();
    await expect(settings.getByText(/darf nicht dieselbe Adresse/)).toBeVisible();
    await settings.getByTestId('gamehost-input').fill('http://localhost:4321/falsch/');
    await settings.getByTestId('gamehost-save').click();
    await expect(settings.getByText(/kein RenOS-Spiele-Host|nichts erreichbar/)).toBeVisible();
    await settings.getByTestId('gamehost-input').fill(HOST);
    await settings.getByTestId('gamehost-save').click();
    await expect(settings.getByText('Spiele-Host gefunden und gespeichert.')).toBeVisible();
    expect(apiCalls).toEqual([]);
  });

  test('prüft Archive auf dem Gerät und lehnt unsichere ab', async ({ page }) => {
    await openDesktop(page);
    const win = await openApp(page, 'installer');
    const unsafe = writeZip('lokal-unsicher.zip', [...webBuildEntries(), { name: '../../evil.js', data: 'x' }]);
    await chooseFile(page, () => win.getByTestId('installer-choose').click(), unsafe);
    const analysis = win.getByTestId('installer-analysis');
    await expect(analysis).toHaveAttribute('data-installable', 'false');
    await expect(analysis).toContainText('aus dem Zielordner auszubrechen');
    await win.getByRole('button', { name: 'Andere Datei wählen' }).click();
    const desktop = writeZip('lokal-desktop.zip', [{ name: 'Spiel.exe', data: 'MZ' }, { name: 'game/script.rpyc', data: 'x' }, { name: 'renpy/common/x.rpy', data: 'x' }]);
    await chooseFile(page, () => win.getByTestId('installer-choose').click(), desktop);
    await expect(win.getByTestId('installer-analysis')).toHaveAttribute('data-kind', 'renpy-desktop');
  });

  test('installiert lokal, startet über den Spiele-Host und entfernt das Spiel wieder', async ({ page }) => {
    await openDesktop(page);
    const file = writeZip('Lokal-1.0-web.zip', webBuildEntries('Lokal-1.0-web/', 'Lokales Spiel'));
    const installer = await installLocally(page, file);
    await installer.getByRole('button', { name: 'Jetzt spielen' }).click();
    // Die Bridge im Spiel meldet sich über Host-Seite und Service Worker → die Spieldateien kamen aus dem iPad-Speicher.
    await expect(page.getByTestId('player')).toHaveAttribute('data-booted', 'true', { timeout: 30_000 });
    const frame = page.frames().find((f) => f.url().startsWith(`${HOST}play/`));
    expect(frame?.url()).toMatch(/\/renos-games\/play\/[a-z0-9]{24}\/index\.html$/);
    const wasm = await frame!.evaluate(async () => {
      const res = await fetch('renpy.wasm');
      return { status: res.status, type: res.headers.get('content-type'), bytes: (await res.arrayBuffer()).byteLength };
    });
    expect(wasm).toEqual({ status: 200, type: 'application/wasm', bytes: 8 });
    const range = await frame!.evaluate(async () => {
      const res = await fetch('game.zip', { headers: { Range: 'bytes=0-99' } });
      return { status: res.status, range: res.headers.get('content-range'), bytes: (await res.arrayBuffer()).byteLength };
    });
    expect(range).toEqual({ status: 206, range: 'bytes 0-99/4096', bytes: 100 });
    // Andere Spiele/Pfade sind nicht erreichbar.
    const other = await frame!.evaluate(async () => (await fetch('../aaaaaaaaaaaaaaaaaaaaaaaa/index.html')).status);
    expect(other).toBe(404);

    await page.getByRole('button', { name: 'Steuerung einblenden' }).click();
    await page.getByTestId('player-controls').getByRole('button', { name: 'Spiel beenden' }).click();
    const library = await openApp(page, 'library');
    const card = library.getByRole('option', { name: /Lokales Spiel/ });
    await expect(card).toBeVisible();
    await card.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Entfernen …' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Entfernen' }).click();
    await expect(card).toHaveCount(0);
    // Die Dateien sind aus dem OPFS verschwunden.
    const left = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const games = await root.getDirectoryHandle('renos-games', { create: true });
      const names: string[] = [];
      for await (const name of (games as unknown as { keys: () => AsyncIterable<string> }).keys()) names.push(name);
      return names;
    });
    expect(left).toEqual([]);
  });

  test.describe('echte Ren’Py-Laufzeit', () => {
    test.skip(!existsSync(BUILD), 'Ren’Py-Test-Build fehlt – siehe TESTING.md („npm run testgame“).');
    test.setTimeout(300_000);

    const exec = (frame: Frame, code: string) =>
      frame.evaluate((c) => (window as unknown as { renpy_exec: (s: string) => Promise<unknown> }).renpy_exec(c), code);

    async function start(page: Page): Promise<Frame> {
      const library = await openApp(page, 'library');
      await library.getByRole('option', { name: /RenOS Testspiel/ }).dblclick();
      await expect(page.getByTestId('player')).toHaveAttribute('data-phase', 'running', { timeout: 180_000 });
      const frame = page.frames().find((f) => f.url().startsWith(`${HOST}play/`));
      expect(frame).toBeTruthy();
      return frame!;
    }

    test('installiert ein echtes Spiel lokal, spielt es isoliert und behält Spielstände', async ({ page }) => {
      await openDesktop(page);
      const installer = await installLocally(page, BUILD);
      await installer.getByRole('button', { name: 'Schließen' }).first().click();

      let frame = await start(page);
      expect(await exec(frame, 'result = persistent.starts')).toBe(1);
      // Isolation: Spiel läuft auf dem Spiele-Origin und kommt nicht an RenOS heran.
      expect(await frame.evaluate(() => location.origin)).toBe(HOST_ORIGIN);
      expect(
        await frame.evaluate(() => {
          try {
            return String(window.top!.document.title);
          } catch (error) {
            return (error as Error).name;
          }
        }),
      ).toBe('SecurityError');

      await page.getByTestId('game-frame').click({ position: { x: 600, y: 400 } });
      await page.keyboard.press('Enter');
      await expect.poll(() => exec(frame, 'result = renpy.get_filename_line()[1]'), { timeout: 20_000 }).toBe(17);
      await exec(frame, "renpy.save('1-1', 'RenOS lokal'); result = True");
      await page.waitForTimeout(1500);

      await page.getByRole('button', { name: 'Steuerung einblenden' }).click();
      await page.getByTestId('player-controls').getByRole('button', { name: 'Spiel beenden' }).click();
      await page.reload();
      await expect(page.getByTestId('desktop')).toBeVisible();
      frame = await start(page);
      expect(await exec(frame, "result = renpy.can_load('1-1')")).toBe(true);
      expect(await exec(frame, 'result = persistent.starts')).toBe(2);
    });
  });
});
