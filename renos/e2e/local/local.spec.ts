import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Frame, type Page } from '@playwright/test';
import { chooseFile, webBuildEntries, windowOf, writeZip } from '../helpers';

/**
 * Lokaler Modus (RenOS ohne Server, wie auf GitHub Pages):
 * Spiele werden im OPFS von RenOS installiert und im eingebauten Spiele-Host (anonymer Origin im iframe)
 * oder optional über den statischen Spiele-Host (zweiter Origin) ausgeführt.
 */
const HOST = 'http://localhost:4321/renos-games/';
const HOST_ORIGIN = 'http://localhost:4321';
const BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/generated/RenOSTestspiel-1.0-web.zip');
const DESKTOP = (major: number) => path.join(path.dirname(fileURLToPath(import.meta.url)), `../fixtures/generated/TheQuestion-${major}-pc.zip`);
const RUNTIMES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../apps/web/dist-local/runtimes/index.json');

async function openDesktop(page: Page, withHost = true) {
  await page.addInitScript(
    ([host, withHostFlag]) => {
      // Init-Skripte laufen in jedem Frame – auch im Spiel, das keinen Zugriff auf localStorage hat.
      if (window !== window.top) return;
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

/**
 * Versetzt ein umgewandeltes Spiel in den Zustand einer früheren RenOS-Fassung (Stand 1): neben einer
 * .rpyc liegt wieder die .rpy – mit Syntax, die die Laufzeit nicht übersetzen kann (wie bei Student
 * Transfer) –, und die Versionsmarke fehlt. RenOS muss das beim Start ohne Neuinstallation reparieren.
 */
async function makeLegacyInstall(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const records = await new Promise<Array<{ id: string; conversion?: Record<string, unknown> }>>((resolve, reject) => {
      const open = indexedDB.open('renos');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('games', 'readwrite');
        const store = tx.objectStore('games');
        const all = store.getAll();
        all.onsuccess = () => {
          const list = all.result as Array<{ id: string; conversion?: Record<string, unknown> }>;
          for (const record of list) {
            if (!record.conversion) continue;
            delete record.conversion.converter;
            store.put(record);
          }
          tx.oncomplete = () => resolve(list);
        };
        all.onerror = () => reject(all.error);
      };
    });
    const game = records.find((r) => r.conversion);
    if (!game) throw new Error('kein umgewandeltes Spiel');
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('renos-games')).getDirectoryHandle(game.id);
    const handle = await dir.getFileHandle('game.zip');
    const file = await handle.getFile();
    const tail = new DataView(await file.slice(file.size - 22).arrayBuffer());
    if (tail.getUint32(0, true) !== 0x06054b50) throw new Error('Ende des Inhaltsverzeichnisses nicht gefunden');
    const count = tail.getUint16(10, true);
    const cdSize = tail.getUint32(12, true);
    const cdOffset = tail.getUint32(16, true);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 wird hier nicht unterstützt');
    const cd = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const view = new DataView(cd.buffer);
    const names: string[] = [];
    for (let p = 0; p < cd.byteLength; ) {
      const nameLength = view.getUint16(p + 28, true);
      names.push(new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLength)));
      p += 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    }
    const compiled = names.find((n) => /^game\/.+\.rpyc$/.test(n) && !names.includes(n.slice(0, -1)));
    if (!compiled) throw new Error('keine .rpyc in der game.zip');
    const name = new TextEncoder().encode(compiled.slice(0, -1));
    const data = new TextEncoder().encode('label renos_legacy_check:\n    john a_11 : a_4, patty a_4: a_11\n');
    let crc = ~0;
    for (const byte of data) {
      crc ^= byte;
      for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    crc = ~crc >>> 0;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.byteLength, true);
    local.setUint32(22, data.byteLength, true);
    local.setUint16(26, name.byteLength, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, (3 << 8) | 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.byteLength, true);
    central.setUint32(24, data.byteLength, true);
    central.setUint16(28, name.byteLength, true);
    central.setUint32(38, (0o100644 << 16) >>> 0, true);
    central.setUint32(42, cdOffset, true);
    const newCdOffset = cdOffset + 30 + name.byteLength + data.byteLength;
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, count + 1, true);
    eocd.setUint16(10, count + 1, true);
    eocd.setUint32(12, cdSize + 46 + name.byteLength, true);
    eocd.setUint32(16, newCdOffset, true);
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.seek(cdOffset);
    await writable.write(new Blob([local.buffer, name, data, cd, central.buffer, name, eocd.buffer]));
    await writable.close();
    return compiled.slice('game/'.length, -1);
  });
}

