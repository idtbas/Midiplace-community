import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span
      role="status"
      aria-label="Wird geladen"
      className={cn('spin inline-block rounded-full border-2 border-fg-subtle/40 border-t-accent', className)}
      style={{ width: size, height: size }}
    />
  );
}

/** Fortschrittsbalken. Ohne `value` unbestimmt (nur für Vorgänge ohne messbaren Fortschritt). */
export function ProgressBar({ value, className, label }: { value?: number | null; className?: string; label?: string }) {
  const determinate = typeof value === 'number' && Number.isFinite(value);
  const percent = determinate ? Math.round(Math.min(Math.max(value, 0), 1) * 100) : undefined;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-surface-3', className)}
    >
      {determinate ? (
        <div className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out" style={{ width: `${percent}%` }} />
      ) : (
        <div className="absolute inset-y-0 w-1/3 rounded-full bg-accent/80" style={{ animation: 'renos-indeterminate 1.2s ease-in-out infinite' }} />
      )}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  image,
  title,
  children,
  actions,
  className,
}: {
  icon?: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  image?: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex h-full flex-col items-center justify-center px-8 py-10 text-center', className)}>
      {image ? <img src={image} alt="" className="mb-4 h-16 w-16 opacity-90" draggable={false} /> : null}
      {Icon ? (
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-surface-2 text-fg-subtle">
          <Icon size={26} strokeWidth={1.6} />
        </div>
      ) : null}
      <h3 className="text-lg font-semibold text-fg">{title}</h3>
      {children ? <div className="mt-1.5 max-w-md text-base text-fg-muted">{children}</div> : null}
      {actions ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-line-soft bg-surface-2 px-1.5 font-sans text-xs text-fg-muted">
      {children}
    </kbd>
  );
}

export function Notice({ kind = 'info', children, className }: { kind?: 'info' | 'warning' | 'error' | 'success'; children: ReactNode; className?: string }) {
  const styles = {
    info: 'border-line-soft bg-surface-2/70 text-fg-muted',
    warning: 'border-warning/30 bg-warning-soft text-warning',
    error: 'border-danger/30 bg-danger-soft text-danger',
    success: 'border-success/30 bg-success-soft text-success',
  } as const;
  return <div className={cn('rounded-md border px-3 py-2.5 text-base', styles[kind], className)}>{children}</div>;
}
