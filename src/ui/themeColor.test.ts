// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, THEME_COLOR, applyPrefs, applyThemeColor } from './prefs';

const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
const sidebarToken = (block: RegExp) => css.match(block)?.[1]?.match(/--sidebar:\s*(#[0-9a-f]{6})/i)?.[1]?.toLowerCase();

const metas = () => Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
const content = (scheme: 'dark' | 'light') => metas().find((m) => (m.getAttribute('media') ?? '').includes(scheme))!.getAttribute('content');

describe('status-bar colour (PWA top inset)', () => {
  afterEach(() => { document.head.innerHTML = ''; document.documentElement.removeAttribute('data-theme'); });

  it('index.html ships one theme-color per scheme, each the top bar colour (--sidebar) of that theme', () => {
    expect(html).toMatch(/<meta name="theme-color" content="#181817" media="\(prefers-color-scheme: dark\)"/);
    expect(html).toMatch(/<meta name="theme-color" content="#f1efea" media="\(prefers-color-scheme: light\)"/);
    expect(sidebarToken(/:root\s*\{([^}]*)\}/)).toBe(THEME_COLOR.dark);
    expect(sidebarToken(/:root\[data-theme="light"\]\s*\{([^}]*)\}/)).toBe(THEME_COLOR.light);
  });

  it('the safe-area top strip is painted the top bar colour', () => {
    expect(css).toMatch(/\.app::before\s*\{[^}]*height:\s*env\(safe-area-inset-top[^}]*background:\s*var\(--sidebar\)/);
  });

  it('a forced theme points both metas at its colour; system restores each scheme', () => {
    document.head.innerHTML = '<meta name="theme-color" content="#181817" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#f1efea" media="(prefers-color-scheme: light)">';
    applyThemeColor('light');
    expect([content('dark'), content('light')]).toEqual([THEME_COLOR.light, THEME_COLOR.light]);
    applyPrefs({ ...DEFAULT_PREFS, theme: 'dark' });
    expect([content('dark'), content('light')]).toEqual([THEME_COLOR.dark, THEME_COLOR.dark]);
    applyPrefs({ ...DEFAULT_PREFS, theme: 'system' });
    expect([content('dark'), content('light')]).toEqual([THEME_COLOR.dark, THEME_COLOR.light]);
  });
});
