/** Verbindet CSS-Klassen und ignoriert leere Werte. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
