import type { ReactNode } from 'react';
import { create } from 'zustand';

/** Systemdialoge mit Promise-API: `await confirm({...})`, `await prompt({...})`. */

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: ReactNode;
  label: string;
  defaultValue?: string;
  confirmLabel?: string;
  validate?: (value: string) => string | null;
  selectBaseName?: boolean;
}

export interface CustomDialogOptions {
  title?: string;
  render: (close: () => void) => ReactNode;
  width?: number;
}

export type DialogRequest =
  | ({ id: number; type: 'confirm'; resolve: (ok: boolean) => void } & ConfirmOptions)
  | ({ id: number; type: 'prompt'; resolve: (value: string | null) => void } & PromptOptions)
  | ({ id: number; type: 'custom'; resolve: () => void } & CustomDialogOptions);

interface DialogStore {
  stack: DialogRequest[];
  push: (dialog: DialogRequest) => void;
  pop: (id: number) => void;
}

let seq = 0;

export const useDialogs = create<DialogStore>()((set) => ({
  stack: [],
  push: (dialog) => set((s) => ({ stack: [...s.stack, dialog] })),
  pop: (id) => set((s) => ({ stack: s.stack.filter((d) => d.id !== id) })),
}));

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    seq += 1;
    useDialogs.getState().push({ ...options, id: seq, type: 'confirm', resolve });
  });
}

export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    seq += 1;
    useDialogs.getState().push({ ...options, id: seq, type: 'prompt', resolve });
  });
}

export function openDialog(options: CustomDialogOptions): Promise<void> {
  return new Promise((resolve) => {
    seq += 1;
    useDialogs.getState().push({ ...options, id: seq, type: 'custom', resolve });
  });
}
