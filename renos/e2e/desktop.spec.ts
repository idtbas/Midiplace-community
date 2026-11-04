import { expect, test } from '@playwright/test';
import { openApp, openDesktop, windowOf } from './helpers';

test.describe('Desktop & Window Manager', () => {
  test('Einrichtungsassistent mit 5 Schritten setzt die Akzentfarbe und wird gespeichert', async ({ page }) => {
    await openDesktop(page, { onboarding: true });
    await expect(page.getByRole('heading', { name: 'Willkommen bei RenOS' })).toBeVisible();
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.getByRole('button', { name: 'Salbei' }).click();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#8dbfae');
    await page.getByRole('button', { name: 'Weiter' }).click();
    await expect(page.getByRole('heading', { name: 'Bedienung' })).toBeVisible();
    await page.getByRole('button', { name: 'Weiter' }).click();
    await expect(page.getByRole('heading', { name: 'Deine Spielebibliothek' })).toBeVisible();
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.getByRole('button', { name: 'Desktop starten' }).click();
    await expect(page.getByTestId('desktop')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('desktop')).toBeVisible();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);
  });

  test('öffnet Apps aus dem Dock, fokussiert, minimiert, stellt wieder her und schließt', async ({ page }) => {
    await openDesktop(page);
    const files = await openApp(page, 'files');
    const notes = await openApp(page, 'notes');
    await expect(notes).toHaveAttribute('data-focused', 'true');
    await expect(files).not.toHaveAttribute('data-focused', 'true');
    // Klick auf ein Fenster bringt es nach vorn.
    // Sichtbare Ecke des hinteren Fensters anklicken (das vordere ist versetzt darüber).
    await files.click({ position: { x: 12, y: 12 } });
    await expect(files).toHaveAttribute('data-focused', 'true');
    const zFiles = Number(await files.evaluate((el) => getComputedStyle(el).zIndex));
    const zNotes = Number(await notes.evaluate((el) => getComputedStyle(el).zIndex));
    expect(zFiles).toBeGreaterThan(zNotes);

    await files.getByRole('button', { name: 'Minimieren' }).click();
    await expect(files).toHaveAttribute('data-minimized', 'true');
    await expect(notes).toHaveAttribute('data-focused', 'true');
    // Dock-Klick stellt das minimierte Fenster wieder her.
    await page.locator('[data-dock-item="files"]').click();
    await expect(files).not.toHaveAttribute('data-minimized', 'true');
    await expect(files).toHaveAttribute('data-focused', 'true');

    await files.getByRole('button', { name: 'Schließen' }).click();
    await expect(windowOf(page, 'files')).toHaveCount(0);
  });

  test('verschiebt Fenster per Zeiger, ändert die Größe und speichert die Position', async ({ page }) => {
    await openDesktop(page);
    const win = await openApp(page, 'terminal');
    const titlebar = win.locator('div.os-chrome').first();
    const before = (await win.boundingBox())!;
    const tb = (await titlebar.boundingBox())!;
    await page.mouse.move(tb.x + 120, tb.y + 18);
    await page.mouse.down();
    await page.mouse.move(tb.x + 220, tb.y + 98, { steps: 8 });
    await page.mouse.up();
    const moved = (await win.boundingBox())!;
    expect(Math.round(moved.x - before.x)).toBe(100);
    expect(Math.round(moved.y - before.y)).toBe(80);

    // Größe über die rechte untere Ecke ändern.
    await page.mouse.move(moved.x + moved.width - 2, moved.y + moved.height - 2);
    await page.mouse.down();
    await page.mouse.move(moved.x + moved.width + 78, moved.y + moved.height + 48, { steps: 6 });
    await page.mouse.up();
    const resized = (await win.boundingBox())!;
    expect(Math.round(resized.width - moved.width)).toBe(80);
    expect(Math.round(resized.height - moved.height)).toBe(50);

    await page.reload();
    const restored = (await windowOf(page, 'terminal').boundingBox())!;
    expect(Math.round(restored.x)).toBe(Math.round(resized.x));
    expect(Math.round(restored.width)).toBe(Math.round(resized.width));
  });

  test('maximiert per Doppelklick und rastet am linken Rand ein', async ({ page }) => {
    await openDesktop(page);
    const win = await openApp(page, 'notes');
    const titlebar = win.locator('div.os-chrome').first();
    await titlebar.dblclick({ position: { x: 200, y: 18 } });
    const max = (await win.boundingBox())!;
    expect(Math.round(max.width)).toBe(1180);
    await titlebar.dblclick({ position: { x: 200, y: 18 } });
    const normal = (await win.boundingBox())!;
    expect(normal.width).toBeLessThan(1180);

    const tb = (await titlebar.boundingBox())!;
    await page.mouse.move(tb.x + 150, tb.y + 18);
    await page.mouse.down();
    await page.mouse.move(2, 400, { steps: 10 });
    await page.mouse.up();
    const snapped = (await win.boundingBox())!;
    expect(Math.round(snapped.x)).toBe(0);
    expect(Math.abs(snapped.width - 587)).toBeLessThan(4);
  });

  test('App-Launcher: Tastenkürzel, echte Suche, Pfeiltasten und Enter', async ({ page }) => {
    await openDesktop(page);
    await page.keyboard.press('Alt+Space');
    const search = page.getByPlaceholder('Anwendungen und Spiele suchen …');
    await expect(search).toBeFocused();
    await search.fill('notiz');
    await expect(page.getByRole('option', { name: /Notes/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(windowOf(page, 'notes')).toBeVisible();
    await expect(search).toHaveCount(0);

    // Tippen auf dem leeren Desktop öffnet die Suche mit dem Zeichen.
    await page.getByTestId('desktop').click({ position: { x: 1100, y: 600 } });
    await page.keyboard.type('ter');
    await expect(search).toHaveValue('ter');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(search).toHaveCount(0);
  });

  test('Desktop-Kontextmenü und Einstellungen verändern die Oberfläche', async ({ page }) => {
    await openDesktop(page);
    await page.getByTestId('desktop').click({ button: 'right', position: { x: 900, y: 500 } });
    await expect(page.getByRole('menu')).toBeVisible();
    await page.getByRole('menuitem', { name: 'Hintergrund ändern …' }).click();
    const settings = windowOf(page, 'settings');
    await expect(settings.getByRole('heading', { name: 'Desktop' })).toBeVisible();
    await settings.getByRole('button', { name: 'Graphit' }).click();
    await expect(page.locator('[data-testid="desktop"] > div').first().locator('div').first()).toHaveAttribute('style', /graphit\.jpg/);

    await settings.getByRole('button', { name: 'Dock' }).click();
    await settings.getByRole('switch', { name: 'Automatisch ausblenden' }).click();
    await expect(page.getByRole('navigation', { name: 'Dock' }).locator('> div')).toHaveClass(/opacity-0/);

    await settings.getByRole('button', { name: 'Erscheinungsbild' }).click();
    await settings.getByRole('button', { name: 'Lavendel' }).click();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#aba3e3');
    await page.reload();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#aba3e3');
  });

  test('Fenster-Tastenkürzel: schließen und wechseln', async ({ page }) => {
    await openDesktop(page);
    const files = await openApp(page, 'files');
    const notes = await openApp(page, 'notes');
    await page.keyboard.press('Alt+Tab');
    await expect(files).toHaveAttribute('data-focused', 'true');
    await page.keyboard.press('Alt+w');
    await expect(windowOf(page, 'files')).toHaveCount(0);
    await expect(notes).toHaveAttribute('data-focused', 'true');
  });
});
