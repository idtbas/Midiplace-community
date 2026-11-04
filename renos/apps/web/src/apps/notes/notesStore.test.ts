import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/persistence/db';
import { countWords, createNote, deleteNote, deriveTitle, filterNotes, noteFileName, restoreNote, saveNote } from './notesStore';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('notes', () => {
  it('derives titles from the first non-empty line', () => {
    expect(deriveTitle('\n\n# Einkauf\nMilch')).toBe('Einkauf');
    expect(deriveTitle('')).toBe('Neue Notiz');
    expect(countWords('  zwei  Wörter ')).toBe(2);
    expect(noteFileName({ title: 'a/b:c' })).toBe('a-b-c.txt');
  });

  it('creates, saves, searches, deletes and restores notes', async () => {
    const note = await createNote();
    await saveNote(note.id, 'Reiseplan\nZug um 9 Uhr');
    const stored = await db.notes.get(note.id);
    expect(stored).toMatchObject({ title: 'Reiseplan', body: 'Reiseplan\nZug um 9 Uhr' });
    expect(stored!.updatedAt).toBeGreaterThanOrEqual(note.updatedAt);
    expect(filterNotes([stored!], 'zug')).toHaveLength(1);
    expect(filterNotes([stored!], 'flug')).toHaveLength(0);
    const removed = await deleteNote(note.id);
    expect(await db.notes.count()).toBe(0);
    await restoreNote(removed!);
    expect((await db.notes.get(note.id))?.body).toContain('Zug');
  });
});
