import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '@/i18n';
import { cn } from '@/lib/cn';
import { describeError } from '@/api/client';
import { canReadLibrary, useServer } from '@/api/server';
import { HOME_ID, getAncestors } from '@/persistence/fs';
import { launchGame, openApp } from '@/system/actions';
import type { AppProps } from '@/system/apps';
import { useSettings } from '@/system/settings';
import { useWindows } from '@/system/windows';
import { useWindowContext } from '@/wm/WindowContext';
import { COMMANDS, complete, findCommand, type Segment, type TerminalContext, type Tone } from './commands';
import { tokenize } from './parser';

interface Line {
  id: number;
  segments: Segment[];
}

const HISTORY_KEY = 'renos.terminal.history';
const MAX_LINES = 1500;
// Sitzungsbeginn = Laden von RenOS (nicht das Öffnen des Terminals).
const SESSION_START = Math.round(performance.timeOrigin);

function loadHistory(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(-200) : [];
  } catch {
    return [];
  }
}

const TONES: Record<Tone, string> = {
  default: 'text-fg',
  muted: 'text-fg-subtle',
  accent: 'text-accent',
  error: 'text-danger',
  success: 'text-success',
  warning: 'text-warning',
  dir: 'text-accent font-semibold',
  bold: 'text-fg font-semibold',
};

let lineSeq = 0;

