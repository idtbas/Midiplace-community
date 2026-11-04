#!/usr/bin/env node
/**
 * Baut Ren'Py-Laufzeitpakete für RenOS aus offiziellen Ren'Py-SDKs (mit installiertem Web-Paket).
 *
 * Mit einem Laufzeitpaket wandelt RenOS Windows-/Linux-/Mac-Builds von Ren'Py-Spielen auf dem Gerät in
 * Web-Builds um. Ein Paket enthält genau das, was der Ren'Py-Launcher („Web (Beta)“) einem Web-Build
 * mitgibt:
 *   - die Web-Laufzeit (WebAssembly-Engine, Python, Loader-Skripte) aus dem Ordner `web/` des SDK
 *   - engine.zip: main.py (= renpy.py) und das Ren'Py-Paket `renpy/` wie im Paket „web“ (Dateilisten
 *     „web renpy all“); bei Python 3 mit Web-Transformation (__pycache__/X.<tag>.pyc → X.pyc, ohne .py)
 *   - LICENSE.txt des SDK und runtime.json (Beschreibung)
 *
 * Aus dem SDK wird nichts ausgeführt – das Skript liest und kopiert nur Dateien.
 *
 *   node scripts/build-renpy-runtime.mjs --out <ziel> <sdk-ordner> [<sdk-ordner> …]
 *
 * Erwartete SDK-Struktur: <sdk>/renpy.py, <sdk>/renpy/, <sdk>/LICENSE.txt, <sdk>/web/ (Inhalt von renpy-<v>-web.zip).
 * Ergebnis: <ziel>/renpy-<version>/… und <ziel>/index.json (Liste aller Pakete).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { zipSync } from 'fflate';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
if (outIndex < 0 || !args[outIndex + 1]) {
  console.error('Aufruf: node scripts/build-renpy-runtime.mjs --out <ziel> <sdk-ordner> [<sdk-ordner> …]');
  process.exit(1);
}
const outDir = path.resolve(args[outIndex + 1]);
const sdks = args.filter((_, i) => i !== outIndex && i !== outIndex + 1).map((p) => path.resolve(p));
if (!sdks.length) {
  console.error('Mindestens ein SDK-Ordner ist nötig.');
  process.exit(1);
}

// Dateien der Web-Laufzeit, die ein Spiel nicht braucht.
const SKIP_WEB = new Set(['hash.txt', 'index.html.symbols', 'manifest.json', 'service-worker.js', 'web-icon.png', 'htaccess.txt', 'game.zip']);

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

function readVersion(sdk) {
  const vc = readFileSync(path.join(sdk, 'renpy', 'vc_version.py'), 'utf8');
  const match = /^version\s*=\s*u?['"](\d+)\.(\d+)\.(\d+)(?:\.(\d+))?['"]/m.exec(vc);
  if (!match) throw new Error(`Keine Versionsangabe in ${sdk}/renpy/vc_version.py`);
  return { short: `${match[1]}.${match[2]}.${match[3]}`, full: match.slice(1).filter(Boolean).join('.'), major: Number(match[1]) };
}

function engineEntries(sdk) {
  const files = walk(path.join(sdk, 'renpy'));
  const cacheTag = (() => {
    const sample = files.find((f) => /__pycache__[/\\].+\.cpython-\d+\.pyc$/.test(f));
    const match = sample && /\.(cpython-\d+)\.pyc$/.exec(sample);
    return match ? match[1] : null;
  })();
  const python = cacheTag ? 3 : 2;
  if (python === 2 && !files.some((f) => f.endsWith('.pyo'))) throw new Error(`Weder __pycache__ noch .pyo in ${sdk}/renpy – kein vollständiges SDK?`);

  const entries = { 'main.py': readFileSync(path.join(sdk, 'renpy.py')) };
  for (const file of files) {
    const rel = path.relative(sdk, file).split(path.sep).join('/');
    const base = path.posix.basename(rel);
    if (base.startsWith('.') || base.endsWith('~') || base.startsWith('#')) continue;
    if (/\.(pxd|pxi|pyx|old|new|rpa|rpe)$/.test(rel) || rel.endsWith('.rpe.py')) continue;
    let target = rel;
    if (python === 3) {
      // Wie distribute.web_transform_renpy(): Quelltexte entfallen, Bytecode rückt eine Ebene nach oben.
      if (rel.includes('/__pycache__/')) {
        if (!rel.endsWith(`.${cacheTag}.pyc`)) continue;
        target = rel.replace('/__pycache__/', '/').replace(`.${cacheTag}.pyc`, '.pyc');
      } else if (rel.endsWith('.py') || rel.endsWith('.pyc') || rel.endsWith('.pyo')) {
        continue;
      }
    } else {
      // Python 2 (Ren'Py 7): .py und .pyo wie in den Dateilisten „renpy all“.
      if (rel.includes('/__pycache__/') || rel.endsWith('.pyc')) continue;
    }
    entries[target] = readFileSync(file);
  }
  return { entries, python, cacheTag };
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

mkdirSync(outDir, { recursive: true });
const indexPath = path.join(outDir, 'index.json');
const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { format: 1, runtimes: [] };

for (const sdk of sdks) {
  for (const required of ['renpy.py', 'renpy', 'web', 'LICENSE.txt']) {
    if (!existsSync(path.join(sdk, required))) throw new Error(`${sdk}: ${required} fehlt (SDK mit Web-Paket nötig).`);
  }
  const version = readVersion(sdk);
  const id = `renpy-${version.short}`;
  const target = path.join(outDir, id);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  const { entries, python, cacheTag } = engineEntries(sdk);
  const engineZip = zipSync(entries, { level: 6 });
  writeFileSync(path.join(target, 'engine.zip'), engineZip);

  const webDir = path.join(sdk, 'web');
  const webFiles = [];
  for (const name of readdirSync(webDir).sort()) {
    const full = path.join(webDir, name);
    if (SKIP_WEB.has(name) || !statSync(full).isFile()) continue;
    copyFileSync(full, path.join(target, name));
    webFiles.push(name);
  }
  if (!webFiles.includes('index.html')) throw new Error(`${webDir}/index.html fehlt.`);
  const generation = webFiles.includes('renpy-pre.js') ? 'web3' : webFiles.includes('pythonhome.data') ? 'renpyweb' : 'unknown';
  copyFileSync(path.join(sdk, 'LICENSE.txt'), path.join(target, 'LICENSE.txt'));

  const files = [...webFiles, 'engine.zip', 'LICENSE.txt'].map((name) => {
    const data = readFileSync(path.join(target, name));
    return { name, size: data.length, sha256: sha256(data) };
  });
  const manifest = {
    format: 1,
    id,
    engine: 'renpy',
    version: version.short,
    fullVersion: version.full,
    major: version.major,
    python,
    bytecode: cacheTag,
    generation,
    // Diese Dateien bilden zusammen mit der game.zip des Spiels den Web-Build.
    webFiles: webFiles.filter((n) => n !== 'index.html'),
    files,
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
  };
  writeFileSync(path.join(target, 'runtime.json'), JSON.stringify(manifest, null, 2));

  index.runtimes = index.runtimes.filter((r) => r.id !== id);
  index.runtimes.push({ id, version: version.short, major: version.major, python, generation, totalBytes: manifest.totalBytes });
  index.runtimes.sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }));
  console.log(`${id}: Python ${python}${cacheTag ? ` (${cacheTag})` : ''}, ${generation}, ${Object.keys(entries).length} Engine-Dateien, ${(manifest.totalBytes / 1024 / 1024).toFixed(1)} MB`);
}

writeFileSync(indexPath, JSON.stringify(index, null, 2));
console.log(`Index: ${path.relative(process.cwd(), indexPath)}`);
