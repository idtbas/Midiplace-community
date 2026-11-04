import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchShortcut, isEditableTarget, matchesCombo, registerShortcut } from './shortcuts';

function key(init: Partial<KeyboardEvent> & { code: string; key: string }) {
  return { altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...init } as KeyboardEvent;
}

describe('shortcut matching', () => {
  it('matches physical keys independent of layout output', () => {
    // ⌥ + Leertaste erzeugt auf macOS/iPadOS ein geschütztes Leerzeichen als key.
    expect(matchesCombo(key({ code: 'Space', key: ' ', altKey: true }), 'Alt+Space')).toBe(true);
    expect(matchesCombo(key({ code: 'KeyW', key: '∑', altKey: true }), 'Alt+W')).toBe(true);
    expect(matchesCombo(key({ code: 'KeyW', key: 'w' }), 'Alt+W')).toBe(false);
  });

  it('treats Mod as Cmd or Ctrl but not both', () => {
    expect(matchesCombo(key({ code: 'KeyK', key: 'k', metaKey: true }), 'Mod+K')).toBe(true);
    expect(matchesCombo(key({ code: 'KeyK', key: 'k', ctrlKey: true }), 'Mod+K')).toBe(true);
    expect(matchesCombo(key({ code: 'KeyK', key: 'k', ctrlKey: true, metaKey: true }), 'Mod+K')).toBe(false);
    expect(matchesCombo(key({ code: 'KeyK', key: 'k' }), 'Mod+K')).toBe(false);
  });

  it('matches named keys and exact modifiers', () => {
    expect(matchesCombo(key({ code: 'ArrowUp', key: 'ArrowUp', ctrlKey: true, altKey: true }), 'Ctrl+Alt+ArrowUp')).toBe(true);
    expect(matchesCombo(key({ code: 'ArrowUp', key: 'ArrowUp', altKey: true }), 'Ctrl+Alt+ArrowUp')).toBe(false);
    expect(matchesCombo(key({ code: 'Comma', key: ',', altKey: true }), 'Alt+,')).toBe(true);
  });
});

describe('shortcut dispatch', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  it('only runs app shortcuts when that app is focused', () => {
    const handler = vi.fn();
    cleanups.push(registerShortcut({ id: 't.notes', keys: 'Mod+N', scope: 'notes', group: 'x', description: 'x', handler }));
    const event = () => Object.assign(new KeyboardEvent('keydown', { code: 'KeyN', key: 'n', metaKey: true, cancelable: true }));
    expect(dispatchShortcut(event(), { focusedAppId: 'files', focusedWindowId: 'f' }, { systemEnabled: true })).toBe(false);
    expect(dispatchShortcut(event(), { focusedAppId: 'notes', focusedWindowId: 'n' }, { systemEnabled: true })).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('respects text fields and the system shortcut switch', () => {
    const handler = vi.fn();
    cleanups.push(registerShortcut({ id: 't.global', keys: 'Alt+D', scope: 'global', group: 'x', description: 'x', handler }));
    const input = document.createElement('input');
    document.body.appendChild(input);
    const inInput = new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', altKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(inInput, 'target', { value: input });
    expect(isEditableTarget(input)).toBe(true);
    expect(dispatchShortcut(inInput, { focusedAppId: null, focusedWindowId: null }, { systemEnabled: true })).toBe(false);
    const plain = new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', altKey: true, cancelable: true });
    expect(dispatchShortcut(plain, { focusedAppId: null, focusedWindowId: null }, { systemEnabled: false })).toBe(false);
    expect(dispatchShortcut(plain, { focusedAppId: null, focusedWindowId: null }, { systemEnabled: true })).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
