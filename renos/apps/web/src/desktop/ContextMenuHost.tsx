import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useContextMenu, type MenuItem } from '@/system/contextMenu';

export function ContextMenuHost() {
  const { open, x, y, items, hide } = useContextMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [active, setActive] = useState(-1);
  const actionable = items.map((item, index) => ({ item, index })).filter((e): e is { item: MenuItem; index: number } => e.item !== 'separator' && !e.item.disabled);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(x, window.innerWidth - rect.width - margin);
    const top = y + rect.height > window.innerHeight - margin ? Math.max(margin, y - rect.height) : y;
    setPos({ left: Math.max(margin, left), top });
    setActive(-1);
    ref.current.focus({ preventScroll: true });
  }, [open, x, y, items]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) hide();
    };
    const onBlur = () => hide();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [open, hide]);

  if (!open) return null;

  const run = (item: MenuItem) => {
    hide();
    item.run?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (actionable.length === 0) return;
      const pos = actionable.findIndex((a) => a.index === active);
      const next = e.key === 'ArrowDown' ? (pos + 1) % actionable.length : (pos - 1 + actionable.length) % actionable.length;
      setActive(actionable[next]!.index);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const entry = items[active];
      if (entry && entry !== 'separator' && !entry.disabled) run(entry);
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="os-chrome panel-surface fixed min-w-[200px] max-w-[320px] rounded-md p-1 text-base outline-none"
      style={{ left: pos.left, top: pos.top, zIndex: 10000 }}
    >
      {items.map((entry, index) =>
        entry === 'separator' ? (
          <div key={`sep-${index}`} className="mx-2 my-1 h-px bg-line-soft" role="separator" />
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onPointerEnter={() => setActive(index)}
            onClick={() => run(entry)}
            className={cn(
              'flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-left disabled:opacity-40',
              index === active ? 'bg-surface-3' : '',
              entry.danger ? 'text-danger' : 'text-fg',
            )}
          >
            <span className="flex w-4 shrink-0 justify-center text-fg-muted">
              {entry.checked ? <Check size={14} strokeWidth={2.2} /> : entry.icon ? <entry.icon size={15} strokeWidth={1.8} className={entry.danger ? 'text-danger' : ''} /> : null}
            </span>
            <span className="flex-1 truncate">{entry.label}</span>
            {entry.shortcut ? <span className="text-sm text-fg-subtle">{entry.shortcut}</span> : null}
          </button>
        ),
      )}
    </div>
  );
}