export default function TerminalApp({ windowId, payload }: AppProps) {
  const { focused } = useWindowContext();
  const userName = useSettings((s) => s.userName);
  const accent = useSettings((s) => s.accent);
  const [lines, setLines] = useState<Line[]>(() => [{ id: (lineSeq += 1), segments: [{ text: t.terminal.welcome, tone: 'muted' }] }]);
  const [input, setInput] = useState('');
  const [caret, setCaret] = useState(0);
  const [busy, setBusy] = useState(false);
  const [cwdId, setCwdId] = useState(typeof payload?.cwd === 'string' ? payload.cwd : HOME_ID);
  const [cwdLabel, setCwdLabel] = useState('~');
  const history = useRef<string[]>(loadHistory());
  const historyIndex = useRef<number>(history.current.length);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [charWidth, setCharWidth] = useState(8);

  useLayoutEffect(() => {
    if (measureRef.current) setCharWidth(measureRef.current.getBoundingClientRect().width / 10);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getAncestors(cwdId).then((chain) => {
      if (cancelled) return;
      if (chain.length === 0) {
        setCwdId(HOME_ID);
        return;
      }
      const names = chain.slice(1).map((n) => n.name);
      setCwdLabel(names.length ? `~/${names.join('/')}` : '~');
    });
    useWindows.getState().setPayload(windowId, { cwd: cwdId });
    return () => {
      cancelled = true;
    };
  }, [cwdId, windowId]);

  useEffect(() => {
    useWindows.getState().setTitle(windowId, `${userName}@renos: ${cwdLabel}`);
  }, [windowId, userName, cwdLabel]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, busy]);

  useEffect(() => {
    if (focused) inputRef.current?.focus({ preventScroll: true });
  }, [focused]);

  const print = useCallback((text: string | Segment[], tone: Tone = 'default') => {
    const newLines: Line[] =
      typeof text === 'string'
        ? text.split('\n').map((part) => ({ id: (lineSeq += 1), segments: [{ text: part, tone }] }))
        : [{ id: (lineSeq += 1), segments: text }];
    setLines((prev) => [...prev, ...newLines].slice(-MAX_LINES));
  }, []);

  const prompt = (label = cwdLabel): Segment[] => [
    { text: `${userName}@renos`, tone: 'accent' },
    { text: ':', tone: 'muted' },
    { text: label, tone: 'dir' },
    { text: '$ ', tone: 'muted' },
  ];

  // Aktuelles Verzeichnis auch für vorausgetippte Befehle (die vor dem nächsten Rendern laufen).
  const cwdRef = useRef(cwdId);
  cwdRef.current = cwdId;
  const setCwd = (id: string) => {
    cwdRef.current = id;
    setCwdId(id);
  };
  const labelOf = async (id: string) => {
    const chain = await getAncestors(id);
    const names = chain.slice(1).map((n) => n.name);
    return names.length ? `~/${names.join('/')}` : '~';
  };

  const loadGames: TerminalContext['loadGames'] = async () => {
    const server = useServer.getState();
    if (server.status === 'offline') return { games: [], error: describeError('network') };
    if (!canReadLibrary(server)) return { games: [], error: describeError('unauthorized') };
    await server.loadGames();
    const after = useServer.getState();
    return { games: after.games, error: after.gamesState === 'error' && after.gamesError ? describeError(after.gamesError) : null };
  };

  const execute = async (raw: string) => {
    const cwd = cwdRef.current;
    print([...prompt(cwd === cwdId ? cwdLabel : await labelOf(cwd)), { text: raw }]);
    const trimmed = raw.trim();
    if (!trimmed) return;
    history.current = [...history.current.filter((h) => h !== trimmed), trimmed].slice(-200);
    historyIndex.current = history.current.length;
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.current));
    } catch {
      /* Verlauf nur für diese Sitzung */
    }
    const parsed = tokenize(trimmed);
    if (!parsed.ok) return print(`renos: ${parsed.error}`, 'error');
    const [name, ...args] = parsed.argv;
    if (!name) return;
    const command = findCommand(name);
    if (!command) return print(t.terminal.notFound(name), 'error');
    const ctx: TerminalContext = {
      cwdId: cwd,
      setCwd,
      userName,
      accent,
      print,
      clear: () => setLines([]),
      history: history.current,
      openApp: (id) => void openApp(id),
      launchGame,
      loadGames,
      sessionStart: SESSION_START,
    };
    try {
      await command.run(args, ctx);
    } catch (error) {
      print(`${name}: ${(error as Error).message || 'Fehler'}`, 'error');
    }
  };

  // Befehle laufen nacheinander; was während eines laufenden Befehls eingegeben wird, wartet (wie in
  // einer echten Shell) und geht nicht verloren.
  const queue = useRef<string[]>([]);
  const draining = useRef(false);
  const submit = async (raw: string) => {
    queue.current.push(raw);
    if (draining.current) return;
    draining.current = true;
    setBusy(true);
    try {
      for (let next = queue.current.shift(); next !== undefined; next = queue.current.shift()) await execute(next);
    } finally {
      draining.current = false;
      setBusy(false);
    }
  };

  const updateCaret = () => setCaret(inputRef.current?.selectionStart ?? input.length);

  const onKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const value = input;
      setInput('');
      setCaret(0);
      await submit(value);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const list = history.current;
      if (list.length === 0) return;
      historyIndex.current = Math.min(Math.max(historyIndex.current + (e.key === 'ArrowUp' ? -1 : 1), 0), list.length);
      const value = list[historyIndex.current] ?? '';
      setInput(value);
      setCaret(value.length);
      window.requestAnimationFrame(() => inputRef.current?.setSelectionRange(value.length, value.length));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const { completed, options } = await complete(input, cwdId);
      if (completed !== input) {
        setInput(completed);
        setCaret(completed.length);
      } else if (options.length > 1) {
        print([...prompt(), { text: input }]);
        print(options.join('   '), 'muted');
      }
    } else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      setLines([]);
    } else if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && !window.getSelection()?.toString()) {
      e.preventDefault();
      print([...prompt(), { text: `${input}^C` }]);
      setInput('');
      setCaret(0);
    } else if (e.ctrlKey && (e.key === 'u' || e.key === 'U')) {
      e.preventDefault();
      setInput('');
      setCaret(0);
    }
  };

  const scrollLeft = inputRef.current?.scrollLeft ?? 0;

  return (
    <div
      className="theme-dark flex h-full flex-col bg-[#0f1318] font-mono text-[13px] leading-[1.55]"
      onPointerUp={() => {
        if (!window.getSelection()?.toString()) inputRef.current?.focus({ preventScroll: true });
      }}
      data-testid="terminal"
    >
      <span ref={measureRef} aria-hidden className="pointer-events-none invisible absolute font-mono text-[13px]">
        0123456789
      </span>
      <div ref={scrollRef} className="scroll-area selectable min-h-0 flex-1 px-4 pt-3 pb-1" role="log" aria-live="polite">
        {lines.map((line) => (
          <div key={line.id} className="min-h-[1.55em] whitespace-pre-wrap break-words">
            {line.segments.map((s, i) => (
              <span key={i} className={TONES[s.tone ?? 'default']}>
                {s.text}
              </span>
            ))}
          </div>
        ))}
        <div className={cn('flex min-h-[1.55em] items-baseline', busy && 'opacity-40')}>
          <span className="shrink-0 whitespace-pre">
            {prompt().map((s, i) => (
              <span key={i} className={TONES[s.tone ?? 'default']}>
                {s.text}
              </span>
            ))}
          </span>
          <span className="relative min-w-0 flex-1">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setCaret(e.target.selectionStart ?? e.target.value.length);
              }}
              onKeyDown={(e) => void onKeyDown(e)}
              onKeyUp={updateCaret}
              onClick={updateCaret}
              onSelect={updateCaret}
              aria-label="Befehlseingabe"
              className="w-full bg-transparent p-0 font-mono text-[13px] text-fg outline-none focus:outline-none focus-visible:outline-none"
              style={{ caretColor: 'transparent' }}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              data-testid="terminal-input"
            />
            {focused && !busy ? (
              <span
                aria-hidden
                className="terminal-cursor pointer-events-none absolute top-[0.12em] h-[1.25em] bg-fg/75"
                style={{ left: caret * charWidth - scrollLeft, width: charWidth }}
              />
            ) : null}
          </span>
        </div>
      </div>
      <div className="border-t border-white/5 px-4 py-1 text-[11px] text-fg-faint">
        {COMMANDS.length} Befehle · „help“ für Hilfe · keine Ausführung auf iPad oder Server
      </div>
    </div>
  );
}
