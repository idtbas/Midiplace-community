import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { makeZip, webBuildEntries, type ZipEntrySpec } from '../apps/server/test/helpers/zip';

export const APP_ORIGIN = 'http://localhost:4310';
export const GAME_ORIGIN = 'http://localhost:4311';
export const PASSWORD = 'e2e-owner-passwort';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.artifacts/fixtures');

/** Schreibt ein Test-Archiv auf die Festplatte und liefert den Pfad (für den Dateidialog). */
export function writeZip(name: string, entries: ZipEntrySpec[]): string {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const file = path.join(FIXTURE_DIR, name);
  writeFileSync(file, makeZip(entries));
  return file;
}

export function writeFile(name: string, content: string | Buffer): string {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const file = path.join(FIXTURE_DIR, name);
  writeFileSync(file, content);
  return file;
}

export { webBuildEntries };

/** Öffnet den Desktop im Browsermodus. Optional ohne Einrichtungsassistenten. */
export async function openDesktop(page: Page, options: { onboarding?: boolean } = {}): Promise<void> {
  if (!options.onboarding) {
    await page.addInitScript(() => {
      if (!localStorage.getItem('renos.settings')) {
        localStorage.setItem('renos.settings', JSON.stringify({ state: { onboardingCompleted: true }, version: 1 }));
      }
    });
  }
  await page.goto('/?mode=desktop');
  if (options.onboarding) await expect(page.getByTestId('onboarding')).toBeVisible();
  else await expect(page.getByTestId('desktop')).toBeVisible();
}

/** Meldet den Owner über die API an (Cookie gilt für die ganze Browser-Session). */
export async function loginViaApi(page: Page): Promise<void> {
  const res = await page.request.post('/api/auth/login', { data: { password: PASSWORD }, headers: { origin: APP_ORIGIN } });
  expect(res.ok()).toBeTruthy();
}

export function windowOf(page: Page, appId: string) {
  return page.locator(`[data-window-id][data-app-id="${appId}"]`);
}

export async function openApp(page: Page, appId: string) {
  // Ein bereits fokussiertes Fenster würde ein Dock-Klick minimieren (gewolltes Verhalten) – dann nicht klicken.
  const existing = windowOf(page, appId).last();
  if ((await existing.count()) && (await existing.getAttribute('data-focused')) === 'true') return existing;
  await page.locator(`[data-dock-item="${appId}"]`).click();
  const win = windowOf(page, appId).last();
  await expect(win).toBeVisible();
  return win;
}

/** Wählt eine Datei über den System-Dateidialog aus, der durch `trigger` geöffnet wird. */
export async function chooseFile(page: Page, trigger: () => Promise<void>, file: string | string[]) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), trigger()]);
  await chooser.setFiles(file);
}

/** Installiert ein Archiv über die Installer-Oberfläche und wartet auf das Ergebnis. */
export async function installViaUi(page: Page, file: string, title?: string) {
  const win = await openApp(page, 'installer');
  await chooseFile(page, () => win.getByTestId('installer-choose').click(), file);
  await expect(win.getByTestId('installer-analysis')).toBeVisible({ timeout: 120_000 });
  if (title) await win.getByLabel('Titel in der Bibliothek').fill(title);
  await win.getByTestId('installer-install').click();
  await expect(win.getByTestId('installer-done')).toBeVisible({ timeout: 120_000 });
  return win;
}
