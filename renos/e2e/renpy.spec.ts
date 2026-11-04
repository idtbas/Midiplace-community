import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Frame, type Page } from '@playwright/test';
import { GAME_ORIGIN, installViaUi, loginViaApi, openApp, openDesktop, windowOf } from './helpers';

/**
 * Echter Ren'Py-Laufzeittest mit dem RenOS-Testspiel.
 * Voraussetzung: `npm run testgame -- <pfad-zum-renpy-sdk>` (siehe TESTING.md).
 * Ohne den erzeugten Web-Build wird diese Suite übersprungen – nicht als bestanden gemeldet.
 */
const BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/generated/RenOSTestspiel-1.0-web.zip');

test.describe('Ren’Py-Laufzeit (echter Web-Build)', () => {
  test.skip(!existsSync(BUILD), 'Ren’Py-Test-Build fehlt – siehe TESTING.md („npm run testgame“).');
  test.setTimeout(300_000);

  async function startGame(page: Page): Promise<Frame> {
    const library = await openApp(page, 'library');
    await library.getByRole('option', { name: /RenOS Testspiel/ }).dblclick();
    const player = page.getByTestId('player');
    await expect(player).toHaveAttribute('data-phase', 'running', { timeout: 180_000 });
    const frame = page.frames().find((f) => f.url().startsWith(`${GAME_ORIGIN}/g/`));
    expect(frame, 'Spiel-iframe auf dem Game-Origin').toBeTruthy();
    return frame!;
  }

  const exec = (frame: Frame, code: string) =>
    frame.evaluate((c) => (window as unknown as { renpy_exec: (s: string) => Promise<unknown> }).renpy_exec(c), code);

  test('installiert, startet isoliert, nimmt Tastatureingaben an und behält Spielstände nach Neustart', async ({ page }) => {
    await loginViaApi(page);
    await openDesktop(page);
    const installer = await installViaUi(page, BUILD);
    await installer.getByRole('button', { name: 'Schließen' }).first().click();

    // 1. Start im immersiven Modus
    let frame = await startGame(page);
    const iframe = page.getByTestId('game-frame');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads allow-pointer-lock');
    expect(await exec(frame, 'result = persistent.starts')).toBe(1);
    expect(await exec(frame, 'result = renpy.get_filename_line()[1]')).toBe(16);

    // 2. Isolation: Das Spiel kann nicht auf RenOS zugreifen.
    const isolation = await frame.evaluate(() => {
      try {
        return String(window.parent.document.title);
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(isolation).toBe('SecurityError');
    const storageOrigin = await frame.evaluate(() => window.location.origin);
    expect(storageOrigin).toBe(GAME_ORIGIN);

    // 3. Tastatur: Enter erreicht das Spiel und rückt den Dialog vor (nicht von RenOS abgefangen).
    await iframe.click({ position: { x: 600, y: 400 } });
    await page.keyboard.press('Enter');
    await expect.poll(() => exec(frame, 'result = renpy.get_filename_line()[1]'), { timeout: 15_000 }).toBe(17);

    // 4. Spielstand speichern (Ren'Py-API, synchronisiert IndexedDB des Spiele-Origins).
    await exec(frame, "renpy.save('1-1', 'RenOS E2E'); result = True");
    expect(await exec(frame, "result = renpy.can_load('1-1')")).toBe(true);
    await page.waitForTimeout(1500);

    // 5. Spiel schließen (Ressourcen werden freigegeben) …
    await page.getByRole('button', { name: 'Steuerung einblenden' }).click();
    await page.getByTestId('player-controls').getByRole('button', { name: 'Spiel beenden' }).click();
    await expect(page.getByTestId('game-frame')).toHaveCount(0);

    // … RenOS komplett neu laden und erneut starten: Spielstand und persistente Daten sind noch da.
    await page.reload();
    await expect(page.getByTestId('desktop')).toBeVisible();
    frame = await startGame(page);
    expect(await exec(frame, "result = renpy.can_load('1-1')")).toBe(true);
    expect(await exec(frame, 'result = persistent.starts')).toBe(2);
    expect(await exec(frame, "result = [s for s in renpy.list_saved_games() if s[0] == '1-1'][0][1]")).toBe('RenOS E2E');

    // 6. Immersiven Modus verlassen (⌥⇧Esc wird von der Bridge weitergeleitet).
    await page.getByTestId('game-frame').click({ position: { x: 600, y: 400 } });
    await page.keyboard.press('Alt+Shift+Escape');
    await expect(windowOf(page, 'player').locator('div.os-chrome').first()).toBeVisible();
    await expect(page.getByTestId('player')).toHaveAttribute('data-phase', 'running');
  });
});
