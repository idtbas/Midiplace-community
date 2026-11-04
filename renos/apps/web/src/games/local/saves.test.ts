import { beforeEach, describe, expect, it } from 'vitest';
import { db, type LocalGame } from '@/persistence/db';
import { SAVE_LIMITS, applySaveChanges, copySaves, deleteSaves, estimateSize, loadSaves, saveStats } from './saves';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function game(id: string): LocalGame {
  return { id, title: id, entry: 'index.html', sizeBytes: 1, fileCount: 1, installedAt: '2026-01-01T00:00:00Z', lastPlayedAt: null, sourceFileName: 'x.zip', runtime: 'wasm', coverVersion: 0 };
}

const entry = (key: string, bytes = 10) => ({
  db: '/home/web_user/.renpy',
  store: 'FILE_DATA',
  key,
  value: { timestamp: new Date(1_700_000_000_000), mode: 33206, contents: new Uint8Array(bytes) },
});

beforeEach(async () => {
  await db.delete();
  await db.open();
  await db.games.bulkAdd([game(A), game(B)]);
});

describe('Spielstände im eingebauten Spiele-Host', () => {
  it('speichert, liest und löscht Einträge getrennt pro Spiel', async () => {
    expect(await applySaveChanges(A, [entry('/home/web_user/.renpy/x/1-1-LT1.save', 100), entry('/home/web_user/.renpy/x/persistent')], [])).toEqual({ ok: true });
    expect(await applySaveChanges(B, [entry('/home/web_user/.renpy/y/persistent')], [])).toEqual({ ok: true });

    const saves = await loadSaves(A);
    expect(saves.map((s) => s.key).sort()).toEqual(['/home/web_user/.renpy/x/1-1-LT1.save', '/home/web_user/.renpy/x/persistent']);
    const value = saves.find((s) => String(s.key).endsWith('.save'))!.value as { timestamp: Date; contents: Uint8Array };
    expect(value.timestamp).toBeInstanceOf(Date);
    expect(value.contents.byteLength).toBe(100);
    expect((await loadSaves(B)).length).toBe(1);

    expect(await applySaveChanges(A, [], [{ db: '/home/web_user/.renpy', store: 'FILE_DATA', key: '/home/web_user/.renpy/x/persistent' }])).toEqual({ ok: true });
    expect((await loadSaves(A)).length).toBe(1);
    expect(await saveStats(A)).toEqual({ count: 1, bytes: estimateSize(entry('', 100).value) });
  });

  it('lehnt ungültige Einträge ab und speichert dann gar nichts', async () => {
    const results = await Promise.all([
      applySaveChanges(A, 'kaputt', []),
      applySaveChanges(A, [entry('ok'), { db: '', store: 'FILE_DATA', key: 'x', value: 1 }], []),
      applySaveChanges(A, [{ ...entry('x'), key: { nested: true } }], []),
      applySaveChanges(A, [{ ...entry('x'), key: 'k'.repeat(SAVE_LIMITS.maxKeyLength + 1) }], []),
      applySaveChanges(A, [{ ...entry('x'), value: () => 1 }], []),
      applySaveChanges(A, [{ ...entry('x'), value: new Map() }], []),
      applySaveChanges('../../etc', [entry('x')], []),
    ]);
    for (const result of results) expect(result.ok).toBe(false);
    expect(await loadSaves(A)).toEqual([]);
  });

  it('nimmt keine Spielstände für nicht installierte Spiele an', async () => {
    await db.games.delete(B);
    expect(await applySaveChanges(B, [entry('x')], [])).toEqual({ ok: false, reason: 'Dieses Spiel ist nicht mehr installiert.' });
    expect(await loadSaves(B)).toEqual([]);
  });

  it('begrenzt die Größe einzelner Einträge und den Gesamtspeicher eines Spiels', async () => {
    const big = { ...entry('big'), value: { contents: { byteLength: 0 } } };
    expect((await applySaveChanges(A, [big], [])).ok).toBe(true);
    const tooBig = await applySaveChanges(A, [{ ...entry('huge'), value: new Uint8Array(SAVE_LIMITS.maxRecordBytes + 1) }], []);
    expect(tooBig).toEqual({ ok: false, reason: 'Ein Spielstand ist zu groß.' });

    const chunk = new Uint8Array(SAVE_LIMITS.maxRecordBytes - 64);
    const many = Array.from({ length: Math.ceil(SAVE_LIMITS.maxGameBytes / chunk.byteLength) + 1 }, (_, i) => ({ ...entry(`f${i}`), value: chunk }));
    const full = await applySaveChanges(A, many, []);
    expect(full).toEqual({ ok: false, reason: 'Der Speicherplatz für Spielstände dieses Spiels ist voll.' });
    expect((await loadSaves(A)).map((s) => s.key)).toEqual(['big']);
  });

  it('übernimmt Spielstände in eine neue Version und löscht sie mit dem Spiel', async () => {
    await applySaveChanges(A, [entry('/home/web_user/.renpy/x/1-1-LT1.save'), entry('/home/web_user/.renpy/x/persistent')], []);
    await applySaveChanges(B, [entry('/home/web_user/.renpy/x/alt')], []);
    expect(await copySaves(A, B)).toBe(2);
    expect((await loadSaves(B)).map((s) => s.key).sort()).toEqual(['/home/web_user/.renpy/x/1-1-LT1.save', '/home/web_user/.renpy/x/persistent']);
    expect((await loadSaves(A)).length).toBe(2);
    expect(await copySaves(A, A)).toBe(0);

    await deleteSaves(A);
    expect(await loadSaves(A)).toEqual([]);
    expect((await loadSaves(B)).length).toBe(2);
  });
});
