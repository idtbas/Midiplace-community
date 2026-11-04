#!/usr/bin/env node
/**
 * Setzt das RenOS-Testspiel (e2e/renpy-testgame) zu einem Ren'Py-Web-Build zusammen –
 * in derselben Struktur, die der Ren'Py-Launcher („Web (Beta)“ → „Build Web Application“) erzeugt:
 *
 *   RenOSTestspiel-1.0-web/
 *     index.html, renpy.js, renpy.wasm, renpy.data, renpy-pre.js, service-worker.js, manifest.json, …
 *     game.zip   →  main.py, renpy/** (kompilierte Engine), game/** (Spielskripte)
 *
 * Grundlage ist ausschließlich das offizielle Ren'Py-SDK mit installierter Web-Unterstützung
 * (Ordner `web/` im SDK). Es wird nichts aus dem SDK ausgeführt – das Skript kopiert und packt nur.
 * Die .rpy-Skripte des Testspiels kompiliert die Ren'Py-Laufzeit beim ersten Start im Browser.
 *
 *   npm run testgame -- /pfad/zu/renpy-8.x-sdk
 *
 * Ergebnis: e2e/fixtures/generated/RenOSTestspiel-1.0-web.zip (nicht im Repository).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdk = path.resolve(process.argv[2] ?? process.env.RENPY_SDK ?? '');
const outDir = path.join(root, 'e2e/fixtures/generated');
const gameSrc = path.join(root, 'e2e/renpy-testgame/game');
const title = 'RenOS Testspiel';
const folder = 'RenOSTestspiel-1.0-web';

if (!sdk || !existsSync(path.join(sdk, 'renpy.py')) || !existsSync(path.join(sdk, 'web/renpy.wasm'))) {
  console.error('Bitte den Pfad zu einem Ren’Py-SDK mit Web-Unterstützung angeben (Ordner mit renpy.py und web/renpy.wasm).');
  console.error('Download: https://www.renpy.org/latest.html  (SDK + „Web“-Paket in den SDK-Ordner entpacken)');
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) out.push(...walk(full));
    else if (stats.isFile()) out.push(full);
  }
  return out;
}

const pycTag = (() => {
  const sample = walk(path.join(sdk, 'renpy')).find((f) => /__pycache__\/.+\.cpython-\d+\.pyc$/.test(f));
  const match = sample && /\.(cpython-\d+)\.pyc$/.exec(sample);
  if (!match) throw new Error('Keine kompilierten Engine-Module (__pycache__) im SDK gefunden.');
  return match[1];
})();

// ----- game.zip ---------------------------------------------------------------
// Entspricht dem Ren'Py-Paket „web“ (Dateilisten „web renpy all“) inklusive Web-Transformation:
// .py-Dateien unter renpy/ entfallen, __pycache__/X.<tag>.pyc wird zu X.pyc.
const gameZip = {};
let engineFiles = 0;
gameZip['main.py'] = readFileSync(path.join(sdk, 'renpy.py'));

for (const file of walk(path.join(sdk, 'renpy'))) {
  const rel = path.relative(sdk, file).split(path.sep).join('/');
  const base = path.posix.basename(rel);
  if (base.startsWith('.') || base.endsWith('~') || base.startsWith('#')) continue;
  if (/\.(pxd|pxi|pyx|pyo|old|new|rpa|rpe)$/.test(rel) || rel.endsWith('.rpe.py')) continue;
  let target = rel;
  if (rel.includes('/__pycache__/')) {
    if (!rel.endsWith(`.${pycTag}.pyc`)) continue;
    target = rel.replace('/__pycache__/', '/').replace(`.${pycTag}.pyc`, '.pyc');
  } else if (rel.endsWith('.py') || rel.endsWith('.pyc')) {
    continue;
  }
  gameZip[target] = readFileSync(file);
  engineFiles += 1;
}

for (const file of walk(gameSrc)) {
  const rel = path.relative(path.dirname(gameSrc), file).split(path.sep).join('/');
  gameZip[rel] = readFileSync(file);
}
// Liste progressiv geladener Dateien (das Testspiel lädt alles vorab).
gameZip['game/renpyweb_remote_files.txt'] = strToU8('');

const gameZipData = zipSync(gameZip, { level: 6 });

// ----- Web-Build ----------------------------------------------------------------
const build = {};
const webDir = path.join(sdk, 'web');
for (const name of readdirSync(webDir)) {
  if (['game.zip', 'hash.txt', 'index.html', 'web-icon.png'].includes(name)) continue;
  const full = path.join(webDir, name);
  if (statSync(full).isFile()) build[`${folder}/${name}`] = readFileSync(full);
}
build[`${folder}/index.html`] = strToU8(readFileSync(path.join(webDir, 'index.html'), 'utf8').replaceAll("Ren'Py Web Game", title));
const manifest = JSON.parse(readFileSync(path.join(webDir, 'manifest.json'), 'utf8'));
manifest.name = title;
build[`${folder}/manifest.json`] = strToU8(JSON.stringify(manifest));
// Symbole wie im Launcher (Größen werden hier nicht neu berechnet).
const icon = readFileSync(path.join(webDir, 'web-icon.png'));
for (const size of [72, 96, 128, 144, 152, 192, 384, 512]) {
  build[`${folder}/icons/icon-${size}x${size}.png`] = icon;
  build[`${folder}/icons/icon-${size}x${size}-maskable.png`] = icon;
}
build[`${folder}/game.zip`] = gameZipData;
build[`${folder}/pwa_catalog.json`] = strToU8(
  JSON.stringify({ files: Object.keys(build).map((k) => k.slice(folder.length + 1)), version: Math.floor(Date.now() / 1000) }),
);

mkdirSync(outDir, { recursive: true });
const zipPath = path.join(outDir, `${folder}.zip`);
// Bereits komprimierte Dateien (wasm, data, zip, png) nur speichern.
const zipped = zipSync(
  Object.fromEntries(Object.entries(build).map(([k, v]) => [k, /\.(zip|png|jpg|data|wasm)$/.test(k) ? [v, { level: 0 }] : v])),
  { level: 6 },
);
writeFileSync(zipPath, zipped);

console.log(`Engine-Dateien: ${engineFiles} (Bytecode ${pycTag})`);
console.log(`game.zip: ${(gameZipData.length / 1024 / 1024).toFixed(1)} MB`);
console.log(`Web-Build: ${path.relative(root, zipPath)} (${(zipped.length / 1024 / 1024).toFixed(1)} MB)`);
