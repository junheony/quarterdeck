import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountsFileError, discoverProfileNames, loadAccountRegistry } from './accounts';

describe('account registry loader', () => {
  let home: string;
  let configDir: string;
  let logs: string[];
  const load = () => loadAccountRegistry({ configDir, homeDir: home, log: (l) => logs.push(l) });
  const profile = (name: string, marker: 'projects' | '.claude.json' | null = 'projects') => {
    fs.mkdirSync(path.join(home, name), { recursive: true });
    if (marker === 'projects') fs.mkdirSync(path.join(home, name, 'projects'));
    if (marker === '.claude.json') fs.writeFileSync(path.join(home, name, '.claude.json'), '{}');
  };
  const writeConfig = (text: string) => fs.writeFileSync(path.join(configDir, 'accounts.json'), text);

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-acct-'));
    configDir = path.join(home, '.config', 'deck');
    fs.mkdirSync(configDir, { recursive: true });
    logs = [];
  });

  it('no accounts.json: discovers ~/.claude, ~/.claude-b, ~/.claude-c exactly like the old constants', () => {
    profile('.claude', null);
    profile('.claude-c');
    profile('.claude-b', '.claude.json');
    // Not accounts: plain files (logs, ~/.claude.json and its backup) and names that are not ids.
    for (const f of ['.claude-creds-sync.log', '.claude-creds-sync.stderr', '.claude.json', '.claude.json.backup', '.claude-d']) fs.writeFileSync(path.join(home, f), '');
    const r = load();
    expect(r.list()).toEqual(['a', 'b', 'c']);
    expect(r.home).toBe('a');
    expect(r.projectsRoots()).toEqual([{ id: 'a', dir: path.join(home, '.claude/projects') }, { id: 'b', dir: path.join(home, '.claude-b/projects') }, { id: 'c', dir: path.join(home, '.claude-c/projects') }]);
    expect(r.list().map((a) => r.cardId(a))).toEqual(['claude:main', 'claude:second', 'claude:third']);
    expect('CLAUDE_CONFIG_DIR' in r.env('a', { CLAUDE_CONFIG_DIR: '/x' })).toBe(false);
    expect(r.env('b', {}).CLAUDE_CONFIG_DIR).toBe(path.join(home, '.claude-b'));
    expect(logs).toEqual([]);
  });

  it('a ~/.claude-<x> directory without a profile marker (projects/ or .claude.json) is not an account', () => {
    profile('.claude', null);
    profile('.claude-b');
    profile('.claude-backup', null);
    profile('.claude-mem', null);
    profile('.claude-d', null);
    expect(discoverProfileNames(home)).toEqual(['.claude', '.claude-b']);
    expect(load().list()).toEqual(['a', 'b']);
    expect(logs).toEqual([]);
  });

  it('a symlinked profile directory counts', () => {
    profile('.claude', null);
    profile('elsewhere');
    fs.symlinkSync(path.join(home, 'elsewhere'), path.join(home, '.claude-w'));
    expect(load().list()).toEqual(['a', 'w']);
  });

  it('backup-looking profile directories are not accounts: one log line each, with the accounts.json entry', () => {
    profile('.claude', null);
    profile('.claude-b');
    for (const n of ['.claude-backup', '.claude-2', '.claude-old', '.claude-main']) profile(n);
    const r = load();
    expect(r.list()).toEqual(['a', 'b']);
    expect(logs).toHaveLength(4);
    expect(logs.find((l) => l.includes('.claude-old'))).toContain('{"id":"old","configDir":"~/.claude-old"}');
    for (const l of logs) expect(l).toContain('accounts.json');
  });

  it('discovery never throws: a one-letter profile that is an alias of another (symlink) is skipped with a log', () => {
    profile('.claude', null);
    profile('.claude-b');
    fs.symlinkSync(path.join(home, '.claude-b'), path.join(home, '.claude-d'));
    fs.symlinkSync(path.join(home, '.claude'), path.join(home, '.claude-e'));
    fs.mkdirSync(path.join(home, '.claude', 'projects'));
    const r = load();
    expect(r.list()).toEqual(['a', 'b']);
    expect(logs).toHaveLength(2);
    expect(logs.join('\n')).toMatch(/계정 d .*건너/);
    expect(logs.join('\n')).toMatch(/계정 e .*건너/);
  });

  it('~/.claude-B (upper case) is account b with its real directory name', () => {
    profile('.claude', null);
    profile('.claude-B');
    const r = load();
    expect(r.list()).toEqual(['a', 'b']);
    expect(r.profileDir('b')).toBe(path.join(home, '.claude-B'));
    expect(r.env('b', {}).CLAUDE_CONFIG_DIR).toBe(path.join(home, '.claude-B'));
    expect(logs).toEqual([]);
  });

  it('an empty or unreadable home still yields account a', () => {
    expect(load().list()).toEqual(['a']);
    const r = loadAccountRegistry({ configDir, homeDir: path.join(home, 'missing'), log: (l) => logs.push(l) });
    expect(r.list()).toEqual(['a']);
    expect(r.home).toBe('a');
  });

  it('accounts.json wins over discovery', () => {
    profile('.claude', null);
    profile('.claude-b');
    writeConfig(JSON.stringify({ version: 1, home: 'w', futureField: true, accounts: [
      { id: 'w', label: 'Work', configDir: '~/.claude-work', card: 'claude:work1', extra: 1 },
      { id: 'a' },
      { id: 'c', retired: true },
    ] }));
    const r = load();
    expect(r.list()).toEqual(['w', 'a']);
    expect(r.all()).toEqual(['w', 'a', 'c']);
    expect(r.home).toBe('w');
    expect(r.label('w')).toBe('Work');
    expect(r.profileDir('w')).toBe(path.join(home, '.claude-work'));
    expect(r.cardId('w')).toBe('claude:work1');
    expect(logs).toEqual([]);
  });

  it.each([
    ['broken JSON', '{ "version": 1, '],
    ['not an object', '[]'],
    ['unknown version', JSON.stringify({ version: 2, accounts: [{ id: 'a' }] })],
    ['bad id', JSON.stringify({ version: 1, accounts: [{ id: 'A' }] })],
    ['duplicate id', JSON.stringify({ version: 1, accounts: [{ id: 'a' }, { id: 'a' }] })],
    ['duplicate card', JSON.stringify({ version: 1, accounts: [{ id: 'a' }, { id: 'main', card: 'claude:main' }] })],
    ['missing home', JSON.stringify({ version: 1, home: 'z', accounts: [{ id: 'a' }] })],
    ['wrong field type', JSON.stringify({ version: 1, accounts: [{ id: 'a', retired: 'yes' }] })],
    ['no active account', JSON.stringify({ version: 1, accounts: [{ id: 'a', retired: true }] })],
    ['same dir by ..', JSON.stringify({ version: 1, accounts: [{ id: 'a' }, { id: 'w', configDir: '~/x/../.claude' }] })],
  ])('%s: refuses to start with the file path and the reason — never falls back to discovery', (_name, text) => {
    profile('.claude', null);
    profile('.claude-b');
    writeConfig(text);
    let err: unknown;
    try { load(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AccountsFileError);
    expect((err as Error).message).toContain(path.join(configDir, 'accounts.json'));
    expect((err as Error).message).toMatch(/시작하지 않습니다 — .+/);
    expect(logs).toEqual([]);
  });

  it('an accounts.json that cannot be read (a directory, EACCES) refuses to start too', () => {
    profile('.claude', null);
    fs.mkdirSync(path.join(configDir, 'accounts.json'));
    expect(load).toThrow(AccountsFileError);
    expect(load).toThrow(/EISDIR/);
  });

  it('two entries naming the same directory through a symlink refuse to start', () => {
    profile('.claude', null);
    profile('.claude-b');
    fs.symlinkSync(path.join(home, '.claude-b'), path.join(home, 'alias'));
    writeConfig(JSON.stringify({ version: 1, accounts: [{ id: 'a' }, { id: 'b' }, { id: 'w', configDir: '~/alias' }] }));
    expect(load).toThrow(/configDir/);
  });
});
