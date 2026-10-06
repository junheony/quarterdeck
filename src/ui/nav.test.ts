import { describe, expect, it } from 'vitest';
import { dateGroupOf, groupByDate } from './dateGroups';
import { fuzzyFilter, fuzzyScore } from './fuzzy';
import { isMacPlatform, matchPinShortcut, matchShortcut, pinKeyLabel, shortcutList, type ShortcutKey } from './shortcuts';

describe('fuzzyScore / fuzzyFilter', () => {
  it('matches substrings and in-order subsequences, case-insensitively; misses are null', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('DECK', 'my deck project')).not.toBeNull();
    expect(fuzzyScore('dkp', 'deck project')).not.toBeNull();
    expect(fuzzyScore('pkd', 'deck project')).toBeNull();
    expect(fuzzyScore('토큰', '토큰 회전 방법')).not.toBeNull();
    expect(fuzzyScore('토회', '토큰 회전 방법')).not.toBeNull();
    expect(fuzzyScore('회토', '토큰 회전')).toBeNull();
  });
  it('every token must match (title + project)', () => {
    expect(fuzzyScore('login deck', 'fix login · deck')).not.toBeNull();
    expect(fuzzyScore('login other', 'fix login · deck')).toBeNull();
  });
  it('ranks prefix > word boundary > inner substring > subsequence; ties keep input order', () => {
    const items = ['scrollbar fix', 'fix the bar', 'bar chart', 'b-a-r', 'bar chart 2'];
    expect(fuzzyFilter(items, 'bar', (s) => s)).toEqual(['bar chart', 'bar chart 2', 'fix the bar', 'scrollbar fix', 'b-a-r']);
    expect(fuzzyFilter(items, 'bar', (s) => s, 2)).toEqual(['bar chart', 'bar chart 2']);
    expect(fuzzyFilter(items, 'zzz', (s) => s)).toEqual([]);
  });
});

describe('date groups', () => {
  const now = new Date(2026, 9, 2, 15, 0).getTime();
  const at = (d: number, h = 12) => new Date(2026, 9, d, h).getTime();
  it('buckets by local calendar day', () => {
    expect(dateGroupOf(new Date(2026, 9, 2, 0, 0, 1).getTime(), now)).toBe('오늘');
    expect(dateGroupOf(new Date(2026, 9, 1, 23, 59).getTime(), now)).toBe('어제');
    expect(dateGroupOf(at(1, 0), now)).toBe('어제');
    expect(dateGroupOf(new Date(2026, 8, 26, 0, 1).getTime(), now)).toBe('지난 7일');
    expect(dateGroupOf(new Date(2026, 8, 25, 23).getTime(), now)).toBe('지난 30일');
    expect(dateGroupOf(new Date(2026, 8, 3, 12).getTime(), now)).toBe('지난 30일');
    expect(dateGroupOf(new Date(2026, 8, 2, 12).getTime(), now)).toBe('이전');
  });
  it('groups newest first, only non-empty groups, in fixed order', () => {
    const items = [{ id: 'old', lastModified: at(1, 1) - 40 * 86_400_000 }, { id: 'y', lastModified: at(1) }, { id: 't1', lastModified: at(2, 9) }, { id: 't2', lastModified: at(2, 14) }];
    expect(groupByDate(items, now).map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([['오늘', ['t2', 't1']], ['어제', ['y']], ['이전', ['old']]]);
  });
});

describe('shortcuts', () => {
  const key = (code: string, mods: Partial<ShortcutKey> = {}): ShortcutKey => ({ key: '', code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
  const mac = { mac: true, typing: false };
  it('⌘ on Mac, Ctrl elsewhere — never the other one', () => {
    expect(matchShortcut(key('KeyK', { metaKey: true }), mac)).toBe('palette');
    expect(matchShortcut(key('KeyK', { ctrlKey: true }), mac)).toBeNull();
    expect(matchShortcut(key('KeyK', { ctrlKey: true }), { mac: false, typing: false })).toBe('palette');
    expect(matchShortcut(key('KeyK', { metaKey: true }), { mac: false, typing: false })).toBeNull();
    expect(matchShortcut(key('KeyK'), mac)).toBeNull();
    expect(matchShortcut(key('KeyK', { metaKey: true, altKey: true }), mac)).toBeNull();
  });
  it('dispatches each binding by physical key (works with a Korean input source)', () => {
    const m = (code: string, extra: Partial<ShortcutKey> = {}) => matchShortcut(key(code, { metaKey: true, ...extra }), mac);
    expect(m('KeyN')).toBe('new-chat');
    expect(m('KeyO', { shiftKey: true })).toBe('new-pane');
    expect(m('KeyO')).toBeNull();
    expect(m('BracketLeft')).toBe('prev-session');
    expect(m('BracketRight')).toBe('next-session');
    expect(m('Backslash')).toBe('toggle-sidebar');
    expect(m('Slash')).toBe('help');
    expect(m('KeyK', { key: 'ㅏ' })).toBe('palette');
    expect(matchShortcut({ ...key(''), key: 'k', metaKey: true }, mac)).toBe('palette');
  });
  it('ignores IME composition; ⌘[ / ⌘] stay out of text fields', () => {
    expect(matchShortcut(key('KeyK', { metaKey: true, isComposing: true }), mac)).toBeNull();
    expect(matchShortcut(key('KeyK', { metaKey: true, keyCode: 229 }), mac)).toBeNull();
    const typing = { mac: true, typing: true };
    expect(matchShortcut(key('BracketLeft', { metaKey: true }), typing)).toBeNull();
    expect(matchShortcut(key('KeyK', { metaKey: true }), typing)).toBe('palette');
    expect(matchShortcut(key('KeyN', { metaKey: true }), typing)).toBe('new-chat');
  });
  it('platform detection and cheat-sheet labels', () => {
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isMacPlatform({ platform: 'Win32' })).toBe(false);
    expect(shortcutList(true).find((s) => s.id === 'palette')?.keys).toBe('⌘K');
    expect(shortcutList(false).find((s) => s.id === 'new-pane')?.keys).toBe('Ctrl+⇧O');
  });
  it('⌘1 … ⌘9 → the 고정됨 row index: plain modifier only, never mid-IME', () => {
    const m = (code: string, extra: Partial<ShortcutKey> & { repeat?: boolean } = {}, isMac = true) => matchPinShortcut(key(code, { metaKey: true, ...extra }), isMac);
    expect(m('Digit1')).toBe(0);
    expect(m('Digit9')).toBe(8);
    expect(m('Digit0')).toBeNull();
    expect(m('Numpad1')).toBeNull();
    expect(m('KeyK')).toBeNull();
    expect(m('Digit1', { shiftKey: true })).toBeNull();
    expect(m('Digit1', { altKey: true })).toBeNull();
    expect(m('Digit1', { ctrlKey: true })).toBeNull();
    expect(m('Digit1', { repeat: true })).toBe(0);
    expect(m('Digit1', { isComposing: true })).toBeNull();
    expect(m('Digit1', { keyCode: 229 })).toBeNull();
    expect(matchPinShortcut(key('Digit2'), true)).toBeNull();
    expect(m('Digit2', {}, false)).toBeNull(); // ⌘ off Mac
    expect(matchPinShortcut(key('Digit2', { ctrlKey: true }), false)).toBe(1);
    expect(matchPinShortcut({ ...key(''), key: '3', metaKey: true }, true)).toBe(2); // no `code`: by key
    expect([pinKeyLabel(0, true), pinKeyLabel(8, false), pinKeyLabel(9, true)]).toEqual(['⌘1', 'Ctrl+9', null]);
  });
});
