import { describe, expect, it } from 'vitest';
import { accentFor, resolveTheme } from './useApplySettings';

describe('Erscheinungsbild', () => {
  it('löst „System“ nach der iPadOS-Einstellung auf', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
  });

  it('dunkelt die Akzentfarbe im hellen Design ab, damit sie auf hellem Grund lesbar bleibt', () => {
    expect(accentFor('#87a9e8', 'dark')).toBe('#87a9e8');
    expect(accentFor('#87a9e8', 'light')).toMatch(/^color-mix\(in srgb, #87a9e8 \d+%, #[0-9a-f]{6}\)$/);
  });
});
