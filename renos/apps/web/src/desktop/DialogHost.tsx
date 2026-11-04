import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { t } from '@/i18n';
import { useDialogs, type DialogRequest } from '@/system/dialogs';
import { Button } from '@/ui/Button';
import { TextInput } from '@/ui/Form';

/** Systemdialoge: modal über dem Desktop, mit Fokusfalle, Esc zum Abbrechen und Enter zum Bestätigen. */
export function DialogHost() {
  const stack = useDialogs((s) => s.stack);
  const top = stack[stack.length - 1];
  return (
    <AnimatePresence>
      {top ? (
        <motion.div
          key="backdrop"
          className="fixed inset-0 flex items-center justify-center bg-black/45 p-6"
          style={{ zIndex: 9500 }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
        >
          <DialogView key={top.id} dialog={top} />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function trapFocus(container: HTMLElement, event: React.KeyboardEvent) {
  if (event.key !== 'Tab') return;
  const focusable = [...container.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter(
    (el) => !el.hasAttribute('disabled'),
  );
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function DialogView({ dialog }: { dialog: DialogRequest }) {
  const pop = useDialogs((s) => s.pop);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<Element | null>(document.activeElement);
  const [value, setValue] = useState(dialog.type === 'prompt' ? (dialog.defaultValue ?? '') : '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const prev = previousFocus.current;
    if (dialog.type === 'prompt' && inputRef.current) {
      const input = inputRef.current;
      input.focus();
      const dot = dialog.selectBaseName ? input.value.lastIndexOf('.') : -1;
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    } else if (dialog.type === 'confirm') {
      confirmRef.current?.focus();
    } else {
      ref.current?.focus();
    }
    return () => {
      if (prev instanceof HTMLElement) prev.focus({ preventScroll: true });
    };
  }, [dialog]);

  const finish = (result: 'ok' | 'cancel') => {
    pop(dialog.id);
    if (dialog.type === 'confirm') dialog.resolve(result === 'ok');
    else if (dialog.type === 'prompt') dialog.resolve(result === 'ok' ? value.trim() : null);
    else dialog.resolve();
  };

  const submit = () => {
    if (dialog.type === 'prompt' && dialog.validate) {
      const problem = dialog.validate(value);
      if (problem) {
        setError(problem);
        return;
      }
    }
    finish('ok');
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      finish('cancel');
    } else if (e.key === 'Enter' && dialog.type !== 'custom' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      submit();
    } else if (ref.current) {
      trapFocus(ref.current, e);
    }
  };

  let body: ReactNode;
  if (dialog.type === 'custom') {
    body = dialog.render(() => finish('ok'));
  } else {
    body = (
      <>
        <h2 className="text-lg font-semibold text-fg">{dialog.title}</h2>
        {dialog.message ? <div className="mt-2 text-base text-fg-muted">{dialog.message}</div> : null}
        {dialog.type === 'prompt' ? (
          <div className="mt-4">
            <label className="mb-1.5 block text-sm text-fg-muted" htmlFor={`dlg-${dialog.id}`}>
              {dialog.label}
            </label>
            <TextInput
              id={`dlg-${dialog.id}`}
              ref={inputRef}
              value={value}
              invalid={Boolean(error)}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
            />
            {error ? <p className="mt-1.5 text-sm text-danger">{error}</p> : null}
          </div>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => finish('cancel')}>
            {dialog.type === 'confirm' ? (dialog.cancelLabel ?? t.system.cancel) : t.system.cancel}
          </Button>
          <Button
            ref={confirmRef}
            variant={dialog.type === 'confirm' && dialog.destructive ? 'danger' : 'primary'}
            onClick={submit}
          >
            {dialog.confirmLabel ?? t.system.ok}
          </Button>
        </div>
      </>
    );
  }

  return (
    <motion.div
      ref={ref}
      role="alertdialog"
      aria-modal="true"
      aria-label={dialog.type === 'custom' ? dialog.title : dialog.title}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="os-chrome w-full rounded-xl border border-line-soft bg-surface-1 p-5 shadow-[var(--shadow-window)] outline-none"
      style={{ maxWidth: dialog.type === 'custom' ? (dialog.width ?? 520) : 420 }}
      initial={{ opacity: 0, scale: 0.97, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
    >
      {body}
    </motion.div>
  );
}
