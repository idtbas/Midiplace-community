import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AppId } from '@/system/appIds';

export interface WindowContextValue {
  windowId: string;
  appId: AppId;
  focused: boolean;
  headerSlot: HTMLElement | null;
}

export const WindowContext = createContext<WindowContextValue | null>(null);

export function useWindowContext(): WindowContextValue {
  const value = useContext(WindowContext);
  if (!value) throw new Error('useWindowContext must be used inside a window');
  return value;
}

/** Rendert Bedienelemente einer App in die Titelleiste ihres Fensters (wie GNOME-Headerbars). */
export function WindowHeader({ children }: { children: ReactNode }) {
  const { headerSlot } = useWindowContext();
  return headerSlot ? createPortal(children, headerSlot) : null;
}
