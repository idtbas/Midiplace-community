import { create } from 'zustand';
import { useSettings } from './settings';

export type NotificationKind = 'info' | 'success' | 'warning' | 'error';

export interface NotificationAction {
  label: string;
  run: () => void;
}

export interface RenosNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  message?: string;
  createdAt: number;
  read: boolean;
  action?: NotificationAction;
  /** Nur als Toast zeigen, nicht im Benachrichtigungsverlauf speichern. */
  transient?: boolean;
}

interface NotificationStore {
  items: RenosNotification[];
  toasts: string[];
  notify: (n: Omit<RenosNotification, 'id' | 'createdAt' | 'read'> & { duration?: number }) => string;
  dismissToast: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  markAllRead: () => void;
}

let seq = 0;
const MAX_ITEMS = 50;

export const useNotifications = create<NotificationStore>()((set, get) => ({
  items: [],
  toasts: [],
  notify: ({ duration, ...n }) => {
    seq += 1;
    const id = `n${Date.now().toString(36)}${seq}`;
    const item: RenosNotification = { ...n, id, createdAt: Date.now(), read: false };
    const dnd = useSettings.getState().doNotDisturb;
    // Fehler werden auch bei „Nicht stören“ angezeigt, damit nichts unbemerkt fehlschlägt.
    const showToast = !dnd || n.kind === 'error' || n.transient;
    // Transiente Hinweise liegen nur kurz in `items` (für den Toast) und erscheinen nicht im Verlauf.
    set((s) => ({
      items: [item, ...s.items].slice(0, MAX_ITEMS),
      toasts: showToast ? [...s.toasts, id].slice(-4) : s.toasts,
    }));
    const ms = duration ?? (n.kind === 'error' ? 8000 : n.action ? 7000 : 4500);
    if (showToast) window.setTimeout(() => get().dismissToast(id), ms);
    if (n.transient) window.setTimeout(() => get().remove(id), ms + 500);
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t !== id) })),
  remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id), toasts: s.toasts.filter((t) => t !== id) })),
  clear: () => set((s) => ({ items: s.items.filter((i) => i.transient) })),
  markAllRead: () => set((s) => ({ items: s.items.map((i) => (i.read ? i : { ...i, read: true })) })),
}));

export const notify = (n: Parameters<NotificationStore['notify']>[0]) => useNotifications.getState().notify(n);
