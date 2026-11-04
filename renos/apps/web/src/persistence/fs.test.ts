import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import {
  FsError,
  HOME_ID,
  copyNodes,
  createFile,
  createFolder,
  deleteNodes,
  emptyTrash,
  getAncestors,
  initFileSystem,
  listChildren,
  listTrash,
  moveNodes,
  readBlob,
  renameNode,
  restoreNodes,
  searchNodes,
  trashNodes,
  uniqueName,
  validateName,
} from './fs';

beforeEach(async () => {
  await db.delete();
  await db.open();
  await initFileSystem();
});

describe('virtual file system', () => {
  it('creates the home folder with standard folders once', async () => {
    await initFileSystem();
    const names = (await listChildren(HOME_ID)).map((n) => n.name).sort();
    expect(names).toEqual(['Bilder', 'Dokumente', 'Downloads', 'Spielstände']);
  });

  it('creates, renames and validates folders', async () => {
    const folder = await createFolder(HOME_ID, 'Projekte');
    await expect(createFolder(HOME_ID, 'projekte')).rejects.toBeInstanceOf(FsError);
    await expect(createFolder(HOME_ID, 'a/b')).rejects.toBeInstanceOf(FsError);
    expect(validateName('  ')).not.toBeNull();
    expect(validateName('..')).not.toBeNull();
    await renameNode(folder.id, 'Archiv');
    expect((await listChildren(HOME_ID)).some((n) => n.name === 'Archiv')).toBe(true);
    await expect(renameNode('documents', 'X')).rejects.toBeInstanceOf(FsError);
  });

  it('stores file contents and avoids name collisions', async () => {
    const a = await createFile('documents', 'test.txt', new Blob(['eins']));
    const b = await createFile('documents', 'test.txt', new Blob(['zwei']));
    expect(a.name).toBe('test.txt');
    expect(b.name).toBe('test (2).txt');
    expect(await (await readBlob(b.id))!.text()).toBe('zwei');
    expect(await uniqueName('documents', 'test.txt')).toBe('test (3).txt');
  });

  it('moves items to the trash, restores and deletes them', async () => {
    const folder = await createFolder(HOME_ID, 'Alt');
    const file = await createFile(folder.id, 'datei.txt', new Blob(['x']));
    await trashNodes([folder.id]);
    expect((await listChildren(HOME_ID)).some((n) => n.id === folder.id)).toBe(false);
    expect((await listTrash()).map((n) => n.id)).toEqual([folder.id]);
    expect(await searchNodes('datei')).toEqual([]);
    await restoreNodes([folder.id]);
    expect((await searchNodes('datei')).map((n) => n.id)).toEqual([file.id]);
    await trashNodes([folder.id]);
    expect(await emptyTrash()).toBe(1);
    expect(await db.nodes.get(file.id)).toBeUndefined();
    expect(await readBlob(file.id)).toBeUndefined();
  });

  it('protects the standard folders', async () => {
    await trashNodes(['documents', HOME_ID]);
    await deleteNodes(['documents']);
    expect(await db.nodes.get('documents')).toBeDefined();
  });

  it('moves and copies recursively but never into itself', async () => {
    const a = await createFolder(HOME_ID, 'A');
    const b = await createFolder(a.id, 'B');
    await createFile(b.id, 'tief.txt', new Blob(['tief']));
    await expect(moveNodes([a.id], b.id)).rejects.toBeInstanceOf(FsError);
    await copyNodes([a.id], 'documents');
    const copy = (await listChildren('documents')).find((n) => n.name === 'A')!;
    const copyB = (await listChildren(copy.id))[0]!;
    const copied = (await listChildren(copyB.id))[0]!;
    expect(await (await readBlob(copied.id))!.text()).toBe('tief');
    await moveNodes([b.id], HOME_ID);
    expect((await getAncestors(b.id)).map((n) => n.id)).toEqual([HOME_ID, b.id]);
  });
});
