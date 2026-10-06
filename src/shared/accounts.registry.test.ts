import { describe, expect, it } from 'vitest';
import { ACCOUNT_ID_RE, LEGACY_ACCOUNTS, buildRegistry, defaultAccountsConfig } from './accounts';
import { testRegistry } from './accounts.testkit';

const H = '/Users/x';

describe('defaultAccountsConfig (no accounts.json)', () => {
  it('~/.claude → a, ~/.claude-<x> → x, sorted by id, legacy card ids, home a', () => {
    expect(defaultAccountsConfig(['.claude-c', '.claude', '.claude-b'])).toEqual({
      version: 1,
      home: 'a',
      accounts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    });
  });

  it('the result equals the old hard-coded a/b/c', () => {
    const r = buildRegistry(defaultAccountsConfig(['.claude', '.claude-b', '.claude-c']), { homeDir: H });
    expect(r.list()).toEqual(['a', 'b', 'c']);
    expect(r.all()).toEqual(['a', 'b', 'c']);
    expect(r.home).toBe('a');
    expect(r.list().map((a) => r.label(a))).toEqual(['A', 'B', 'C']);
    expect(r.list().map((a) => r.profileDir(a))).toEqual([`${H}/.claude`, `${H}/.claude-b`, `${H}/.claude-c`]);
    expect(r.list().map((a) => r.cardId(a))).toEqual(['claude:main', 'claude:second', 'claude:third']);
    expect(r.projectsRoots()).toEqual([{ id: 'a', dir: `${H}/.claude/projects` }, { id: 'b', dir: `${H}/.claude-b/projects` }, { id: 'c', dir: `${H}/.claude-c/projects` }]);
    const base = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/elsewhere', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u' };
    expect(r.env('a', base)).toEqual({ PATH: '/bin' });
    expect(r.env('b', base)).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: `${H}/.claude-b` });
    expect(r.env('c', base)).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: `${H}/.claude-c` });
    expect(base.ANTHROPIC_API_KEY).toBe('k');
  });

  it('only ~/.claude and one-letter ~/.claude-<a-z> are accounts; every other ~/.claude-* is named once with the accounts.json entry to add', () => {
    const notes: string[] = [];
    const cfg = defaultAccountsConfig(['.claude', '.claude-work', '.claude-b', '.claude-backup', '.claude-2', '.claude-UPPER', '.claude-gpt', '.claude-a', '.claudex', '.claude-'], (l) => notes.push(l));
    expect(cfg.accounts).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(notes.filter((n) => n.includes('.claude-work'))).toHaveLength(1);
    expect(notes.find((n) => n.includes('.claude-work'))).toContain('accounts.json');
    expect(notes.find((n) => n.includes('.claude-work'))).toContain('{"id":"work","configDir":"~/.claude-work"}');
    expect(notes.find((n) => n.includes('.claude-2'))).toContain('{"id":"2","configDir":"~/.claude-2"}');
    expect(notes.find((n) => n.includes('.claude-UPPER'))).toContain('{"id":"upper","configDir":"~/.claude-UPPER"}');
    // A reserved or impossible id: the entry shows a placeholder id.
    expect(notes.find((n) => n.includes('.claude-gpt'))).toContain('"configDir":"~/.claude-gpt"');
    expect(notes.find((n) => n.includes('.claude-gpt'))).not.toContain('"id":"gpt"');
    expect(notes.some((n) => n.includes('.claude-a'))).toBe(true);
    expect(notes.some((n) => n.includes('.claudex'))).toBe(false);
    expect(notes).toHaveLength(6);
  });

  it('an upper-case one-letter suffix is the lower-case id and keeps the real directory name; a second spelling of the same letter is skipped', () => {
    const notes: string[] = [];
    const cfg = defaultAccountsConfig(['.claude', '.claude-B', '.claude-c'], (l) => notes.push(l));
    expect(cfg.accounts).toEqual([{ id: 'a' }, { id: 'b', configDir: '~/.claude-B' }, { id: 'c' }]);
    expect(notes).toEqual([]);
    const r = buildRegistry(cfg, { homeDir: H });
    expect(r.list()).toEqual(['a', 'b', 'c']);
    expect(r.profileDir('b')).toBe(`${H}/.claude-B`);
    expect(r.cardId('b')).toBe('claude:second');
    const both = defaultAccountsConfig(['.claude-B', '.claude-b', '.claude'], (l) => notes.push(l));
    expect(both.accounts).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('.claude-B');
  });

  it('without ~/.claude the first account is home; with nothing at all it is a alone', () => {
    expect(defaultAccountsConfig(['.claude-c', '.claude-b'])).toEqual({ version: 1, home: 'b', accounts: [{ id: 'b' }, { id: 'c' }] });
    expect(defaultAccountsConfig([])).toEqual({ version: 1, home: 'a', accounts: [{ id: 'a' }] });
  });
});

