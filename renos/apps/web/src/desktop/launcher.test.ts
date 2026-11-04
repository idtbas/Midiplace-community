import { describe, expect, it } from 'vitest';
import { parseBridgeMessage } from '@renos/shared';
import { scoreMatch } from './Launcher';

describe('launcher search', () => {
  it('ranks exact and prefix matches above substring matches', () => {
    expect(scoreMatch('files', 'Files')).toBeGreaterThan(scoreMatch('iles', 'Files'));
    expect(scoreMatch('bib', 'Library', 'bibliothek')).toBeGreaterThan(0);
    expect(scoreMatch('zzz', 'Files')).toBe(0);
  });
});

describe('bridge messages from the game iframe', () => {
  it('accepts only well-formed messages', () => {
    expect(parseBridgeMessage({ source: 'renos-bridge', v: 1, type: 'running' })).toEqual({ source: 'renos-bridge', v: 1, type: 'running' });
    expect(parseBridgeMessage({ source: 'renos-bridge', v: 1, type: 'progress', done: 5, total: 10 })).toMatchObject({ done: 5, total: 10 });
    expect(parseBridgeMessage({ source: 'renos-bridge', v: 1, type: 'progress', done: 5, total: 0 })).toBeNull();
    expect(parseBridgeMessage({ source: 'renos-bridge', v: 1, type: 'error', message: 'x'.repeat(2000) })).toMatchObject({ message: 'x'.repeat(500) });
    expect(parseBridgeMessage({ source: 'renos-bridge', v: 1, type: 'navigate', url: 'https://evil' })).toBeNull();
    expect(parseBridgeMessage({ source: 'other', v: 1, type: 'running' })).toBeNull();
    expect(parseBridgeMessage('running')).toBeNull();
    expect(parseBridgeMessage(null)).toBeNull();
  });
});
