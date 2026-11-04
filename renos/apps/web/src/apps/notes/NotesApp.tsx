import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FolderInput, Plus, Search, StickyNote, Trash2 } from 'lucide-react';
import { t } from '@/i18n';
import { cn } from '@/lib/cn';
import { downloadBlob } from '@/lib/download';
import { formatRelative } from '@/lib/format';
import { db, type Note } from '@/persistence/db';
import { createFile } from '@/persistence/fs';
import { useLiveQuery } from '@/persistence/useLiveQuery';
import type { AppProps } from '@/system/apps';
import { showContextMenu } from '@/system/contextMenu';
import { notify } from '@/system/notifications';
import { useShortcut } from '@/system/shortcuts';
import { useWindows } from '@/system/windows';
import { IconButton } from '@/ui/Button';
import { EmptyState } from '@/ui/Feedback';
import { TextInput } from '@/ui/Form';
import { WindowHeader, useWindowContext } from '@/wm/WindowContext';
import { countWords, createNote, deleteNote, filterNotes, noteFileName, restoreNote, saveNote } from './notesStore';

const SAVE_DELAY = 400;

export default function NotesApp({ windowId, payload }: AppProps) {
  const { focused } = useWindowContext();
  const notes = useLiveQuery(() => db.notes.orderBy('updatedAt').reverse().toArray(), [], [] as Note[]);
  const [query, setQuery] = useState('');
  const selectedId = typeof payload?.noteId === 'string' ? payload.noteId : null;
  const selected = notes.find((n) => n.id === selectedId) ?? null;
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<'saved' | 'saving'>('saved');
  const pending = useRef<{ id: string; body: string } | null>(null);
  const timer = useRef<number | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const visible = filterNotes(notes, query);

  const select = useCallback((id: string | null) => useWindows.getState().setPayload(windowId, id ? { noteId: id } : null), [windowId]);

  const flush = useCallback(async () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    pending.current = null;
    if (p) {
      await saveNote(p.id, p.body);
      setStatus('saved');
    }
  }, []);

  // Beim Wechsel der Notiz: offene Änderungen speichern, dann Inhalt laden.
  const loadedId = useRef<string | null>(null);
  useEffect(() => {
    if (selected && loadedId.current !== selected.id) {
      void flush();
      loadedId.current = selected.id;
      setDraft(selected.body);
      setStatus('saved');
    }
    if (!selected) loadedId.current = null;
  }, [selected, flush]);

  // Erste Notiz automatisch auswählen.
  useEffect(() => {
    if (!selectedId && notes.length > 0) select(notes[0]!.id);
  }, [selectedId, notes, select]);

  // Beim Schließen des Fensters nichts verlieren.
  useEffect(() => () => void flush(), [flush]);

  useEffect(() => {
    useWindows.getState().setTitle(windowId, selected ? `${selected.title} – Notes` : 'Notes');
  }, [windowId, selected]);

  const onChange = (value: string) => {
    if (!selected) return;
    setDraft(value);
    setStatus('saving');
    pending.current = { id: selected.id, body: value };
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_DELAY);
  };

  const create = async () => {
    await flush();
    const note = await createNote();
    setQuery('');
    select(note.id);
    window.setTimeout(() => editorRef.current?.focus(), 30);
  };

  const remove = async (id: string) => {
    if (pending.current?.id === id) await flush();
    const index = visible.findIndex((n) => n.id === id);
    const removed = await deleteNote(id);
    if (!removed) return;
    const next = visible[index + 1] ?? visible[index - 1];
    select(next && next.id !== id ? next.id : null);
    notify({
      kind: 'info',
      title: t.notes.deleted,
      message: removed.title,
      action: {
        label: t.notes.undo,
        run: () => {
          void restoreNote(removed).then(() => select(removed.id));
        },
      },
    });
  };

  const exportTxt = (note: Note) => downloadBlob(new Blob([note.id === selected?.id ? draft : note.body], { type: 'text/plain;charset=utf-8' }), noteFileName(note));

  const saveToFiles = async (note: Note) => {
    await flush();
    const body = note.id === selected?.id ? draft : note.body;
    const file = await createFile('documents', noteFileName(note), new Blob([body], { type: 'text/plain' }), 'text/plain');
    notify({ kind: 'success', title: t.notes.savedToFiles(file.name) });
  };

  useShortcut({ id: `notes.new.${windowId}`, keys: ['Mod+N', 'Alt+N'], scope: 'notes', group: 'Notes', description: 'Neue Notiz', allowInInput: true, enabled: focused, handler: () => void create() });
  useShortcut({ id: `notes.search.${windowId}`, keys: 'Mod+F', scope: 'notes', group: 'Notes', description: 'Notizen durchsuchen', allowInInput: true, enabled: focused, handler: () => searchRef.current?.focus() });
  useShortcut({ id: `notes.save.${windowId}`, keys: 'Mod+S', scope: 'notes', group: 'Notes', description: 'Sofort speichern', allowInInput: true, enabled: focused, handler: () => void flush() });
  useShortcut({
    id: `notes.delete.${windowId}`,
    keys: 'Mod+Shift+Backspace',
    scope: 'notes',
    group: 'Notes',
    description: 'Notiz löschen',
    allowInInput: true,
    enabled: focused,
    handler: () => {
      if (!selected) return false;
      void remove(selected.id);
    },
  });

  const onListKey = (e: React.KeyboardEvent) => {
    const index = visible.findIndex((n) => n.id === selectedId);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = visible[Math.min(Math.max(index + (e.key === 'ArrowDown' ? 1 : -1), 0), visible.length - 1)];
      if (next) select(next.id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      editorRef.current?.focus();
    }
  };

  const noteMenu = (e: React.MouseEvent, note: Note) =>
    showContextMenu(e, [
      { id: 'files', label: t.notes.saveToFiles, icon: FolderInput, run: () => void saveToFiles(note) },
      { id: 'export', label: t.notes.exportTxt, icon: Download, run: () => exportTxt(note) },
      'separator',
      { id: 'delete', label: t.system.delete, icon: Trash2, danger: true, run: () => void remove(note.id) },
    ]);

  return (
    <div className="flex h-full">
      <WindowHeader>
        <IconButton icon={Plus} label={`${t.notes.newNote} (⌘N)`} size="sm" onClick={() => void create()} />
      </WindowHeader>
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-line-soft bg-surface-0">
        <div className="p-2.5">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
            <TextInput ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.notes.searchPlaceholder} className="pl-8" aria-label={t.notes.searchPlaceholder} />
          </div>
        </div>
        <div className="scroll-area flex-1 px-1.5 pb-2" role="listbox" aria-label="Notizen" tabIndex={0} onKeyDown={onListKey}>
          {visible.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-fg-subtle">{notes.length === 0 ? t.notes.empty : t.notes.noResults}</p>
          ) : (
            visible.map((note) => (
              <button
                key={note.id}
                type="button"
                role="option"
                aria-selected={note.id === selectedId}
                onClick={() => select(note.id)}
                onContextMenu={(e) => noteMenu(e, note)}
                className={cn('mb-0.5 block w-full rounded-md px-3 py-2 text-left', note.id === selectedId ? 'bg-accent-soft' : 'hover:bg-surface-2')}
              >
                <div className="truncate text-base font-medium text-fg">{note.id === selectedId && draft ? (draft.split('\n').find((l) => l.trim())?.trim().slice(0, 80) ?? t.notes.untitled) : note.title}</div>
                <div className="mt-0.5 flex gap-2 text-sm text-fg-subtle">
                  <span className="shrink-0">{formatRelative(note.updatedAt)}</span>
                  <span className="truncate">{note.body.split('\n').slice(1).join(' ').trim()}</span>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col bg-surface-1">
        {selected ? (
          <>
            <textarea
              ref={editorRef}
              value={draft}
              onChange={(e) => onChange(e.target.value)}
              onBlur={() => void flush()}
              placeholder={t.notes.placeholder}
              aria-label="Notiztext"
              className="scroll-area selectable min-h-0 flex-1 resize-none bg-transparent px-8 py-6 text-md leading-relaxed text-fg placeholder:text-fg-faint focus:outline-none"
              spellCheck
            />
            <footer className="flex items-center justify-between border-t border-line-soft px-4 py-1.5 text-xs text-fg-subtle">
              <span>
                {t.notes.words(countWords(draft))} · {t.notes.chars(draft.length)}
              </span>
              <span className="flex items-center gap-3">
                <span data-testid="note-status">{status === 'saving' ? t.notes.saving : t.notes.saved}</span>
                <IconButton icon={FolderInput} label={t.notes.saveToFiles} size="sm" onClick={() => void saveToFiles(selected)} />
                <IconButton icon={Download} label={t.notes.exportTxt} size="sm" onClick={() => exportTxt(selected)} />
                <IconButton icon={Trash2} label={t.system.delete} size="sm" onClick={() => void remove(selected.id)} />
              </span>
            </footer>
          </>
        ) : (
          <EmptyState icon={StickyNote} title={notes.length ? t.notes.noSelection : t.notes.empty}>
            {notes.length ? null : t.notes.emptyHint}
          </EmptyState>
        )}
      </section>
    </div>
  );
}
