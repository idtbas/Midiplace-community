import { APP_META } from '@/system/appMeta';
import type { AppId } from '@/system/appIds';
import { cn } from '@/lib/cn';

export function AppIcon({ appId, size = 24, className }: { appId: AppId; size?: number; className?: string }) {
  return (
    <img
      src={APP_META[appId].icon}
      alt=""
      width={size}
      height={size}
      draggable={false}
      className={cn('pointer-events-none shrink-0 select-none', className)}
      style={{ width: size, height: size }}
    />
  );
}

export function RenosMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 19.5V4.5h5.6a4.6 4.6 0 0 1 0 9.2H7" />
      <path d="M12.4 13.7l5.1 5.8" stroke="var(--accent)" />
    </svg>
  );
}
