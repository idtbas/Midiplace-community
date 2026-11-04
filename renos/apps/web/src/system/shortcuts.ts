import { useEffect, useRef } from 'react';
import type { AppId } from './appIds';
import { isAppleMobile } from '@/lib/platform';

/**
 * Zentraler Shortcut-Manager.
 *
 * - Kombinationen werden über `event.code` (physische Taste) erkannt, damit sie auch auf
 *   deutschen Tastaturen und mit gedrückter Wahltaste (⌥) funktionieren.
 * - `Mod` steht für ⌘ oder Ctrl.
 * - App-Kürzel gelten nur, wenn ein Fenster dieser App fokussiert ist.
 * - In Textfeldern greifen nur Kürzel mit `allowInInput`.
 * - Ein fokussiertes Spiel (iframe auf anderem Origin) erhält alle Tasten selbst: RenOS sieht diese
 *   Ereignisse gar nicht und kann sie deshalb auch nicht abfangen.
 * - iPadOS kann einzelne Kombinationen für sich reservieren; diese erreichen RenOS dann nicht.
 */

export interface ShortcutContext {
  focusedAppId: AppId | null;
  focusedWindowId: string | null;
}

export interface ShortcutDef {
  id: string;
  keys: string | string[];
  scope: 'global' | AppId;
  description: string;
  group: string;
  allowInInput?: boolean;
  /** Rückgabe `false`: Ereignis nicht als behandelt markieren. */
  handler: (event: KeyboardEvent, ctx: ShortcutContext) => void | boolean;
}

interface ParsedCombo {
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
  mod: boolean;
  code: string | null;
  key: string | null;
}

const CODE_ALIASES: Record<string, string> = {
  Space: 'Space',
  ',': 'Comma',
  '.': 'Period',
  '`': 'Backquote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '/': 'Slash',
  '-': 'Minus',
  '=': 'Equal',
};

export function parseCombo(combo: string): ParsedCombo {
  const parts = combo.split('+').map((p) => p.trim());
  const keyPart = parts.pop() ?? '';
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  let code: string | null = null;
  let key: string | null = null;
  if (/^[A-Za-z]$/.test(keyPart)) code = `Key${keyPart.toUpperCase()}`;
  else if (/^[0-9]$/.test(keyPart)) code = `Digit${keyPart}`;
  else if (CODE_ALIASES[keyPart]) code = CODE_ALIASES[keyPart]!;
  else key = keyPart;
  return {
    alt: mods.has('alt'),
    shift: mods.has('shift'),
    ctrl: mods.has('ctrl'),
    meta: mods.has('meta'),
    mod: mods.has('mod'),
    code,
    key,
  };
}

export function matchesCombo(event: Pick<KeyboardEvent, 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'code' | 'key'>, combo: string): boolean {
  const p = parseCombo(combo);
  if (p.code ? event.code !== p.code : event.key !== p.key) return false;
  if (event.altKey !== p.alt || event.shiftKey !== p.shift) return false;
  if (p.mod) {
    // „Mod“ = ⌘ oder Ctrl, aber nicht beide gleichzeitig.
    return event.metaKey !== event.ctrlKey;
  }
  return event.ctrlKey === p.ctrl && event.metaKey === p.meta;
}

const APPLE = typeof navigator !== 'undefined' && (isAppleMobile() || /Mac/.test(navigator.platform ?? ''));

/** Darstellung einer Kombination für Menüs und Hilfetexte. */
export function formatCombo(combo: string): string {
  const parts = combo.split('+');
  const keyPart = parts.pop() ?? '';
  const symbols: Record<string, string> = APPLE
    ? { alt: '⌥', shift: '⇧', ctrl: '⌃', meta: '⌘', mod: '⌘' }
    : { alt: 'Alt+', shift: 'Shift+', ctrl: 'Ctrl+', meta: 'Win+', mod: 'Ctrl+' };
  const keyNames: Record<string, string> = {
    Space: APPLE ? 'Leertaste' : 'Leertaste',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Escape: 'Esc',
    Enter: '↩',
    Backspace: '⌫',
    Delete: 'Entf',
    Tab: '⇥',
  };
  const order = ['ctrl', 'alt', 'shift', 'meta', 'mod'];
  const mods = parts.map((p) => p.toLowerCase()).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const prefix = mods.map((m) => symbols[m] ?? m).join('');
  const key = keyNames[keyPart] ?? keyPart.toUpperCase();
  if (!APPLE) return `${prefix}${key}`;
  return key.length > 1 && prefix ? `${prefix} ${key}` : `${prefix}${key}`;
}

const registry = new Map<string, ShortcutDef>();
const listeners = new Set<() => void>();
/** Stabiler Snapshot für useSyncExternalStore (ändert sich nur bei (De-)Registrierung). */
let snapshot: ShortcutDef[] = [];

function emit(): void {
  snapshot = [...registry.values()];
  listeners.forEach((l) => l());
}

export function registerShortcut(def: ShortcutDef): () => void {
  registry.set(def.id, def);
  emit();
  return () => {
    if (registry.get(def.id) === def) registry.delete(def.id);
    emit();
  };
}

export function listShortcuts(): ShortcutDef[] {
  return snapshot;
}

export function subscribeShortcuts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(type);
  }
  return false;
}

/** Verarbeitet ein Tastaturereignis. Gibt true zurück, wenn ein Kürzel ausgelöst wurde. */
export function dispatchShortcut(event: KeyboardEvent, ctx: ShortcutContext, options: { systemEnabled: boolean }): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  const editable = isEditableTarget(event.target);
  for (const def of registry.values()) {
    if (def.scope === 'global' && !options.systemEnabled) continue;
    if (def.scope !== 'global' && def.scope !== ctx.focusedAppId) continue;
    if (editable && !def.allowInInput) continue;
    const combos = Array.isArray(def.keys) ? def.keys : [def.keys];
    if (!combos.some((c) => matchesCombo(event, c))) continue;
    const result = def.handler(event, ctx);
    if (result === false) continue;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
  return false;
}

/** React-Hook zum Registrieren eines Kürzels für die Lebensdauer einer Komponente. */
export function useShortcut(def: Omit<ShortcutDef, 'handler'> & { handler: ShortcutDef['handler']; enabled?: boolean }): void {
  const handlerRef = useRef(def.handler);
  handlerRef.current = def.handler;
  const keys = Array.isArray(def.keys) ? def.keys.join('|') : def.keys;
  useEffect(() => {
    if (def.enabled === false) return undefined;
    return registerShortcut({
      id: def.id,
      keys: keys.split('|'),
      scope: def.scope,
      description: def.description,
      group: def.group,
      allowInInput: def.allowInInput,
      handler: (event, ctx) => handlerRef.current(event, ctx),
    });
  }, [def.id, keys, def.scope, def.description, def.group, def.allowInInput, def.enabled]);
}
