import { db, newId, type Note } from '@/persistence/db';
import { t } from '@/i18n';

/** Titel einer Notiz = erste nicht leere Zeile. */
export function deriveTitle(body: string): string {
  const line = body.split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim().replace(/^#+\s*/, '').slice(0, 80) : t.notes.untitled;
}

export function countWords(body: string): number {
  const words = body.trim().match(/\S+/g);
  return words ? words.length : 0;
}

export async function createNote(body = ''): Promise<Note> {
  const now = Date.now();
  const note: Note = { id: newId(), title: deriveTitle(body), body, createdAt: now, updatedAt: now };
  await db.notes.add(note);
  return note;
}

export async function saveNote(id: string, body: string): Promise<void> {
  await db.notes.update(id, { body, title: deriveTitle(body), updatedAt: Date.now() });
}

export async function deleteNote(id: string): Promise<Note | undefined> {
  const note = await db.notes.get(id);
  await db.notes.delete(id);
  return note;
}

export async function restoreNote(note: Note): Promise<void> {
  await db.notes.put(note);
}

export function filterNotes(notes: Note[], query: string): Note[] {
  const q = query.trim().toLowerCase();
  if (!q) return notes;
  return notes.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));
}

export function noteFileName(note: Pick<Note, 'title'>): string {
  const base = note.title.replace(/[/\\?%*:|"<>]/g, '-').trim() || 'Notiz';
  return `${base.slice(0, 60)}.txt`;
}