describe('buildRegistry', () => {
  it('applies label / configDir / card defaults and keeps the file order', () => {
    const r = buildRegistry({ version: 1, home: 'work', accounts: [
      { id: 'work', label: '회사', configDir: '~/profiles/work/', card: 'claude:team' },
      { id: 'a' },
      { id: 'x1', configDir: '/abs/x1' },
    ] }, { homeDir: H });
    expect(r.list()).toEqual(['work', 'a', 'x1']);
    expect(r.home).toBe('work');
    expect(r.isHome('work')).toBe(true);
    expect(r.isHome('a')).toBe(false);
    expect(r.label('work')).toBe('회사');
    expect(r.profileDir('work')).toBe(`${H}/profiles/work`);
    expect(r.projectsDir('work')).toBe(`${H}/profiles/work/projects`);
    expect(r.cardId('work')).toBe('claude:team');
    expect(r.profileDir('a')).toBe(`${H}/.claude`);
    expect(r.cardId('a')).toBe('claude:main');
    expect(r.profileDir('x1')).toBe('/abs/x1');
    expect(r.cardId('x1')).toBe('claude:x1');
    expect(r.label('x1')).toBe('X1');
    // CLAUDE_CONFIG_DIR stays unset only for the default profile dir (keychain service name without a hash suffix).
    expect('CLAUDE_CONFIG_DIR' in r.env('a', { CLAUDE_CONFIG_DIR: '/e' })).toBe(false);
    expect(r.env('work', {}).CLAUDE_CONFIG_DIR).toBe(`${H}/profiles/work`);
  });

  it('home defaults to a, else the first active account', () => {
    expect(buildRegistry({ version: 1, accounts: [{ id: 'b' }, { id: 'a' }] }, { homeDir: H }).home).toBe('a');
    expect(buildRegistry({ version: 1, accounts: [{ id: 'c', retired: true }, { id: 'b' }] }, { homeDir: H }).home).toBe('b');
  });

  it('retired accounts are known but not listed', () => {
    const r = buildRegistry({ version: 1, accounts: [{ id: 'a' }, { id: 'b' }, { id: 'c', retired: true }] }, { homeDir: H });
    expect(r.list()).toEqual(['a', 'b']);
    expect(r.all()).toEqual(['a', 'b', 'c']);
    expect(r.has('c')).toBe(true);
    expect(r.isRetired('c')).toBe(true);
    expect(r.isRetired('a')).toBe(false);
    expect(r.profileDir('c')).toBe(`${H}/.claude-c`);
    expect(r.projectsRoots()).toEqual([{ id: 'a', dir: `${H}/.claude/projects` }, { id: 'b', dir: `${H}/.claude-b/projects` }, { id: 'c', dir: `${H}/.claude-c/projects` }]);
  });

  it('has() only accepts configured ids', () => {
    const r = testRegistry(H);
    expect(r.has('a')).toBe(true);
    for (const x of ['d', 'gpt', 'g1', '', 'A', null, undefined, 1, {}, 'toString', '__proto__', 'constructor']) expect(r.has(x)).toBe(false);
  });

  it('an unknown id has a label and a card id, but never a profile dir or an env', () => {
    const r = testRegistry(H);
    expect(r.label('zz')).toBe('ZZ');
    expect(r.cardId('zz')).toBe('claude:zz');
    expect(r.isRetired('zz')).toBe(false);
    expect(r.isHome('zz')).toBe(false);
    expect(() => r.profileDir('zz')).toThrow(/zz/);
    expect(() => r.projectsDir('zz')).toThrow(/zz/);
    expect(() => r.env('zz', {})).toThrow(/zz/);
    expect(() => r.env('toString', {})).toThrow();
  });

  it('fallback: the first active account that is neither protected nor home (the old hard-coded b); then any unprotected one', () => {
    const r = testRegistry(H);
    expect(r.fallback('a')).toBe('b');
    expect(r.fallback('c')).toBe('b');
    expect(r.fallback(null)).toBe('b');
    expect(r.fallback('b')).toBe('c');
    const two = buildRegistry({ version: 1, accounts: [{ id: 'a' }, { id: 'w' }] }, { homeDir: H });
    expect(two.fallback('w')).toBe('a');
    const one = buildRegistry({ version: 1, accounts: [{ id: 'a' }, { id: 'b', retired: true }] }, { homeDir: H });
    expect(one.fallback('a')).toBe('a');
    expect(one.fallback(null)).toBe('a');
  });

  it('rejects broken configs with a reason', () => {
    const bad = (accounts: { id: string; configDir?: string; card?: string; retired?: boolean }[], home?: string) => () => buildRegistry({ version: 1, ...(home ? { home } : {}), accounts }, { homeDir: H });
    expect(bad([{ id: 'a' }, { id: 'a' }])).toThrow(/중복.*a/);
    expect(bad([{ id: 'Bad' }])).toThrow(/Bad/);
    expect(bad([{ id: 'gpt' }])).toThrow(/gpt/);
    expect(bad([{ id: 'codex' }])).toThrow(/codex/);
    for (const id of ['auto', 'null', 'undefined', 'none']) expect(bad([{ id }])).toThrow(new RegExp(id));
    expect(bad([{ id: 'a' }], 'z')).toThrow(/home.*z/);
    expect(bad([{ id: 'a' }, { id: 'b', retired: true }], 'b')).toThrow(/home.*b/);
    expect(bad([])).toThrow(/계정/);
    expect(bad([{ id: 'a', retired: true }])).toThrow(/계정/);
    expect(bad([{ id: 'a' }, { id: 'b', configDir: '~/.claude' }])).toThrow(/\.claude/);
    expect(bad([{ id: 'a' }, { id: 'b', configDir: 'relative/dir' }])).toThrow(/relative\/dir/);
    expect(bad([{ id: 'a' }, { id: 'b', card: 'claude:main' }])).toThrow(/claude:main/);
  });

  it('the id pattern', () => {
    for (const ok of ['a', 'b', '1', 'work', 'x-1', 'a_b', '0123456789abcdef']) expect(ACCOUNT_ID_RE.test(ok)).toBe(true);
    for (const no of ['', 'A', '-a', '_a', 'a.b', 'a b', '0123456789abcdefg']) expect(ACCOUNT_ID_RE.test(no)).toBe(false);
  });

  it('LEGACY_ACCOUNTS is the a/b/c name set', () => {
    expect(LEGACY_ACCOUNTS.list()).toEqual(['a', 'b', 'c']);
    expect(LEGACY_ACCOUNTS.home).toBe('a');
    expect(LEGACY_ACCOUNTS.label('b')).toBe('B');
  });
});
