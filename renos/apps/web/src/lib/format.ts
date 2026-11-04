import { formatBytes } from '@renos/shared';
import { locale } from '@/i18n';

export { formatBytes };

export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '–';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '–';
  return date.toLocaleString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '–';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '–';
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Relative Zeitangabe („vor 3 Minuten“) mit Intl.RelativeTimeFormat. */
export function formatRelative(value: string | number | Date | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined) return '–';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '–';
  const diff = (time - now) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 45) return 'gerade eben';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  return formatDate(time);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
