import { describe, expect, it } from 'vitest';
import { applySuggestion, detectTrigger, fuzzyScore, mentionFor, rankCommands, rankFiles } from './autocomplete';

describe('detectTrigger', () => {
  it('slash only at the very start of the message', () => {
    expect(detectTrigger('/com', 4)).toEqual({ kind: 'command', query: 'com', start: 0, end: 4 });
    expect(detectTrigger('/', 1)).toEqual({ kind: 'command', query: '', start: 0, end: 1 });
    expect(detectTrigger('/compact now', 12)).toBeNull();
    expect(detectTrigger('see /etc', 8)).toBeNull();
    expect(detectTrigger('/usr/bin', 8)).toBeNull();
  });

  it('@ at the start of a word anywhere, token extends past the cursor', () => {
    expect(detectTrigger('look at @src/ma', 15)).toEqual({ kind: 'file', query: 'src/ma', start: 8, end: 15 });
    expect(detectTrigger('@', 1)).toEqual({ kind: 'file', query: '', start: 0, end: 1 });
    expect(detectTrigger('x @srcmain.ts y', 6)).toEqual({ kind: 'file', query: 'src', start: 2, end: 13 });
    expect(detectTrigger('mail me@host', 12)).toBeNull();
    expect(detectTrigger('@src done', 9)).toBeNull();
  });
});

describe('fuzzy ranking', () => {
  it('subsequence or nothing; case-insensitive', () => {
    expect(fuzzyScore('smt', 'src/main.ts')).not.toBeNull();
    expect(fuzzyScore('MAIN', 'src/main.ts')).not.toBeNull();
    expect(fuzzyScore('xyz', 'src/main.ts')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('basename and contiguous matches beat scattered ones', () => {
    const files = ['docs/mapping/ain.md', 'src/main.ts', 'src/server/domain.ts', 'README.md'];
    expect(rankFiles('main', files)[0]).toBe('src/main.ts');
    expect(rankFiles('main', files)).not.toContain('README.md');
    expect(rankFiles('', files)).toHaveLength(4);
    expect(rankFiles('s', files, 2)).toHaveLength(2);
  });

  it('commands: prefix matches first in list order, then fuzzy', () => {
    const cmds = ['compact', 'review', 'security-review', 'init', 'context'].map((name) => ({ name, description: '', argumentHint: '' }));
    expect(rankCommands('', cmds).map((c) => c.name)).toEqual(['compact', 'review', 'security-review', 'init', 'context']);
    expect(rankCommands('co', cmds).map((c) => c.name)).toEqual(['compact', 'context']);
    expect(rankCommands('rev', cmds).map((c) => c.name)).toEqual(['review', 'security-review']);
    expect(rankCommands('zz', cmds)).toEqual([]);
  });
});

describe('applySuggestion', () => {
  it('replaces the token and adds one space', () => {
    const t = detectTrigger('fix @ma please', 7)!;
    expect(applySuggestion('fix @ma please', t, '@src/main.ts')).toEqual({ text: 'fix @src/main.ts please', cursor: 17 });
    const c = detectTrigger('/re', 3)!;
    expect(applySuggestion('/re', c, '/review')).toEqual({ text: '/review ', cursor: 8 });
  });

  it('quotes paths with spaces', () => {
    expect(mentionFor('a b/c.txt')).toBe('@"a b/c.txt"');
    expect(mentionFor('src/x.ts')).toBe('@src/x.ts');
  });
});
