import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeArchive, extractArchive, titleFromHtml, type ArchiveLimits } from '../src/zip/archive.js';
import { checkEntryPath, resolveInside } from '../src/zip/paths.js';
import { makeZip, webBuildEntries, type ZipEntrySpec } from './helpers/zip.js';

const limits: ArchiveLimits = { maxEntries: 1000, maxUncompressedBytes: 64 * 1024 * 1024, maxCompressionRatio: 200 };
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'renos-archive-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function analyze(entries: ZipEntrySpec[] | Buffer, l: ArchiveLimits = limits, name = 'test.zip') {
  const file = path.join(dir, `${Math.random().toString(36).slice(2)}.zip`);
  const data = Buffer.isBuffer(entries) ? entries : makeZip(entries);
  await writeFile(file, data);
  return { file, analysis: await analyzeArchive(file, name, data.length, l) };
}

describe('checkEntryPath', () => {
  it('accepts normal relative paths', () => {
    expect(checkEntryPath('game/script.rpy')).toEqual({ ok: true, path: 'game/script.rpy', isDirectory: false });
    expect(checkEntryPath('game/')).toEqual({ ok: true, path: 'game', isDirectory: true });
  });
  it('rejects traversal, absolute paths and odd names', () => {
    expect(checkEntryPath('../x')).toMatchObject({ ok: false, code: 'path_traversal' });
    expect(checkEntryPath('a/../../x')).toMatchObject({ ok: false, code: 'path_traversal' });
    expect(checkEntryPath('/etc/passwd')).toMatchObject({ ok: false, code: 'absolute_path' });
    expect(checkEntryPath('C:/Windows/x')).toMatchObject({ ok: false, code: 'absolute_path' });
    expect(checkEntryPath('a\\b')).toMatchObject({ ok: false, code: 'unsafe_path' });
    expect(checkEntryPath('a//b')).toMatchObject({ ok: false, code: 'unsafe_path' });
    expect(checkEntryPath('a/./b')).toMatchObject({ ok: false, code: 'unsafe_path' });
    expect(checkEntryPath('bad\u0000name')).toMatchObject({ ok: false, code: 'invalid_filename' });
    expect(checkEntryPath('')).toMatchObject({ ok: false, code: 'invalid_filename' });
  });
  it('resolveInside never leaves the root', () => {
    expect(resolveInside('/srv/root', 'a/b')).toBe(path.resolve('/srv/root/a/b'));
    expect(resolveInside('/srv/root', '../x')).toBeNull();
    expect(resolveInside('/srv/root', '')).toBeNull();
  });
});

