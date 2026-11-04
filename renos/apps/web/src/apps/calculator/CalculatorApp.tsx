import { useEffect, useRef, useState } from 'react';
import { Copy, Delete, History } from 'lucide-react';
import { CalcError, evaluate, formatResult } from '@/lib/calc';
import { cn } from '@/lib/cn';
import type { AppProps } from '@/system/apps';
import { notify } from '@/system/notifications';
import { IconButton } from '@/ui/Button';
import { WindowHeader, useWindowContext } from '@/wm/WindowContext';

type Key = { label: string; insert?: string; action?: 'clear' | 'back' | 'equals' | 'sign'; kind?: 'op' | 'fn' | 'eq' };

const KEYS: Key[][] = [
  [{ label: 'C', action: 'clear', kind: 'fn' }, { label: '(', insert: '(', kind: 'fn' }, { label: ')', insert: ')', kind: 'fn' }, { label: '÷', insert: '÷', kind: 'op' }],
  [{ label: '7', insert: '7' }, { label: '8', insert: '8' }, { label: '9', insert: '9' }, { label: '×', insert: '×', kind: 'op' }],
  [{ label: '4', insert: '4' }, { label: '5', insert: '5' }, { label: '6', insert: '6' }, { label: '−', insert: '−', kind: 'op' }],
  [{ label: '1', insert: '1' }, { label: '2', insert: '2' }, { label: '3', insert: '3' }, { label: '+', insert: '+', kind: 'op' }],
  [{ label: '±', action: 'sign', kind: 'fn' }, { label: '0', insert: '0' }, { label: ',', insert: ',' }, { label: '=', action: 'equals', kind: 'eq' }],
];

const SCIENTIFIC: Key[] = [
  { label: '√', insert: '√(' },
  { label: 'x²', insert: '^2' },
  { label: 'xʸ', insert: '^' },
  { label: '%', insert: '%' },
  { label: 'π', insert: 'π' },
  { label: 'sin', insert: 'sin(' },
  { label: 'cos', insert: 'cos(' },
  { label: 'tan', insert: 'tan(' },
  { label: 'ln', insert: 'ln(' },
  { label: 'log', insert: 'log(' },
];