/** PNG mit gültigem Kopf in der angegebenen Größe (Inhalt zufällig, wird nicht dargestellt). */
function pngWithSize(width: number, height: number, bytes: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.set([8, 2, 0, 0, 0], 16);
  const body = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 1) body[i] = (i * 2654435761) >>> 24;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, body]);
}

/** Vom Spiel angelegte Dateien, die RenOS aufbewahrt (IndexedDB „renos“ → overlay). */
async function overlayPaths(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('renos');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          if (!open.result.objectStoreNames.contains('overlay')) return resolve([]);
          const req = open.result.transaction('overlay').objectStore('overlay').getAll();
          req.onsuccess = () => resolve((req.result as Array<{ path: string }>).map((r) => r.path).sort());
          req.onerror = () => reject(req.error);
        };
      }),
  );
}

/** Dateien in Files mit diesem Namen. */
async function filesNamed(page: Page, name: string): Promise<Array<{ parentId: string; size: number }>> {
  return page.evaluate(
    (wanted) =>
      new Promise<Array<{ parentId: string; size: number }>>((resolve, reject) => {
        const open = indexedDB.open('renos');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result.transaction('nodes').objectStore('nodes').getAll();
          req.onsuccess = () =>
            resolve(
              (req.result as Array<{ name: string; parentId: string; size: number; trashed: number }>)
                .filter((n) => n.name === wanted && !n.trashed)
                .map((n) => ({ parentId: n.parentId, size: n.size })),
            );
          req.onerror = () => reject(req.error);
        };
      }),
    name,
  );
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
  test('läuft ohne Server, nutzt den eingebauten Spiele-Host und prüft externe Adressen', async ({ page }) => {
    await openDesktop(page, false);
    // Keine Anfrage an eine API: Der Desktop kommt ohne Server aus.
    const apiCalls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/')) apiCalls.push(r.url());
    });
    const library = await openApp(page, 'library');
    await expect(library.getByText('Noch keine Spiele installiert')).toBeVisible();
    // Keine Einrichtung nötig: kein Hinweis auf einen fehlenden Spiele-Host.
    await expect(library.getByText(/Spiele-Host/)).toHaveCount(0);

    await page.locator('[data-dock-item="settings"]').click();
    const settings = windowOf(page, 'settings');
    await settings.getByRole('button', { name: 'Spiele', exact: true }).click();
    await expect(settings.getByTestId('gamehost-active')).toHaveText('Aktiv');
    // Externe Adresse (optional): gleiche Adresse wie RenOS wird abgelehnt, falsche ebenso.
    await settings.getByTestId('gamehost-input').fill('http://localhost:4320/renos/');
    await settings.getByTestId('gamehost-save').click();
    await expect(settings.getByText(/darf nicht dieselbe Adresse wie RenOS haben/)).toBeVisible();
    await settings.getByTestId('gamehost-input').fill('http://localhost:4321/falsch/');
    await settings.getByTestId('gamehost-save').click();
    await expect(settings.getByText(/kein RenOS-Spiele-Host|nichts erreichbar/)).toBeVisible();
    await settings.getByTestId('gamehost-input').fill(HOST);
    await settings.getByTestId('gamehost-save').click();
    await expect(settings.getByText('Spiele-Host gefunden und gespeichert.')).toBeVisible();
    await expect(settings.getByTestId('gamehost-active')).toHaveCount(0);
    // Zurück zum eingebauten Host.
    await settings.getByTestId('gamehost-builtin').click();
    await expect(settings.getByTestId('gamehost-active')).toHaveText('Aktiv');
    expect(apiCalls).toEqual([]);
  });

  test('Browser: zeigt Webseiten und lädt Dateien direkt nach Files → Downloads', async ({ page }) => {
    // Nachgebildete Server: eine Seite mit Download-Link, ein CDN, das Downloads aus Web-Apps erlaubt (CORS),
    // und ein Hoster, der es nicht erlaubt.
    await page.route('https://seite.renos-test.example/**', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        headers: { 'access-control-allow-origin': '*' },
        body: '<h1>Szenario-Seite</h1><a href="https://cdn.renos-test.example/packs/Test%20Pack.zip">Pack herunterladen</a><a href="/impressum">Impressum</a>',
      }),
    );
    await page.route('https://cdn.renos-test.example/**', (route) =>
      route.fulfill({ contentType: 'application/zip', headers: { 'access-control-allow-origin': '*' }, body: Buffer.from('PK\u0003\u0004 renos test pack') }),
    );
    // Eine CORS-Sperre meldet der Browser der Web-App als fehlgeschlagene Anfrage (TypeError). Playwright prüft
    // bei nachgebildeten Antworten kein CORS – deshalb wird die Sperre hier als fehlgeschlagene Anfrage nachgestellt.
    await page.route('https://hoster.renos-test.example/**', (route) => route.abort('accessdenied'));

    await openDesktop(page, false);
    await page.keyboard.press('Alt+Space');
    await page.getByPlaceholder('Anwendungen und Spiele suchen …').fill('Browser');
    await page.keyboard.press('Enter');
    const win = windowOf(page, 'browser').last();
    await expect(win.getByTestId('browser-home')).toBeVisible();

    // Seite ansehen (eingebettet).
    await win.getByTestId('browser-address').fill('seite.renos-test.example');
    await win.getByTestId('browser-address').press('Enter');
    await expect(page.frameLocator('[data-testid="browser-frame"]').locator('h1')).toHaveText('Szenario-Seite');

    // „Herunterladen“ auf der Seite: Sie ist keine Datei – RenOS bietet die gefundenen Datei-Links an.
    await win.getByTestId('browser-download').click();
    const dialog = page.getByTestId('download-dialog');
    await expect(dialog.getByTestId('download-url')).toHaveValue('https://seite.renos-test.example/');
    await dialog.getByTestId('download-start').click();
    await expect(dialog.getByTestId('download-link')).toHaveCount(1);
    await dialog.getByTestId('download-link').click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => filesNamed(page, 'Test Pack.zip')).toEqual([{ parentId: 'downloads', size: 20 }]);

    // Ein Hoster ohne Freigabe: verständliche Meldung statt stillem Fehler.
    await win.getByTestId('browser-download').click();
    await page.getByTestId('download-url').fill('https://hoster.renos-test.example/datei.zip');
    await page.getByTestId('download-start').click();
    await expect(page.getByTestId('download-error')).toContainText('erlaubt keine Downloads aus Web-Apps');
    await page.keyboard.press('Escape');

    // Download-Liste.
    await win.getByTestId('browser-downloads').click();
    await expect(win.locator('[data-testid="download-item"][data-state="done"]')).toHaveCount(2);
    await expect(win.locator('[data-testid="download-item"][data-state="error"]')).toHaveCount(1);
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

  test('eingebauter Spiele-Host: liefert nur Dateien des Spiels, sperrt RenOS und Netzwerk und entfernt alles wieder', async ({ page }) => {
    await openDesktop(page, false);
    const file = writeZip('Lokal-1.0-web.zip', webBuildEntries('Lokal-1.0-web/', 'Lokales Spiel'));
    const installer = await installLocally(page, file);
    await installer.getByRole('button', { name: 'Jetzt spielen' }).click();
    // Die Laufzeit im Spiel meldet sich über den MessagePort → die Spieldateien kamen aus dem iPad-Speicher.
    await expect(page.getByTestId('player')).toHaveAttribute('data-booted', 'true', { timeout: 30_000 });
    await expect(page.getByTestId('game-frame')).toHaveAttribute('data-host', 'builtin');
    await expect(page.getByTestId('game-frame')).not.toHaveAttribute('sandbox', /allow-same-origin/);
    const frame = (await (await page.getByTestId('game-frame').elementHandle())!.contentFrame())!;

    const probe = await frame.evaluate(async () => {
      const wasm = await fetch('renpy.wasm');
      const range = await fetch('game.zip', { headers: { Range: 'bytes=0-99' } });
      const xhr = await new Promise<{ status: number; bytes: number }>((resolve) => {
        const req = new XMLHttpRequest();
        req.open('GET', 'renpy.data', true);
        req.responseType = 'arraybuffer';
        req.onload = () => resolve({ status: req.status, bytes: (req.response as ArrayBuffer).byteLength });
        req.send(null);
      });
      const attempt = async (fn: () => unknown) => {
        try {
          const value = await fn();
          return value instanceof Response ? `status ${value.status}` : String(value);
        } catch (error) {
          return (error as Error).name;
        }
      };
      return {
        origin,
        wasm: { status: wasm.status, type: wasm.headers.get('content-type'), bytes: (await wasm.arrayBuffer()).byteLength },
        range: { status: range.status, range: range.headers.get('content-range'), bytes: (await range.arrayBuffer()).byteLength },
        xhr,
        traversal: await attempt(() => fetch('../../../renos-games/../index.html?x').then((r) => r.status)),
        missing: await attempt(() => fetch('gibt-es-nicht.js').then((r) => r.status)),
        renos: await attempt(() => fetch('http://localhost:4320/renos/')),
        parent: await attempt(() => window.parent.document.title),
        storage: await attempt(() => localStorage.setItem('x', '1')),
        cookie: document.cookie,
      };
    });
    expect(probe).toEqual({
      origin: 'null',
      wasm: { status: 200, type: 'application/wasm', bytes: 8 },
      range: { status: 206, range: 'bytes 0-99/4096', bytes: 100 },
      xhr: { status: 200, bytes: expect.any(Number) },
      // „../“ endet an der Wurzel des Spiels: Es gibt dort nur dessen eigene index.html.
      traversal: '200',
      missing: '404',
      renos: 'TypeError',
      parent: 'SecurityError',
      storage: 'undefined',
      cookie: '',
    });

    await page.getByRole('button', { name: 'Steuerung einblenden' }).click();
    await page.getByTestId('player-controls').getByRole('button', { name: 'Spiel beenden' }).click();
    const library = await openApp(page, 'library');
    const card = library.getByRole('option', { name: /Lokales Spiel/ });
    await expect(card).toBeVisible();
    await card.click();
    await expect(library.getByTestId('game-saves-count')).toHaveText('Noch keine Spielstände');
    await card.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Entfernen …' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('mitsamt seinen Spielständen');
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

  test('externer Spiele-Host: liefert nur Dateien des laufenden Spiels', async ({ page }) => {
    await openDesktop(page, true);
    const file = writeZip('Extern-1.0-web.zip', webBuildEntries('Extern-1.0-web/', 'Externes Spiel'));
    const installer = await installLocally(page, file);
    await installer.getByRole('button', { name: 'Jetzt spielen' }).click();
    await expect(page.getByTestId('player')).toHaveAttribute('data-booted', 'true', { timeout: 30_000 });
    await expect(page.getByTestId('game-frame')).toHaveAttribute('data-host', 'origin');
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
      // Eingebauter Host: das iframe selbst. Externer Host: das Spiel-iframe in der Host-Seite.
      const outer = await (await page.getByTestId('game-frame').elementHandle())!.contentFrame();
      const frame = (await page.getByTestId('game-frame').getAttribute('data-host')) === 'builtin' ? outer : page.frames().find((f) => f.url().startsWith(`${HOST}play/`));
      expect(frame).toBeTruthy();
      return frame!;
    }

    async function playSaveAndReload(page: Page, check: (frame: Frame) => Promise<void>) {
      const installer = await installLocally(page, BUILD);
      await installer.getByRole('button', { name: 'Schließen' }).first().click();

      let frame = await start(page);
      expect(await exec(frame, 'result = persistent.starts')).toBe(1);
      await check(frame);
      // Isolation: Das Spiel kommt nicht an RenOS heran.
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
      return frame;
    }

    test('eingebauter Spiele-Host: echtes Spiel läuft isoliert und behält Spielstände', async ({ page }) => {
      await openDesktop(page, false);
      await playSaveAndReload(page, async (frame) => {
        await expect(page.getByTestId('game-frame')).toHaveAttribute('data-host', 'builtin');
        // Anonymer Origin: kein Zugriff auf RenOS, kein eigener Speicher im Browser.
        expect(await frame.evaluate(() => origin)).toBe('null');
        expect(await frame.evaluate(() => typeof (navigator as Navigator & { serviceWorker?: unknown }).serviceWorker)).toBe('undefined');
      });
      // Die Spielstände liegen bei RenOS, getrennt nach Spiel.
      const saves = await page.evaluate(async () => {
        const open = indexedDB.open('renos');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        const tx = db.transaction('saves', 'readonly');
        const all = await new Promise<{ gameId: string; key: string }[]>((resolve) => {
          const req = tx.objectStore('saves').getAll();
          req.onsuccess = () => resolve(req.result as { gameId: string; key: string }[]);
        });
        return { games: [...new Set(all.map((r) => r.gameId))].length, hasSave: all.some((r) => /1-1-LT1\.save$/.test(String(r.key))) };
      });
      expect(saves).toEqual({ games: 1, hasSave: true });

      // Spielstände in eine „neue Version“ übernehmen (hier: ein zweites, synthetisches Spiel).
      await page.getByRole('button', { name: 'Steuerung einblenden' }).click();
      await page.getByTestId('player-controls').getByRole('button', { name: 'Spiel beenden' }).click();
      const installer = await installLocally(page, writeZip('Neu-2.0-web.zip', webBuildEntries('Neu-2.0-web/', 'Neue Version')));
      await installer.getByRole('button', { name: 'Schließen' }).first().click();
      const library = await openApp(page, 'library');
      await library.getByRole('option', { name: /RenOS Testspiel/ }).click();
      await expect(library.getByTestId('game-saves-count')).not.toHaveText('Noch keine Spielstände');
      const sourceCount = await library.getByTestId('game-saves-count').textContent();
      await library.getByRole('option', { name: /Neue Version/ }).click();
      await expect(library.getByTestId('game-saves-count')).toHaveText('Noch keine Spielstände');
      await library.getByTestId('game-saves-copy').click();
      await page.getByRole('menuitem', { name: /RenOS Testspiel/ }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Spielstände übernehmen' }).click();
      // Gleiche Anzahl Dateien. (Die Größe nicht vergleichen: Ren’Py schreibt „persistent“ beim Beenden
      // eventuell noch einmal, die gerundete KB-Angabe kann sich dadurch um eins unterscheiden.)
      const files = /^\d+ Dateien?/.exec(sourceCount ?? '')?.[0];
      expect(files).toBeTruthy();
      await expect(library.getByTestId('game-saves-count')).toContainText(files!);
    });

    test('eingebauter Spiele-Host: startet ein installiertes Spiel auch offline', async ({ page, context }) => {
      await openDesktop(page, false);
      const installer = await installLocally(page, BUILD);
      await installer.getByRole('button', { name: 'Schließen' }).first().click();
      // Der Service Worker von RenOS muss die Oberfläche übernommen haben.
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
      await page.reload();
      await expect(page.getByTestId('desktop')).toBeVisible();
      await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

      await context.setOffline(true);
      await page.reload();
      await expect(page.getByTestId('desktop')).toBeVisible();
      const frame = await start(page);
      expect(await exec(frame, 'result = persistent.starts')).toBe(1);
      await context.setOffline(false);
    });

    test('externer Spiele-Host: echtes Spiel läuft auf dem zweiten Origin und behält Spielstände', async ({ page }) => {
      await openDesktop(page, true);
      await playSaveAndReload(page, async (frame) => {
        await expect(page.getByTestId('game-frame')).toHaveAttribute('data-host', 'origin');
        expect(await frame.evaluate(() => location.origin)).toBe(HOST_ORIGIN);
      });
    });
  });

  test.describe('Windows-/Linux-Spiele (Umwandlung mit Ren’Py-Laufzeit)', () => {
    test.setTimeout(300_000);

    const exec = (frame: Frame, code: string) =>
      frame.evaluate((c) => (window as unknown as { renpy_exec: (s: string) => Promise<unknown> }).renpy_exec(c), code);

    for (const { major, runtime } of [
      { major: 8, runtime: '8.6.0' },
      { major: 7, runtime: '7.8.7' },
    ]) {
      test(`Ren’Py ${major}: Windows/Linux-Build mit .rpa-Archiven wird umgewandelt, läuft offline und speichert`, async ({ page, context }) => {
        test.skip(!existsSync(DESKTOP(major)) || !existsSync(RUNTIMES), 'Testbuild oder Laufzeitpakete fehlen – siehe TESTING.md („npm run testgame:desktop“, RENPY_SDKS).');
        await openDesktop(page, false);
        const win = await openApp(page, 'installer');
        await chooseFile(page, () => win.getByTestId('installer-choose').click(), DESKTOP(major));
        const analysis = win.getByTestId('installer-analysis');
        await expect(analysis).toHaveAttribute('data-conversion', 'true', { timeout: 60_000 });
        await expect(analysis).toHaveAttribute('data-installable', 'true');
        await expect(analysis).toContainText('Windows, Linux');
        await expect(win.getByTestId('installer-engine')).toHaveText(runtime);
        await expect(win.getByTestId('installer-runtime')).toContainText(`Ren’Py ${runtime}`);
        await expect(win.locator('#installer-title')).toHaveValue('The Question');
        await win.getByTestId('installer-install').click();
        // Live-Protokoll während der Umwandlung.
        await expect(win.getByTestId('installer-log')).toContainText('Kopiere Archiv', { timeout: 60_000 });
        await expect(win.getByTestId('installer-live')).toContainText('letzte Aktivität');
        await expect(win.getByTestId('installer-done')).toBeVisible({ timeout: 240_000 });
        await expect(win.getByTestId('installer-note')).toContainText('nachgeladen');

        // Ein „Szenario“ (wie bei Student Transfer) liegt in RenOS bereit – das Spiel soll es über seinen
        // Datei-Dialog aus Files öffnen können.
        const scenarioImage = pngWithSize(300, 200, 120_000);
        const scenarioZip = writeZip('Testszenario.zip', [
          { name: 'testszenario/scenario.yml', data: 'title: Test\n' },
          { name: 'testszenario/bg/park.png', data: scenarioImage },
        ]);
        const files = await openApp(page, 'files');
        await chooseFile(page, () => files.getByRole('button', { name: 'Importieren' }).click(), scenarioZip);
        await expect(files.getByRole('option', { name: /Testszenario\.zip/ })).toHaveCount(1);
        await page.keyboard.press('Alt+w');
        await expect(windowOf(page, 'files')).toHaveCount(0);

        await win.getByRole('button', { name: 'Jetzt spielen' }).click();
        await expect(page.getByTestId('player')).toHaveAttribute('data-phase', 'running', { timeout: 180_000 });
        let frame = (await (await page.getByTestId('game-frame').elementHandle())!.contentFrame())!;
        // Die Engine stammt aus dem Laufzeitpaket, die Skripte aus scripts.rpa (nur .rpyc).
        expect(await exec(frame, 'result = renpy.version_only')).toMatch(new RegExp(`^${runtime.replace(/\./g, '\\.')}`));
        expect(await exec(frame, "result = renpy.has_label('start') and renpy.has_label('rightaway')")).toBe(true);
        // Ersatz für das Browser-Modul „js“, das manche Spiele importieren.
        expect(await exec(frame, "import js; result = bool(js.window.alert('x')) or str(js.document.title)")).toBe('');
        expect(
          await exec(frame, "import pyodide; from pyodide.ffi import create_proxy; import pyodide.http as h; result = str(bool(create_proxy(1))) + str(h.pyfetch)"),
        ).toBe('False');
        // Nachladbare Dateien liegen als Platzhalter am echten Pfad – Spiele, die selbst im Dateisystem suchen
        // (os.walk, glob, os.path.exists; z. B. Szenario-Bilder in Student Transfer), finden sie.
        expect(
          await exec(frame, "import os, _renos_host; result = [os.path.exists(os.path.join(config.gamedir, 'images/bg club.jpg')), 'bg club.jpg' in os.listdir(os.path.join(config.gamedir, 'images')), _renos_host.is_placeholder('images/bg club.jpg')]"),
        ).toEqual([true, true, true]);
        // Bilder aus images.rpa und lose Musik sind bekannt und werden aus dem iPad-Speicher nachgeladen – byte-genau.
        expect(await exec(frame, "result = renpy.loadable('images/bg club.jpg') and renpy.loadable('illurock.opus')")).toBe(true);
        await exec(frame, "renpy.webloader.enqueue('images/bg club.jpg', 'image', 'images/bg club.jpg'); renpy.webloader.enqueue('illurock.opus', 'music', None); result = True");
        await expect
          .poll(() => exec(frame, "import os; result = [os.path.getsize(os.path.join(config.gamedir, f)) if os.path.exists(os.path.join(config.gamedir, f)) else -1 for f in ('images/bg club.jpg', 'illurock.opus')]"), {
            timeout: 30_000,
          })
          .toEqual([984435, 234646]);
        // Nach dem Nachladen liegt das echte Bild am Pfad; Ren'Pys Aufräumen legt wieder den Platzhalter hin.
        expect(await exec(frame, "import _renos_host; result = _renos_host.is_placeholder('images/bg club.jpg')")).toBe(false);
        expect(
          await exec(frame, "import os, _renos_host; p = os.path.join(config.gamedir, 'images/bg club.jpg'); renpy.webloader.os.unlink(p); result = [os.path.exists(p), _renos_host.is_placeholder('images/bg club.jpg')]"),
        ).toEqual([true, true]);

        // Datei-Dialog im Spiel (_renpytfd, wie „Szenario hinzufügen“) → Dateiauswahl von RenOS.
        // Aufruf aus Ren'Pys Hauptschleife – wie bei einem Knopf im Spiel (Ren'Py 7 kann nur dort warten).
        await exec(
          frame,
          "store._renos_picked = None\ndef _renos_pick():\n    import _renpytfd\n    store._renos_picked = _renpytfd.openFileDialog('Choose Scenario Package', '', ['*.zip'], None) or ''\nrenpy.invoke_in_main_thread(_renos_pick)\nresult = True",
        );
        const picker = page.getByTestId('file-picker');
        await expect(picker).toBeVisible({ timeout: 15_000 });
        await expect(picker).toContainText('Choose Scenario Package');
        await picker.getByRole('button', { name: 'Persönlicher Ordner' }).click();
        await picker.locator('[data-testid="file-picker-item"][data-name="Testszenario.zip"]').click();
        await picker.getByTestId('file-picker-open').click();
        await expect.poll(() => exec(frame, 'result = store._renos_picked'), { timeout: 15_000 }).toMatch(/^\/tmp\/renos-picked\/\d+\/Testszenario\.zip$/);
        // Das Spiel entpackt es in seinen Spielordner (wie Student Transfer) – RenOS bewahrt die Dateien auf.
        expect(
          await exec(frame, "import zipfile, os, _renos_host; z = zipfile.ZipFile(store._renos_picked); z.extractall(os.path.join(config.gamedir, 'scenario')); _renos_host.sync(); result = sorted(z.namelist())"),
        ).toEqual(['testszenario/bg/park.png', 'testszenario/scenario.yml']);
        await expect.poll(() => overlayPaths(page), { timeout: 20_000 }).toEqual(['game/scenario/testszenario/bg/park.png', 'game/scenario/testszenario/scenario.yml']);
        // „Speichern unter“ im Spiel landet in Files → Downloads.
        await exec(frame, "import _renpytfd; p = _renpytfd.saveFileDialog('Export', 'mein-szenario.zip', ['*.zip'], None); f = open(p, 'wb'); f.write(b'PK' * 500); f.close(); result = p");
        await expect.poll(() => filesNamed(page, 'mein-szenario.zip'), { timeout: 30_000 }).toEqual([{ parentId: 'downloads', size: 1000 }]);

        // „Start“ im Hauptmenü: Das Skript aus scripts.rpa läuft, Musik und Hintergrund werden nachgeladen.
        await page.getByTestId('game-frame').click({ position: { x: 68, y: 336 } });
        await expect.poll(() => exec(frame, 'result = renpy.get_filename_line()[0]'), { timeout: 30_000 }).toMatch(/script\.rpyc?$/);
        await expect.poll(() => exec(frame, "result = renpy.music.get_playing()"), { timeout: 30_000 }).toBe('illurock.opus');
        await expect.poll(() => exec(frame, "result = 'bg' in renpy.get_showing_tags('master')"), { timeout: 30_000 }).toBe(true);
        await exec(frame, "renpy.save('1-1', 'RenOS Umwandlung'); result = True");
        await page.waitForTimeout(1500);

        await page.getByRole('button', { name: 'Steuerung einblenden' }).click();
        await page.getByTestId('player-controls').getByRole('button', { name: 'Spiel beenden' }).click();

        // Installation einer früheren RenOS-Fassung nachstellen (.rpy neben .rpyc, keine Versionsmarke).
        const legacySource = await makeLegacyInstall(page);
        const logs: string[] = [];
        page.on('console', (message) => logs.push(message.text()));

        // Zweiter Start ohne Netzwerk: Laufzeit und Spiel liegen vollständig auf dem Gerät.
        await page.evaluate(async () => {
          await navigator.serviceWorker.ready;
        });
        await page.reload();
        await expect(page.getByTestId('desktop')).toBeVisible();
        await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
        await context.setOffline(true);
        await page.reload();
        await expect(page.getByTestId('desktop')).toBeVisible();
        const library = await openApp(page, 'library');
        await library.getByRole('option', { name: /The Question/ }).click();
        await expect(library.getByTestId('game-origin')).toContainText(`Windows, Linux-Build (Ren’Py ${runtime}), umgewandelt · Laufzeit Ren’Py ${runtime}`);
        // Was das Spiel selbst angelegt hat (das Testszenario), zeigt die Library an.
        await expect(library.getByTestId('game-added-files')).toContainText('2 Dateien');
        await library.getByRole('option', { name: /The Question/ }).dblclick();
        await expect(page.getByTestId('player')).toHaveAttribute('data-phase', 'running', { timeout: 180_000 });
        frame = (await (await page.getByTestId('game-frame').elementHandle())!.contentFrame())!;
        expect(await exec(frame, "result = renpy.can_load('1-1')")).toBe(true);
        // Das im Spiel installierte Szenario ist nach dem Neustart wieder da – das Bild als Platzhalter, nachladbar.
        expect(
          await exec(frame, "import os, _renos_host; g = config.gamedir; result = [open(os.path.join(g, 'scenario/testszenario/scenario.yml')).read(), os.path.exists(os.path.join(g, 'scenario/testszenario/bg/park.png')), _renos_host.is_placeholder('scenario/testszenario/bg/park.png'), bool(renpy.loadable('scenario/testszenario/bg/park.png'))]"),
        ).toEqual(['title: Test\n', true, true, true]);
        await exec(frame, "renpy.webloader.enqueue('scenario/testszenario/bg/park.png', 'image', 'scenario/testszenario/bg/park.png'); result = True");
        await expect
          .poll(() => exec(frame, "import os, _renos_host; result = [os.path.getsize(os.path.join(config.gamedir, 'scenario/testszenario/bg/park.png')), _renos_host.is_placeholder('scenario/testszenario/bg/park.png')]"), { timeout: 30_000 })
          .toEqual([scenarioImage.byteLength, false]);
        // Ältere Installation wurde beim Start repariert: Die .rpy fehlt in der gelieferten game.zip, das
        // Skript lief ohne „Parsing the script failed“, das Unterstützungsskript ist dabei.
        expect(await exec(frame, `result = renpy.loadable(${JSON.stringify(legacySource)})`)).toBe(false);
        expect(await exec(frame, "result = renpy.has_label('start') and not renpy.has_label('renos_legacy_check')")).toBe(true);
        expect(await exec(frame, "result = renpy.loadable('renos_web_support.rpy')")).toBe(true);
        expect(logs.some((line) => /game\.zip von .*: 1 \.rpy ausgelassen/.test(line))).toBe(true);
        await context.setOffline(false);
      });
    }
  });
});