describe('analyzeArchive', () => {
  it('detects a Ren’Py web build at the archive root', async () => {
    const { analysis } = await analyze(webBuildEntries('', 'Mein &amp; Spiel'));
    expect(analysis.kind).toBe('renpy-web');
    expect(analysis.installable).toBe(true);
    expect(analysis.rootPrefix).toBe('');
    expect(analysis.entryPoint).toBe('index.html');
    expect(analysis.runtime).toBe('wasm');
    expect(analysis.detectedTitle).toBe('Mein & Spiel');
    expect(analysis.presplash).toBe('web-presplash.png');
    expect(analysis.checks.every((c) => c.ok)).toBe(true);
  });

  it('supports one common parent folder and ignores macOS junk', async () => {
    const { analysis } = await analyze([
      ...webBuildEntries('Spiel-1.0-web/'),
      { name: '__MACOSX/Spiel-1.0-web/._index.html', data: 'x' },
      { name: 'Spiel-1.0-web/.DS_Store', data: 'x' },
    ]);
    expect(analysis.kind).toBe('renpy-web');
    expect(analysis.rootPrefix).toBe('Spiel-1.0-web/');
    expect(analysis.installable).toBe(true);
  });

  it('falls back to the folder name when the title is the Ren’Py default', async () => {
    const entries = webBuildEntries('Sternenlicht-1.0-web/', "Ren'Py Web Game");
    const { analysis } = await analyze(entries);
    expect(analysis.detectedTitle).toBe('Sternenlicht 1.0');
  });

  it('flags missing game data', async () => {
    const entries = webBuildEntries().filter((e) => e.name !== 'game.zip');
    const { analysis } = await analyze(entries);
    expect(analysis.kind).toBe('renpy-web');
    expect(analysis.installable).toBe(false);
    expect(analysis.issues).toContainEqual({ code: 'missing_game_data', severity: 'error' });
  });

  it('rejects path traversal (Zip Slip)', async () => {
    const { analysis } = await analyze([...webBuildEntries(), { name: '../../evil.js', data: 'x' }]);
    expect(analysis.installable).toBe(false);
    expect(analysis.issues.map((i) => i.code)).toContain('path_traversal');
    expect(analysis.checks.find((c) => c.id === 'paths')?.ok).toBe(false);
  });

  it('treats backslash paths as traversal after normalisation', async () => {
    const { analysis } = await analyze([...webBuildEntries(), { name: 'a\\..\\..\\evil.js', data: 'x' }]);
    expect(analysis.issues.map((i) => i.code)).toContain('path_traversal');
    expect(analysis.installable).toBe(false);
  });

  it('rejects absolute paths', async () => {
    const { analysis } = await analyze([...webBuildEntries(), { name: '/etc/cron.d/evil', data: 'x' }]);
    expect(analysis.issues.map((i) => i.code)).toContain('absolute_path');
  });

  it('rejects symlinks', async () => {
    const { analysis } = await analyze([...webBuildEntries(), { name: 'link', data: '/etc/passwd', mode: 0o120777, method: 0 }]);
    expect(analysis.issues.map((i) => i.code)).toContain('symlink');
    expect(analysis.installable).toBe(false);
  });

  it('rejects duplicate and conflicting entries', async () => {
    const dup = await analyze([...webBuildEntries(), { name: 'INDEX.html', data: 'x' }]);
    expect(dup.analysis.issues.map((i) => i.code)).toContain('duplicate_entry');
    const conflict = await analyze([...webBuildEntries(), { name: 'data', data: 'x' }, { name: 'data/inner.txt', data: 'y' }]);
    expect(conflict.analysis.issues.map((i) => i.code)).toContain('duplicate_entry');
  });

  it('rejects encrypted entries', async () => {
    const { analysis } = await analyze([...webBuildEntries(), { name: 'secret.bin', data: 'x', method: 8, encrypted: true }]);
    expect(analysis.issues.map((i) => i.code)).toContain('encrypted_entry');
  });

  it('rejects archives with too many entries', async () => {
    const { analysis } = await analyze(webBuildEntries(), { ...limits, maxEntries: 3 });
    expect(analysis.issues.map((i) => i.code)).toContain('too_many_entries');
    expect(analysis.installable).toBe(false);
  });

  it('rejects zip bombs by compression ratio', async () => {
    const { analysis } = await analyze([...webBuildEntries(), { name: 'bomb.bin', data: Buffer.alloc(8 * 1024 * 1024) }]);
    expect(analysis.issues.map((i) => i.code)).toContain('suspicious_ratio');
    expect(analysis.installable).toBe(false);
  });

  it('rejects archives exceeding the uncompressed limit', async () => {
    const { analysis } = await analyze(
      [...webBuildEntries(), { name: 'big.bin', data: Buffer.alloc(300 * 1024, 1), method: 0 }],
      { ...limits, maxUncompressedBytes: 200 * 1024 },
    );
    expect(analysis.issues.map((i) => i.code)).toContain('too_large_uncompressed');
  });

  it('reports files that are not zip archives', async () => {
    const { analysis } = await analyze(Buffer.from('Das ist keine ZIP-Datei, sondern Text.'));
    expect(analysis.kind).toBe('unknown');
    expect(analysis.issues).toEqual([{ code: 'not_a_zip', severity: 'error' }]);
  });

  it('classifies desktop builds, projects and unknown archives', async () => {
    const desktop = await analyze([
      { name: 'Spiel-1.0-pc/game/script.rpyc', data: 'x' },
      { name: 'Spiel-1.0-pc/renpy/common/00start.rpy', data: 'x' },
      { name: 'Spiel-1.0-pc/Spiel.exe', data: 'MZ' },
      { name: 'Spiel-1.0-pc/Spiel.sh', data: '#!/bin/sh' },
    ]);
    expect(desktop.analysis.kind).toBe('renpy-desktop');
    expect(desktop.analysis.installable).toBe(false);

    const project = await analyze([
      { name: 'meinprojekt/game/script.rpy', data: 'label start:\n    "Hallo"' },
      { name: 'meinprojekt/game/options.rpy', data: 'define config.name = "x"' },
    ]);
    expect(project.analysis.kind).toBe('renpy-project');
    expect(project.analysis.installable).toBe(false);

    const unknown = await analyze([{ name: 'readme.txt', data: 'hallo' }]);
    expect(unknown.analysis.kind).toBe('unknown');
    expect(unknown.analysis.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['missing_entry_point', 'missing_runtime']));

    const nested = await analyze([{ name: 'spiel-web.zip', data: Buffer.alloc(10), method: 0 }]);
    expect(nested.analysis.issues.map((i) => i.code)).toContain('nested_archive_only');
  });

  it('warns about executables inside a web build', async () => {
    const { analysis } = await analyze([...webBuildEntries(), { name: 'tool.exe', data: 'MZ' }]);
    expect(analysis.installable).toBe(true);
    expect(analysis.issues).toContainEqual({ code: 'executable_content', severity: 'warning', path: 'tool.exe' });
  });
});

