import { useMemo, useState } from 'react';
import { ChevronLeft, FolderOpen, HardDrive, Home } from 'lucide-react';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/cn';
import { pickFiles } from '@/lib/download';
import { FileIcon } from '@/apps/files/FileIcon';
import { db, type FsNode } from '@/persistence/db';
import { HOME_ID, SPECIAL_FOLDERS, readBlob } from '@/persistence/fs';
import { useLiveQuery } from '@/persistence/useLiveQuery';
import { Button } from '@/ui/Button';
import { openDialog } from './dialogs';

/**
 * Dateiauswahl von RenOS (Systemdialog): zeigt den persönlichen Ordner aus Files. Genutzt z. B., wenn
 * ein Spiel eine Datei öffnen will („Szenario hinzufügen“). „Vom iPad wählen …“ öffnet die Dateien-App.
 */
export interface FilePickerOptions {
  /** Überschrift, z. B. „Datei für Student Transfer“ */
  title: string;
  /** Hinweis des Programms, z. B. „Choose Scenario Package“ */
  subtitle?: string;
  /** Muster wie „*.zip“; leer = alle Dateien */
  patterns?: string[];
  multiple?: boolean;
}

/** „*.zip“ → Prüffunktion für Dateinamen (nur einfache Platzhalter * und ?). */
export function patternMatcher(patterns: string[] = []): (name: string) => boolean {
  const usable = patterns.map((p) => p.trim()).filter((p) => p && p !== '*' && p !== '*.*');
  if (!usable.length) return () => true;
  const regexes = usable.map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i'));
  return (name) => regexes.some((r) => r.test(name));
}

/** Für den iPad-Dateidialog: „*.zip“ → „.zip“ (nur Endungen). */
function acceptFor(patterns: string[] = []): string | undefined {
  const exts = patterns.map((p) => /^\*(\.[a-z0-9]+)$/i.exec(p.trim())?.[1]).filter((e): e is string => Boolean(e));
  return exts.length ? exts.join(',') : undefined;
}

function sortNodes(nodes: FsNode[]): FsNode[] {
  return [...nodes].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'de', { numeric: true }) : a.kind === 'folder' ? -1 : 1));
}

const PLACES = [{ id: HOME_ID, name: 'Persönlicher Ordner' }, ...SPECIAL_FOLDERS.filter((f) => f.id !== 'saves')];

function FilePickerView({ options, finish }: { options: FilePickerOptions; finish: (files: File[] | null) => void }) {
  const [location, setLocation] = useState<string>('downloads');
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const matches = useMemo(() => patternMatcher(options.patterns), [options.patterns]);
  const nodes = useLiveQuery(
    () =>
      db.nodes
        .where('[parentId+trashed]')
        .equals([location, 0])
        .toArray()
        .then(sortNodes),
    [location],
    [] as FsNode[],
  );
  const current = useLiveQuery(() => db.nodes.get(location), [location], undefined);

  const go = (id: string, remember = true) => {
    if (remember) setHistory((h) => [...h, location]);
    setLocation(id);
    setSelected([]);
  };
  const back = () => {
    const prev = history[history.length - 1];
    if (prev === undefined) return;
    setHistory((h) => h.slice(0, -1));
    setLocation(prev);
    setSelected([]);
  };

  const confirm = async (ids = selected) => {
    if (!ids.length) return;
    setBusy(true);
    const files: File[] = [];
    for (const id of ids) {
      const node = nodes.find((n) => n.id === id) ?? (await db.nodes.get(id));
      const blob = node ? await readBlob(node.id) : undefined;
      if (node && blob) files.push(new File([blob], node.name, { type: node.mime || blob.type }));
    }
    finish(files.length ? files : null);
  };

  const fromDevice = async () => {
    const files = await pickFiles({ accept: acceptFor(options.patterns), multiple: options.multiple });
    if (files.length) finish(options.multiple ? files : files.slice(0, 1));
  };

  const toggle = (node: FsNode) => {
    if (!matches(node.name)) return;
    setSelected((s) => (options.multiple ? (s.includes(node.id) ? s.filter((x) => x !== node.id) : [...s, node.id]) : [node.id]));
  };

  return (
    <div className="flex h-[min(520px,70vh)] flex-col" data-testid="file-picker">
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-fg">{options.title}</h2>
        {options.subtitle ? <p className="text-sm text-fg-muted">{options.subtitle}</p> : null}
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-line-soft">
        <nav className="w-44 shrink-0 overflow-auto border-r border-line-soft bg-surface-0 p-1.5" aria-label="Orte">
          {PLACES.map((place) => (
            <button
              key={place.id}
              type="button"
              onClick={() => go(place.id)}
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm', location === place.id ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:bg-surface-2')}
            >
              {place.id === HOME_ID ? <Home size={15} /> : <FolderOpen size={15} />}
              <span className="truncate">{place.name}</span>
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-line-soft px-2 py-1.5 text-sm">
            <button type="button" onClick={back} disabled={!history.length} className="rounded p-1 text-fg-muted hover:bg-surface-2 disabled:opacity-30" aria-label="Zurück">
              <ChevronLeft size={16} />
            </button>
            <span className="truncate font-medium">{location === HOME_ID ? 'Persönlicher Ordner' : (current?.name ?? '')}</span>
          </div>
          <div className="scroll-area min-h-0 flex-1 overflow-auto p-1" role="listbox" aria-multiselectable={options.multiple}>
            {nodes.length === 0 ? <p className="p-4 text-sm text-fg-subtle">Dieser Ordner ist leer.</p> : null}
            {nodes.map((node) => {
              const usable = node.kind === 'folder' || matches(node.name);
              return (
                <button
                  key={node.id}
                  type="button"
                  role="option"
                  aria-selected={selected.includes(node.id)}
                  disabled={!usable}
                  onClick={() => (node.kind === 'folder' ? go(node.id) : toggle(node))}
                  onDoubleClick={() => (node.kind === 'file' && usable ? void confirm([node.id]) : undefined)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm',
                    selected.includes(node.id) ? 'bg-accent-soft text-fg' : 'hover:bg-surface-2',
                    !usable && 'opacity-40',
                  )}
                  data-testid="file-picker-item"
                  data-name={node.name}
                >
                  <FileIcon node={node} size={20} />
                  <span className="min-w-0 flex-1 truncate">{node.name}</span>
                  {node.kind === 'file' ? <span className="tabular shrink-0 text-xs text-fg-subtle">{formatBytes(node.size)}</span> : null}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" icon={HardDrive} onClick={() => void fromDevice()} data-testid="file-picker-device">
          Vom iPad wählen …
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => finish(null)} data-testid="file-picker-cancel">
            Abbrechen
          </Button>
          <Button variant="primary" disabled={!selected.length || busy} onClick={() => void confirm()} data-testid="file-picker-open">
            Öffnen
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Öffnet die Dateiauswahl; liefert die gewählten Dateien oder null (abgebrochen). */
export function pickRenosFiles(options: FilePickerOptions): Promise<File[] | null> {
  return new Promise((resolve) => {
    let result: File[] | null = null;
    void openDialog({
      title: options.title,
      width: 760,
      render: (close) => (
        <FilePickerView
          options={options}
          finish={(files) => {
            result = files;
            close();
          }}
        />
      ),
    }).then(() => resolve(result));
  });
}
