import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import { createBackup, restoreBackup } from './backup';
import { HOME_ID, createFile, createFolder, initFileSystem, listChildren, readBlob } from './fs';
import { useSettings } from '@/system/settings';

beforeEach(async () => {
  await db.delete();
  await db.open();
  await initFileSystem();
});

describe('backup', () => {
  it('round-trips notes, files and settings without deleting existing data', async () => {
    const folder = await createFolder(HOME_ID, 'Reise');
    await createFile(folder.id, 'plan.txt', new Blob(['Gleis 4']));
    await db.notes.add({ id: 'n1', title: 'Hallo', body: 'Hallo Welt', createdAt: 1, updatedAt: 2 });
    useSettings.getState().set('accent', 'salbei');
    const backup = await createBackup();

    await db.notes.clear();
    useSettings.getState().set('accent', 'blau');
    const result = await restoreBackup(backup);
    expect(result.notes).toBe(1);
    expect(result.files).toBeGreaterThanOrEqual(2);
    expect(useSettings.getState().accent).toBe('salbei');
    expect((await db.notes.get('n1'))?.body).toBe('Hallo Welt');

    const restoredRoot = (await listChildren(HOME_ID)).find((n) => n.name === result.folderName)!;
    const reise = (await listChildren(restoredRoot.id)).find((n) => n.name === 'Reise')!;
    const plan = (await listChildren(reise.id))[0]!;
    expect(await (await readBlob(plan.id))!.text()).toBe('Gleis 4');
    // Original bleibt erhalten
    expect((await listChildren(HOME_ID)).some((n) => n.id === folder.id)).toBe(true);
  });

  it('rejects files that are not RenOS backups', async () => {
    await expect(restoreBackup(new Blob(['kein zip']))).rejects.toThrow(/keine gültige/);
  });
});
