import { expect, test } from '@playwright/test';
import { GAME_ORIGIN, PASSWORD, chooseFile, installViaUi, loginViaApi, openApp, openDesktop, webBuildEntries, windowOf, writeFile, writeZip } from './helpers';

test.describe('Installer & Library', () => {
  test('verlangt eine Anmeldung und meldet falsche Passwörter verständlich', async ({ page }) => {
    await openDesktop(page);
    const win = await openApp(page, 'installer');
    const form = win.getByTestId('login-form');
    await expect(form).toBeVisible();
    await form.getByPlaceholder('Owner-Passwort').fill('falsch-falsch');
    await form.getByRole('button', { name: 'Anmelden' }).click();
    await expect(form.getByText('Das Passwort ist nicht korrekt.')).toBeVisible();
    await form.getByPlaceholder('Owner-Passwort').fill(PASSWORD);
    await form.getByRole('button', { name: 'Anmelden' }).click();
    await expect(win.getByTestId('installer-choose')).toBeVisible();
  });

  test('weist Nicht-ZIP-Dateien schon vor dem Upload ab', async ({ page }) => {
    await loginViaApi(page);
    await openDesktop(page);
    const win = await openApp(page, 'installer');
    await chooseFile(page, () => win.getByTestId('installer-choose').click(), writeFile('spiel.exe', 'MZ'));
    await expect(win.getByText('Bitte eine ZIP-Datei (.zip) auswählen.')).toBeVisible();
  });

  test('erkennt Desktop-Builds, Projektquellen und unsichere Archive', async ({ page }) => {
    await loginViaApi(page);
    await openDesktop(page);
    const win = await openApp(page, 'installer');
    const cases: Array<[string, string, RegExp]> = [
      ['desktop.zip', 'renpy-desktop', /Desktop-Build/],
      ['projekt.zip', 'renpy-project', /Projektquellen/],
      ['unsicher.zip', 'renpy-web', /aus dem Zielordner auszubrechen/],
    ];
    const archives: Record<string, string> = {
      'desktop.zip': writeZip('desktop.zip', [
        { name: 'Spiel-1.0-pc/Spiel.exe', data: 'MZ' },
        { name: 'Spiel-1.0-pc/game/script.rpyc', data: 'x' },
        { name: 'Spiel-1.0-pc/renpy/common/00start.rpy', data: 'x' },
      ]),
      'projekt.zip': writeZip('projekt.zip', [{ name: 'projekt/game/script.rpy', data: 'label start:\n    "Hallo"' }]),
      'unsicher.zip': writeZip('unsicher.zip', [...webBuildEntries(), { name: '../../evil.js', data: 'x' }]),
    };
    for (const [file, kind, text] of cases) {
      await chooseFile(page, () => win.getByTestId('installer-choose').click(), archives[file]!);
      const analysis = win.getByTestId('installer-analysis');
      await expect(analysis).toHaveAttribute('data-kind', kind);
      await expect(analysis).toHaveAttribute('data-installable', 'false');
      await expect(analysis).toContainText(text);
      await expect(win.getByTestId('installer-install')).toHaveCount(0);
      await win.getByRole('button', { name: 'Andere Datei wählen' }).click();
    }
  });

  test('installiert einen Web-Build, zeigt ihn in der Library und entfernt ihn wieder', async ({ page }) => {
    await loginViaApi(page);
    await openDesktop(page);
    const file = writeZip('Mondlicht-1.0-web.zip', webBuildEntries('Mondlicht-1.0-web/', 'Mondlicht'));
    const win = await installViaUi(page, file, 'Mondlicht – Test');
    await expect(win.getByText('„Mondlicht – Test“ ist jetzt in der Bibliothek.')).toBeVisible();
    await win.getByRole('button', { name: 'In der Library anzeigen' }).click();

    const library = windowOf(page, 'library');
    const card = library.getByRole('option', { name: /Mondlicht – Test/ });
    await expect(card).toBeVisible();
    await card.click();
    await expect(library.getByTestId('game-details')).toContainText('Ren’Py Web (WebAssembly)');

    // Die Spieldateien liegen ausschließlich auf dem Game-Origin.
    const games = await (await page.request.get('/api/games')).json();
    const game = games.games.find((g: { title: string }) => g.title === 'Mondlicht – Test');
    expect(game.playUrl.startsWith(`${GAME_ORIGIN}/g/`)).toBe(true);
    const wasm = await page.request.get(game.playUrl.replace('index.html', 'renpy.wasm'));
    expect(wasm.headers()['content-type']).toBe('application/wasm');
    expect((await page.request.get(`/g/${game.id}/index.html`)).status()).toBe(404);

    // Suche und Umbenennen
    await library.getByPlaceholder('Bibliothek durchsuchen').fill('gibtsnicht');
    await expect(library.getByText('Keine Spiele gefunden')).toBeVisible();
    await library.getByPlaceholder('Bibliothek durchsuchen').fill('mond');
    await expect(card).toBeVisible();

    // Entfernen
    await card.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Entfernen …' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Entfernen' }).click();
    await expect(card).toHaveCount(0);
    expect((await page.request.get(game.playUrl)).status()).toBe(404);
  });

  test('der Player meldet einen nicht startenden Build verständlich statt Erfolg vorzutäuschen', async ({ page }) => {
    await loginViaApi(page);
    await openDesktop(page);
    // Strukturell korrekter Build ohne echte Laufzeit: Ren'Py kann nicht starten.
    const file = writeZip('Defekt-web.zip', webBuildEntries('Defekt-web/', 'Defektes Spiel'));
    const win = await installViaUi(page, file);
    await win.getByRole('button', { name: 'Jetzt spielen' }).click();
    const player = page.getByTestId('player');
    await expect(player).toBeVisible();
    await expect(player).not.toHaveAttribute('data-phase', 'running', { timeout: 3000 });
    await expect(page.getByTestId('player-loading')).toBeVisible();
    // Bridge meldet „boot“, aber nie „running“ → bleibt im Ladezustand; Schließen gibt Ressourcen frei.
    await page.getByRole('button', { name: 'Steuerung einblenden' }).click();
    await page.getByTestId('player-controls').getByRole('button', { name: 'Spiel beenden' }).click();
    await expect(page.getByTestId('game-frame')).toHaveCount(0);
  });
});
