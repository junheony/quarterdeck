import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, FONT_SCALE, PREFS_KEY, applyPrefs, loadPrefs, nextTheme, parsePrefs, prefsReducer, savePrefs } from './prefs';

const mem = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), raw: m };
};

/** Just enough of an HTMLElement for applyPrefs. */
const fakeRoot = () => {
  const attrs = new Map<string, string>();
  const props = new Map<string, string>();
  const root = {
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
    style: { setProperty: (k: string, v: string) => void props.set(k, v) },
  };
  return { root: root as unknown as HTMLElement, attrs, props };
};

describe('prefs', () => {
  it('defaults to a font size at least as large as before', () => {
    expect(DEFAULT_PREFS.theme).toBe('system');
    expect(FONT_SCALE[DEFAULT_PREFS.fontSize]).toBeGreaterThanOrEqual(1);
  });

  it('round-trips through storage and tolerates junk', () => {
    const store = mem();
    const prefs = { theme: 'dark', fontSize: 'xlarge', chatWidth: 'wide', sendKey: 'mod-enter' } as const;
    savePrefs(prefs, store);
    expect(loadPrefs(store)).toEqual(prefs);
    expect(parsePrefs('not json')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(JSON.stringify({ theme: 'neon', fontSize: 'large' }))).toEqual({ ...DEFAULT_PREFS, fontSize: 'large' });
    expect(loadPrefs(mem({ [PREFS_KEY]: '{"chatWidth":"wide"}' })).chatWidth).toBe('wide');
    expect(loadPrefs(null)).toEqual(DEFAULT_PREFS);
  });

  it('reducer sets valid values, ignores invalid or unchanged ones, and resets', () => {
    const a = prefsReducer(DEFAULT_PREFS, { type: 'set', key: 'theme', value: 'light' });
    expect(a.theme).toBe('light');
    expect(prefsReducer(a, { type: 'set', key: 'theme', value: 'light' })).toBe(a);
    expect(prefsReducer(a, { type: 'set', key: 'theme', value: 'neon' as never })).toBe(a);
    expect(prefsReducer(a, { type: 'reset' })).toEqual(DEFAULT_PREFS);
  });

  it('applyPrefs: forced theme sets data-theme, system removes it; font scale and width are applied', () => {
    const { root, attrs, props } = fakeRoot();
    applyPrefs({ ...DEFAULT_PREFS, theme: 'dark', fontSize: 'large', chatWidth: 'wide' }, root);
    expect(attrs.get('data-theme')).toBe('dark');
    expect(attrs.get('data-width')).toBe('wide');
    expect(props.get('--font-scale')).toBe(String(FONT_SCALE.large));
    applyPrefs({ ...DEFAULT_PREFS, theme: 'system' }, root);
    expect(attrs.has('data-theme')).toBe(false);
    expect(props.get('--font-scale')).toBe(String(FONT_SCALE.normal));
  });
});

describe('nextTheme', () => {
  it('cycles 시스템 → 라이트 → 다크 → 시스템', () => {
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
  });
});
