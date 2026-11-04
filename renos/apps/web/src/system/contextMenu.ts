import type { ComponentType } from 'react';
import { create } from 'zustand';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  run?: () => void;
}

export type MenuEntry = MenuItem | 'separator';

interface MenuState {
  open: boolean;
  x: number;
  y: number;
  items: MenuEntry[];
  /** Element, das den Fokus nach dem Schließen zurückerhält. */
  returnFocus: HTMLElement | null;
  show: (x: number, y: number, items: MenuEntry[]) => void;
  hide: () => void;
}

export const useContextMenu = create<MenuState>()((set, get) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  returnFocus: null,
  show: (x, y, items) =>
    set({ open: true, x, y, items, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null }),
  hide: () => {
    const { returnFocus, open } = get();
    if (!open) return;
    set({ open: false, items: [] });
    returnFocus?.focus?.({ preventScroll: true });
  },
}));

/** Öffnet ein Kontextmenü an der Zeigerposition (Rechtsklick, Zwei-Finger-Klick oder langes Drücken). */
export function showContextMenu(event: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuEntry[]): void {
  event.preventDefault?.();
  event.stopPropagation?.();
  useContextMenu.getState().show(event.clientX, event.clientY, items);
}

/** Öffnet ein Menü unterhalb eines Elements (z. B. eines Buttons). */
export function showMenuAt(element: HTMLElement, items: MenuEntry[], align: 'left' | 'right' = 'left'): void {
  const rect = element.getBoundingClientRect();
  useContextMenu.getState().show(align === 'left' ? rect.left : rect.right, rect.bottom + 4, items);
}