export default function CalculatorApp(_props: AppProps) {
  const { focused } = useWindowContext();
  const [input, setInput] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ans, setAns] = useState(0);
  const [degrees, setDegrees] = useState(true);
  const [history, setHistory] = useState<Array<{ expr: string; result: string }>>([]);
  const [showHistory, setShowHistory] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focused) rootRef.current?.focus();
  }, [focused]);

  // Vorschau während der Eingabe.
  const preview = (() => {
    if (!input.trim()) return null;
    try {
      return formatResult(evaluate(input, { degrees, ans }));
    } catch {
      return null;
    }
  })();

  const equals = () => {
    if (!input.trim()) return;
    try {
      const value = evaluate(input, { degrees, ans });
      const text = formatResult(value);
      setAns(value);
      setResult(text);
      setError(null);
      setHistory((h) => [{ expr: input, result: text }, ...h].slice(0, 50));
      setInput('');
    } catch (e) {
      setError(e instanceof CalcError ? e.message : 'Fehler');
    }
  };

  const press = (key: Key) => {
    setError(null);
    if (key.action === 'clear') {
      setInput('');
      setResult(null);
      return;
    }
    if (key.action === 'back') return setInput((v) => v.slice(0, -1));
    if (key.action === 'equals') return equals();
    if (key.action === 'sign') return setInput((v) => (v.startsWith('−(') && v.endsWith(')') ? v.slice(2, -1) : v ? `−(${v})` : '−'));
    // Nach einem Ergebnis: Operator rechnet mit dem Ergebnis weiter, Zahl beginnt neu.
    if (!input && result !== null && key.kind === 'op') setInput(`ans${key.insert}`);
    else setInput((v) => v + (key.insert ?? ''));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey) {
      if (e.key === 'c' && (result || preview)) {
        void navigator.clipboard?.writeText((result ?? preview ?? '').replace(/\./g, ''));
      }
      return;
    }
    const k = e.key;
    if (k === 'Enter' || k === '=') {
      e.preventDefault();
      equals();
    } else if (k === 'Backspace') {
      e.preventDefault();
      setInput((v) => v.slice(0, -1));
    } else if (k === 'Escape') {
      e.preventDefault();
      setInput('');
      setResult(null);
      setError(null);
    } else if (/^[0-9+\-*/().,^%]$/.test(k)) {
      e.preventDefault();
      setError(null);
      const map: Record<string, string> = { '*': '×', '/': '÷', '-': '−' };
      if (!input && result !== null && '+-*/^'.includes(k)) setInput(`ans${map[k] ?? k}`);
      else setInput((v) => v + (map[k] ?? k));
    }
  };

  const copy = () => {
    const text = result ?? preview;
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => notify({ kind: 'success', title: 'Ergebnis kopiert.', transient: true }));
  };

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} className="flex h-full flex-col bg-surface-1 outline-none" data-testid="calculator">
      <WindowHeader>
        <IconButton icon={History} label="Verlauf" size="sm" active={showHistory} onClick={() => setShowHistory((v) => !v)} />
        <IconButton icon={Copy} label="Ergebnis kopieren" size="sm" onClick={copy} />
      </WindowHeader>
      <div className="relative flex min-h-[120px] flex-col items-end justify-end gap-1 px-5 py-4">
        <div className="selectable w-full truncate text-right font-mono text-base text-fg-muted" data-testid="calc-input">
          {input || (result !== null ? ' ' : '0')}
        </div>
        <div className={cn('tabular w-full truncate text-right text-4xl font-light', error ? 'text-danger text-lg' : 'text-fg')} data-testid="calc-result" aria-live="polite">
          {error ?? (input ? (preview ?? '…') : (result ?? '0'))}
        </div>
        {showHistory ? (
          <div className="scroll-area absolute inset-x-3 top-2 z-10 max-h-[260px] overflow-auto rounded-lg border border-line bg-surface-2 p-2 shadow-xl">
            {history.length === 0 ? <p className="p-2 text-sm text-fg-subtle">Noch keine Rechnungen.</p> : null}
            {history.map((h, i) => (
              <button
                key={`${h.expr}-${i}`}
                type="button"
                className="block w-full rounded-md px-2 py-1.5 text-right hover:bg-surface-3"
                onClick={() => {
                  setInput(h.expr);
                  setShowHistory(false);
                }}
              >
                <div className="font-mono text-xs text-fg-subtle">{h.expr}</div>
                <div className="tabular text-base text-fg">= {h.result}</div>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-between px-3 pb-2 text-xs">
        <button type="button" className="rounded-md px-2 py-1 text-fg-muted hover:bg-surface-2" onClick={() => setDegrees((d) => !d)} data-testid="calc-angle">
          {degrees ? 'Grad' : 'Bogenmaß'}
        </button>
        <IconButton icon={Delete} label="Löschen (Rücktaste)" size="sm" onClick={() => press({ label: '⌫', action: 'back' })} />
      </div>
      <div className="grid grid-cols-5 gap-1.5 px-3">
        {SCIENTIFIC.map((key) => (
          <button key={key.label} type="button" onClick={() => press(key)} className="h-8 rounded-md bg-surface-2 text-sm text-fg-muted hover:bg-surface-3">
            {key.label}
          </button>
        ))}
      </div>
      <div className="grid flex-1 grid-cols-4 gap-1.5 p-3">
        {KEYS.flat().map((key) => (
          <button
            key={key.label}
            type="button"
            onClick={() => press(key)}
            className={cn(
              'rounded-lg text-xl transition-colors',
              key.kind === 'eq' ? 'bg-accent text-accent-fg hover:brightness-110' : key.kind === 'op' ? 'bg-surface-3 text-accent hover:bg-surface-2' : key.kind === 'fn' ? 'bg-surface-3 text-fg-muted hover:bg-surface-2' : 'bg-surface-2 text-fg hover:bg-surface-3',
            )}
            data-testid={`calc-key-${key.label}`}
          >
            {key.label}
          </button>
        ))}
      </div>
    </div>
  );
}
