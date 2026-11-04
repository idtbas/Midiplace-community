import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function TextInput(
  { className, invalid, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-8 w-full rounded-md border bg-surface-0/80 px-2.5 text-base text-fg placeholder:text-fg-faint transition-colors duration-[var(--dur-fast)] focus:border-accent focus:outline-none focus-visible:outline-none',
        invalid ? 'border-danger/70' : 'border-line-soft hover:border-line',
        className,
      )}
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      {...rest}
    />
  );
});

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg-muted">
        {label}
      </label>
      {children}
      {error ? <p className="text-sm text-danger">{error}</p> : hint ? <p className="text-sm text-fg-subtle">{hint}</p> : null}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border transition-colors duration-[var(--dur)] disabled:opacity-40',
        checked ? 'border-accent bg-accent' : 'border-line bg-surface-3',
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] h-4 w-4 rounded-full shadow-sm transition-transform duration-[var(--dur)] ease-[var(--ease-out)]',
          checked ? 'translate-x-[18px] bg-accent-fg' : 'translate-x-[2px] bg-fg-muted',
        )}
      />
    </button>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  size = 'md',
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
  size?: 'sm' | 'md';
}) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line-soft bg-surface-0/70 p-0.5">
      {options.map((option) => (
        <button
          key={String(option.value)}
          id={`${id}-${String(option.value)}`}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'whitespace-nowrap rounded-sm px-2.5 transition-colors duration-[var(--dur-fast)]',
            size === 'sm' ? 'h-6 text-sm' : 'h-7 text-base',
            option.value === value ? 'bg-surface-3 text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
