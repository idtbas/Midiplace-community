#!/usr/bin/env node
/**
 * Erzeugt für jedes SDK in RENPY_SDKS einen Windows/Linux-Download von „The Question“
 * (e2e/fixtures/generated/TheQuestion-<Hauptversion>-pc.zip) für die End-to-End-Tests der Umwandlung.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdks = (process.env.RENPY_SDKS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (!sdks.length) {
  console.error('Bitte RENPY_SDKS setzen (SDK-Ordner, durch Kommas getrennt).');
  process.exit(1);
}
for (const sdk of sdks) {
  const vc = readFileSync(path.join(sdk, 'renpy', 'vc_version.py'), 'utf8');
  const major = Number(/version\s*=\s*u?['"](\d+)\./.exec(vc)?.[1]);
  const target = path.join(root, `e2e/fixtures/generated/TheQuestion-${major}-pc.zip`);
  const args = ['-I', path.join(root, 'scripts/make_renpy_desktop_fixture.py'), sdk, target, ...(major < 8 ? ['--python', '2'] : [])];
  const result = spawnSync('python3', args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
