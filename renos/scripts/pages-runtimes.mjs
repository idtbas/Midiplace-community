#!/usr/bin/env node
/**
 * Fügt dem statischen RenOS-Build (apps/web/dist-local) die Ren'Py-Laufzeitpakete hinzu.
 * SDK-Ordner (mit Web-Paket) kommen aus RENPY_SDKS, getrennt durch Kommas – z. B. Ren'Py 8 und 7.
 * Ohne RENPY_SDKS entsteht ein Build ohne Laufzeitpakete (Web-Builds funktionieren, Windows-/Linux-Spiele nicht).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdks = (process.env.RENPY_SDKS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (!sdks.length) {
  console.log('RENPY_SDKS ist nicht gesetzt – Build ohne Ren’Py-Laufzeitpakete (Windows-/Linux-Spiele lassen sich damit nicht umwandeln).');
  process.exit(0);
}
const out = path.join(root, 'apps/web/dist-local/runtimes');
const result = spawnSync(process.execPath, [path.join(root, 'scripts/build-renpy-runtime.mjs'), '--out', out, ...sdks], { stdio: 'inherit' });
process.exit(result.status ?? 1);
