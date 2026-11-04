import { useCallback, useEffect, useRef, useState } from 'react';
import { CaseSensitive, FilePlus2, FolderOpen, Replace, Save, Search, WrapText, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import type { FsNode } from '@/persistence/db';
import { createFile, getNode, readBlob, uniqueName, validateName, writeFile } from '@/persistence/fs';
import { openFilesAt } from '@/system/actions';
import type { AppProps } from '@/system/apps';
import { promptDialog } from '@/system/dialogs';
import { notify } from '@/system/notifications';
import { useShortcut } from '@/system/shortcuts';
import { useWindows } from '@/system/windows';
import { IconButton } from '@/ui/Button';
import { EmptyState, Spinner } from '@/ui/Feedback';
import { WindowHeader, useWindowContext } from '@/wm/WindowContext';

/** Dateien bis zu dieser Größe werden bearbeitet; größere nur angezeigt (Textarea bleibt flüssig). */
const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const AUTOSAVE_MS = 800;

/** Position (Zeile/Spalte, 1-basiert) eines Zeichenindex. */
export function lineCol(text: string, index: number): { line: number; col: number } {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  return { line, col: index - before.lastIndexOf('\n') };
}

/** Alle Fundstellen (Index) eines Suchbegriffs. */
export function findAll(text: string, query: string, caseSensitive: boolean): number[] {
  if (!query) return [];
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: number[] = [];
  let i = hay.indexOf(needle);
  while (i >= 0 && out.length < 10_000) {
    out.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}

export default function EditorApp({ windowId, payload }: AppProps) {
  const { focused } = useWindowContext();
  const fileId = typeof payload?.fileId === 'string' ? payload.fileId : null;
  const [node, setNode] = useState<FsNode | null>(null);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'toolarge'>(fileId ? 'loading' : 'ready');
  const [autosave, setAutosave] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [cursor, setCursor] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const dirty = text !== saved;

  // Datei laden (bei neuem payload neu).
  useEffect(() => {
    let cancelled = false;
    if (!fileId) {
      setNode(null);
      setText('');
      setSaved('');
      setState('ready');
      return undefined;
    }
    setState('loading');
    void (async () => {
      const n = await getNode(fileId);
      const blob = n && n.kind === 'file' ? await readBlob(fileId) : undefined;
      if (cancelled) return;
      if (!n || !blob) return setState('missing');
      setNode(n);
      if (blob.size > MAX_EDIT_BYTES) return setState('toolarge');
      const content = await blob.text();
      if (cancelled) return;
      setText(content);
      setSaved(content);
      setState('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId, payload?.nonce]);

  useEffect(() => {
    useWindows.getState().setTitle(windowId, `${dirty ? '• ' : ''}${node?.name ?? 'Unbenannt'} – Texteditor`);
  }, [windowId, node?.name, dirty]);

  const saveAs = useCallback(async () => {
    const parentId = node?.parentId ?? 'documents';
    const suggestion = await uniqueName(parentId, node ? node.name : 'Unbenannt.txt');
    const name = await promptDialog({ title: 'Speichern unter', label: 'Dateiname', defaultValue: suggestion, confirmLabel: 'Speichern', validate: validateName, selectBaseName: true });
    if (!name) return;
    const created = await createFile(parentId, await uniqueName(parentId, name), new Blob([text], { type: 'text/plain' }), 'text/plain');
    setNode(created);
    setSaved(text);
    useWindows.getState().setPayload(windowId, { fileId: created.id });
    notify({ kind: 'success', title: `Gespeichert: ${created.name}`, transient: true });
  }, [node, text, windowId]);

  const save = useCallback(async () => {
    if (!node) return saveAs();
    try {
      await writeFile(node.id, new Blob([text], { type: node.mime || 'text/plain' }));
      setSaved(text);
    } catch (error) {
      notify({ kind: 'error', title: 'Speichern fehlgeschlagen', message: (error as Error).message });
    }
  }, [node, text, saveAs]);

  // Automatisch speichern (nur Dateien, die schon einen Namen haben).
  useEffect(() => {
    if (!autosave || !node || !dirty || state !== 'ready') return undefined;
    const timer = window.setTimeout(() => void save(), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [autosave, node, dirty, state, save]);

  const matches = findAll(text, query, caseSensitive);
  const findNext = (backwards = false) => {
    if (!matches.length || !areaRef.current) return;
    const area = areaRef.current;
    const from = backwards ? area.selectionStart - 1 : area.selectionEnd;
    const next = backwards ? ([...matches].reverse().find((m) => m <= from) ?? matches[matches.length - 1]!) : (matches.find((m) => m >= from) ?? matches[0]!);
    area.focus();
    area.setSelectionRange(next, next + query.length);
    setCursor(next);
  };
  const replaceAll = () => {
    if (!query) return;
    const flags = caseSensitive ? 'g' : 'gi';
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    const count = matches.length;
    setText((v) => v.replace(pattern, () => replacement));
    notify({ kind: 'info', title: `${count} Stelle${count === 1 ? '' : 'n'} ersetzt.`, transient: true });
  };

  useShortcut({ id: `editor.save.${windowId}`, keys: 'Mod+S', scope: 'editor', group: 'Texteditor', description: 'Speichern', allowInInput: true, enabled: focused, handler: () => void save() });
  useShortcut({ id: `editor.saveas.${windowId}`, keys: 'Mod+Shift+S', scope: 'editor', group: 'Texteditor', description: 'Speichern unter', allowInInput: true, enabled: focused, handler: () => void saveAs() });
  useShortcut({
    id: `editor.find.${windowId}`,
    keys: 'Mod+F',
    scope: 'editor',
    group: 'Texteditor',
    description: 'Suchen',
    allowInInput: true,
    enabled: focused,
    handler: () => {
      setFindOpen(true);
      window.setTimeout(() => findRef.current?.select(), 0);
    },
  });
  useShortcut({
    id: `editor.new.${windowId}`,
    keys: 'Mod+N',
    scope: 'editor',
    group: 'Texteditor',
    description: 'Neues Dokument',
    allowInInput: true,
    enabled: focused,
    handler: () => void useWindows.getState().open('editor', null, { newInstance: true }),
  });

  if (state === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-surface-1">
        <Spinner size={20} />
      </div>
    );
  }
  if (state === 'missing') return <EmptyState icon={FolderOpen} title="Datei nicht gefunden" className="h-full bg-surface-1">Die Datei wurde gelöscht oder verschoben.</EmptyState>;
  if (state === 'toolarge') {
    return (
      <EmptyState icon={FolderOpen} title="Datei zu groß zum Bearbeiten" className="h-full bg-surface-1">
        {node?.name} ist {formatBytes(node?.size ?? 0)} groß. Der Texteditor bearbeitet Dateien bis {formatBytes(MAX_EDIT_BYTES)}.
      </EmptyState>
    );
  }

  const lines = text.split('\n').length;
  const pos = lineCol(text, cursor);

  return (
    <div className="flex h-full flex-col bg-surface-1" data-testid="editor">
      <WindowHeader>
        <IconButton icon={FilePlus2} label="Neues Dokument (⌘N)" size="sm" onClick={() => useWindows.getState().open('editor', null, { newInstance: true })} />
        <IconButton icon={Save} label="Speichern (⌘S)" size="sm" onClick={() => void save()} data-testid="editor-save" />
        <IconButton icon={Search} label="Suchen (⌘F)" size="sm" active={findOpen} onClick={() => setFindOpen((v) => !v)} />
        <IconButton icon={WrapText} label="Zeilenumbruch" size="sm" active={wrap} onClick={() => setWrap((v) => !v)} />
      </WindowHeader>
      {findOpen ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line-soft bg-surface-0 px-2 py-1.5">
          <input
            ref={findRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                findNext(e.shiftKey);
              } else if (e.key === 'Escape') setFindOpen(false);
            }}
            placeholder="Suchen"
            aria-label="Suchen"
            className="h-7 w-44 rounded-md border border-line bg-surface-1 px-2 text-sm"
            data-testid="editor-find"
          />
          <input value={replacement} onChange={(e) => setReplacement(e.target.value)} placeholder="Ersetzen durch" aria-label="Ersetzen durch" className="h-7 w-40 rounded-md border border-line bg-surface-1 px-2 text-sm" data-testid="editor-replace" />
          <IconButton icon={CaseSensitive} label="Groß-/Kleinschreibung beachten" size="sm" active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} />
          <button type="button" className="rounded-md px-2 py-1 text-sm hover:bg-surface-2" onClick={() => findNext()}>
            Weiter
          </button>
          <button type="button" className="flex items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-surface-2" onClick={replaceAll} data-testid="editor-replace-all">
            <Replace size={14} /> Alle ersetzen
          </button>
          <span className="tabular ml-1 text-xs text-fg-subtle">{query ? `${matches.length} Treffer` : ''}</span>
          <div className="flex-1" />
          <IconButton icon={X} label="Suche schließen" size="sm" onClick={() => setFindOpen(false)} />
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1">
        {!wrap ? (
          <div ref={gutterRef} className="tabular select-none overflow-hidden border-r border-line-soft bg-surface-0 px-2 py-3 text-right font-mono text-xs leading-[1.6] text-fg-faint" aria-hidden>
            {Array.from({ length: Math.min(lines, 100_000) }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
        ) : null}
        <textarea
          ref={areaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCursor(e.target.selectionStart);
          }}
          onSelect={(e) => setCursor((e.target as HTMLTextAreaElement).selectionStart)}
          onScroll={(e) => {
            if (gutterRef.current) gutterRef.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop;
          }}
          spellCheck={false}
          autoFocus
          wrap={wrap ? 'soft' : 'off'}
          className={cn('selectable min-h-0 flex-1 resize-none bg-transparent px-3 py-3 font-mono text-sm leading-[1.6] text-fg outline-none', !wrap && 'whitespace-pre')}
          aria-label="Textinhalt"
          data-testid="editor-text"
        />
      </div>
      <div className="flex items-center gap-4 border-t border-line-soft bg-surface-0 px-3 py-1 text-xs text-fg-subtle">
        <span className="tabular">
          Zeile {pos.line}, Spalte {pos.col}
        </span>
        <span className="tabular">{text.length.toLocaleString('de-DE')} Zeichen</span>
        <span>UTF-8</span>
        <div className="flex-1" />
        {node ? (
          <button type="button" className="hover:text-fg" onClick={() => node.parentId && openFilesAt(node.parentId)}>
            In Files zeigen
          </button>
        ) : null}
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={autosave} onChange={(e) => setAutosave(e.target.checked)} />
          Automatisch speichern
        </label>
        <span data-testid="editor-status">{dirty ? (node && autosave ? 'Wird gespeichert …' : 'Nicht gespeichert') : node ? 'Gespeichert' : 'Neu'}</span>
      </div>
    </div>
  );
}