describe('extractArchive', () => {
  it('extracts the web build, strips the parent folder and skips executables', async () => {
    const { file } = await analyze([...webBuildEntries('Spiel-web/'), { name: 'Spiel-web/run.exe', data: 'MZ' }, { name: 'Spiel-web/sub/', data: '' }]);
    const target = await mkdtemp(path.join(dir, 'out-'));
    const result = await extractArchive(file, target, 'Spiel-web/', limits, () => undefined);
    const files = (await readdir(target)).sort();
    expect(files).toEqual(['game.zip', 'index.html', 'renpy-pre.js', 'renpy.data', 'renpy.js', 'renpy.wasm', 'sub', 'web-presplash.png']);
    expect(result.filesWritten).toBe(7);
    expect(await readFile(path.join(target, 'game.zip'))).toEqual(Buffer.alloc(4096, 3));
  });

  it('aborts when an entry contains more data than declared (lying zip bomb)', async () => {
    const { file, analysis } = await analyze([...webBuildEntries(), { name: 'liar.bin', data: Buffer.alloc(64 * 1024, 1), declaredSize: 1000 }]);
    expect(analysis.installable).toBe(true); // die Lüge ist erst beim Entpacken erkennbar
    const target = await mkdtemp(path.join(dir, 'out-'));
    await expect(extractArchive(file, target, '', limits, () => undefined)).rejects.toThrow();
  });

  it('refuses to extract archives with unsafe entries', async () => {
    const { file } = await analyze([...webBuildEntries(), { name: '../escape.txt', data: 'x' }]);
    const target = await mkdtemp(path.join(dir, 'out-'));
    await expect(extractArchive(file, target, '', limits, () => undefined)).rejects.toThrow();
    await expect(readFile(path.join(dir, 'escape.txt'))).rejects.toThrow();
  });
});

describe('titleFromHtml', () => {
  it('decodes entities and ignores the default title', () => {
    expect(titleFromHtml('<title>Ein &quot;Test&quot;</title>')).toBe('Ein "Test"');
    expect(titleFromHtml("<title>Ren'Py Web Game</title>")).toBeNull();
    expect(titleFromHtml('<p>kein Titel</p>')).toBeNull();
  });
});
