import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { chooseFile, openApp, openDesktop, windowOf, writeFile } from './helpers';

test.describe('Files', () => {
  test('Ordner anlegen, umbenennen, navigieren, importieren, exportieren, löschen und wiederherstellen', async ({ page }) => {
    await openDesktop(page);
    const win = await openApp(page, 'files');
    const list = win.getByRole('listbox', { name: 'Dateien' });

    // Neuer Ordner → Inline-Umbenennen
    await win.getByRole('button', { name: /Neuer Ordner/ }).click();
    const rename = win.getByRole('textbox', { name: 'Umbenennen' });
    await expect(rename).toBeFocused();
    await rename.fill('Projekte');
    await rename.press('Enter');
    await expect(list.getByRole('option', { name: /Projekte/ })).toBeVisible();

    // Navigieren und Datei importieren
    await list.getByRole('option', { name: /Projekte/ }).dblclick();
    await expect(win.getByRole('navigation', { name: 'Pfad' })).toContainText('Projekte');
    const source = writeFile('reiseplan.txt', 'Zug um 9:12 Uhr ab Gleis 4');
    await chooseFile(page, () => win.getByRole('button', { name: 'Importieren' }).click(), source);
    const fileRow = list.getByRole('option', { name: /reiseplan\.txt/ });
    await expect(fileRow).toBeVisible();

    // Vorschau zeigt den echten Inhalt
    await fileRow.click();
    await expect(win.getByText('Zug um 9:12 Uhr ab Gleis 4')).toBeVisible();

    // Export → Download mit identischem Inhalt
    const [download] = await Promise.all([page.waitForEvent('download'), win.getByRole('button', { name: 'Exportieren' }).click()]);
    expect(download.suggestedFilename()).toBe('reiseplan.txt');
    expect(readFileSync((await download.path())!, 'utf8')).toBe('Zug um 9:12 Uhr ab Gleis 4');

    // Umbenennen per Kontextmenü
    await fileRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Umbenennen' }).click();
    await win.getByRole('textbox', { name: 'Umbenennen' }).fill('zugplan.txt');
    await page.keyboard.press('Enter');
    await expect(list.getByRole('option', { name: /zugplan\.txt/ })).toBeVisible();

    // Persistenz nach Neustart
    await page.reload();
    const files = windowOf(page, 'files');
    await expect(files.getByRole('option', { name: /zugplan\.txt/ })).toBeVisible();

    // Papierkorb: löschen, wiederherstellen, endgültig löschen
    await files.getByRole('option', { name: /zugplan\.txt/ }).click();
    await page.keyboard.press('Delete');
    await expect(files.getByRole('option', { name: /zugplan\.txt/ })).toHaveCount(0);
    await files.getByRole('button', { name: 'Papierkorb' }).click();
    const trashed = files.getByRole('option', { name: /zugplan\.txt/ });
    await expect(trashed).toBeVisible();
    await trashed.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Wiederherstellen' }).click();
    await expect(trashed).toHaveCount(0);
    // Wieder am ursprünglichen Ort
    await files.getByRole('button', { name: 'Persönlicher Ordner' }).click();
    await files.getByRole('option', { name: /Projekte/ }).dblclick();
    await expect(files.getByRole('option', { name: /zugplan\.txt/ })).toBeVisible();
  });

  test('Rasteransicht und Suche', async ({ page }) => {
    await openDesktop(page);
    const win = await openApp(page, 'files');
    await win.getByRole('button', { name: 'Rasteransicht' }).click();
    await expect(win.locator('[data-grid]')).toBeVisible();
    await win.getByPlaceholder('In diesem Ordner suchen').fill('Doku');
    await expect(win.getByRole('option')).toHaveCount(1);
    await win.getByPlaceholder('In diesem Ordner suchen').fill('Willkommen');
    await win.getByLabel('Überall suchen').check();
    await expect(win.getByRole('option', { name: /Willkommen\.txt/ })).toBeVisible();
  });
});

test.describe('Notes', () => {
  test('erstellt, speichert automatisch, übersteht Neustart und löscht mit Rückgängig', async ({ page }) => {
    await openDesktop(page);
    const win = await openApp(page, 'notes');
    await win.getByRole('button', { name: /Neue Notiz/ }).click();
    const editor = win.getByRole('textbox', { name: 'Notiztext' });
    await expect(editor).toBeFocused();
    await editor.fill('Einkaufsliste\nBrot, Käse, Äpfel');
    await expect(win.getByTestId('note-status')).toHaveText('Gespeichert');
    await expect(win.getByRole('option', { name: /Einkaufsliste/ })).toBeVisible();

    await page.reload();
    const again = windowOf(page, 'notes');
    await expect(again.getByRole('textbox', { name: 'Notiztext' })).toHaveValue('Einkaufsliste\nBrot, Käse, Äpfel');

    await again.getByPlaceholder('Notizen durchsuchen').fill('käse');
    await expect(again.getByRole('option')).toHaveCount(1);
    await again.getByPlaceholder('Notizen durchsuchen').fill('');

    await again.getByRole('button', { name: 'Löschen' }).click();
    await expect(again.getByRole('option', { name: /Einkaufsliste/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Rückgängig' }).click();
    await expect(again.getByRole('option', { name: /Einkaufsliste/ })).toBeVisible();
  });
});

test.describe('Terminal', () => {
  test('führt interne Befehle mit echten Daten aus und hat einen Verlauf', async ({ page }) => {
    await openDesktop(page);
    const win = await openApp(page, 'terminal');
    const input = win.getByTestId('terminal-input');
    await expect(input).toBeFocused();
    const run = async (cmd: string) => {
      await input.fill(cmd);
      await input.press('Enter');
    };
    await run('pwd');
    await expect(win.getByRole('log')).toContainText('/home/user');
    await run('mkdir Testordner');
    await run('cd Testordner');
    await run('pwd');
    await expect(win.getByRole('log')).toContainText('/home/user/Testordner');
    await run('cd ..');
    await run('ls');
    await expect(win.getByRole('log')).toContainText('Testordner/');
    await run('whoami');
    await run('rm -rf /');
    await expect(win.getByRole('log')).toContainText('renos: Befehl nicht gefunden: rm');
    await run('neofetch');
    await expect(win.getByRole('log')).toContainText('OS: RenOS 1.0.0');
    await run('clear');
    await expect(win.getByRole('log')).not.toContainText('neofetch');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('clear');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('neofetch');
    await input.fill('open note');
    await input.press('Tab');
    await input.fill('open notes');
    await input.press('Enter');
    await expect(windowOf(page, 'notes')).toBeVisible();
  });
});
