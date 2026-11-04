import { forwardRef, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  iconRight?: ReactNode;
  loading?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-strong active:brightness-95 font-medium',
  secondary: 'bg-surface-3/80 text-fg hover:bg-surface-4 active:bg-surface-3 border border-line-soft',
  ghost: 'bg-transparent text-fg-muted hover:bg-surface-3/70 hover:text-fg active:bg-surface-3',
  danger: 'bg-danger-soft text-danger hover:bg-danger/25 border border-danger/30 font-medium',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-sm gap-1.5 rounded-sm',
  md: 'h-8 px-3 text-base gap-2 rounded-md',
  lg: 'h-10 px-4 text-md gap-2 rounded-md',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, iconRight, loading, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-[background-color,color,filter] duration-[var(--dur-fast)] disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span className="spin inline-block h-3.5 w-3.5 rounded-full border-2 border-current border-r-transparent" aria-hidden />
      ) : Icon ? (
        <Icon size={size === 'sm' ? 14 : 16} strokeWidth={1.9} />
      ) : null}
      {children}
      {iconRight}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  label: string;
  size?: 'sm' | 'md';
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, size = 'md', active, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-sm text-fg-muted transition-colors duration-[var(--dur-fast)] hover:bg-surface-3/80 hover:text-fg active:bg-surface-3 disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'h-7 w-7' : 'h-8 w-8',
        active && 'bg-surface-3 text-fg',
        className,
      )}
      {...rest}
    >
      <Icon size={size === 'sm' ? 15 : 17} strokeWidth={1.8} />
    </button>
  );
});
