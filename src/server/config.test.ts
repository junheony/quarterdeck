import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, readDeckUrl, readProtect } from './config';
import { testRegistry } from '../shared/accounts.testkit';

describe('config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cfg-'));

  it('readProtect skips comments/blank lines and validates', () => {
    const f = path.join(dir, 'protect');
    fs.writeFileSync(f, '# Desktop account\n\na\n');
    expect(readProtect(f, testRegistry())).toBe('a');
    fs.writeFileSync(f, 'z\n');
    const warned: string[] = [];
    expect(readProtect(f, testRegistry(), (l) => warned.push(l))).toBeNull();
    // An id that is not a configured account protects nothing — said once, with the file and the known accounts.
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('"z"');
    expect(warned[0]).toContain(f);
    expect(readProtect(path.join(dir, 'missing'), testRegistry(), (l) => warned.push(l))).toBeNull();
    expect(warned).toHaveLength(1);
  });

  it('readDeckUrl trims and falls back', () => {
    const f = path.join(dir, 'deck_url');
    fs.writeFileSync(f, 'http://100.64.0.2:9310  \n');
    expect(readDeckUrl(f)).toBe('http://100.64.0.2:9310');
    expect(readDeckUrl(path.join(dir, 'nope'))).toBe('http://127.0.0.1:9310');
  });

  it('DECK_USAGE_STRICT: 1 → strict, 0 → lax, anything else → decided by <configDir>/usage-source.json', () => {
    const home = path.join(dir, 'home-usage');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const of = (v?: string) => loadConfig({ DECK_CONFIG_DIR: '/cfg', ...(v === undefined ? {} : { DECK_USAGE_STRICT: v }) }, home, '/repo');
    expect(of()).toMatchObject({ usageStrict: null, usageSourceFile: '/cfg/usage-source.json' });
    expect(of('1').usageStrict).toBe(true);
    expect(of('0').usageStrict).toBe(false);
    expect(of('').usageStrict).toBeNull();
    expect(of('yes').usageStrict).toBeNull();
  });

  it('deckUrlConfigured: true only when the address was set (DECK_URL or the claude-pick file), not for the default', () => {
    const home = path.join(dir, 'home-deck-url');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const of = (env: NodeJS.ProcessEnv = {}) => loadConfig({ DECK_CONFIG_DIR: '/cfg', ...env }, home, '/repo');
    expect(of()).toMatchObject({ deckUrl: 'http://127.0.0.1:9310', deckUrlConfigured: false });
    expect(of({ DECK_URL: '' })).toMatchObject({ deckUrl: 'http://127.0.0.1:9310', deckUrlConfigured: false });
    expect(of({ DECK_URL: 'http://deck:9310' })).toMatchObject({ deckUrl: 'http://deck:9310', deckUrlConfigured: true });
    fs.mkdirSync(path.join(home, '.config', 'claude-pick'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'claude-pick', 'deck_url'), '\n');
    expect(of()).toMatchObject({ deckUrl: 'http://127.0.0.1:9310', deckUrlConfigured: false });
    fs.writeFileSync(path.join(home, '.config', 'claude-pick', 'deck_url'), 'http://100.64.0.1:9310\n');
    expect(of()).toMatchObject({ deckUrl: 'http://100.64.0.1:9310', deckUrlConfigured: true });
    expect(of({ DECK_URL: 'http://deck:9310' })).toMatchObject({ deckUrl: 'http://deck:9310', deckUrlConfigured: true });
  });

  it('loadConfig derives paths from HOME and honours env overrides', () => {
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.config', 'claude-pick'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'offload'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'claude-pick', 'deck_url'), 'http://deck:9310\n');
    fs.writeFileSync(path.join(home, '.config', 'offload', 'protect'), '# c\na\n');
    for (const p of ['.claude', '.claude-b', '.claude-c']) fs.mkdirSync(path.join(home, p, 'projects'), { recursive: true });
    const c = loadConfig({}, home, '/repo');
    expect(c).toMatchObject({
      configDir: path.join(home, '.config/deck'),
      tokenFile: path.join(home, '.config/deck/token'),
      pinnedFile: path.join(home, '.config/deck/projects.json'),
      stateFile: path.join(home, '.config/deck/session-state.json'),
      auditFile: path.join(home, '.config/deck/audit.log'),
      deckUrl: 'http://deck:9310',
      protectedAccount: 'a',
      cooldownDir: path.join(home, '.cache/offload/cooldown'),
      port: 9320,
      loopbackOnly: false,
      devOrigins: [],
      uiDir: '/repo/dist/ui',
    });
    expect(c.accounts.list()).toEqual(['a', 'b', 'c']);
    expect(c.projectsRoots).toEqual([{ id: 'a', dir: path.join(home, '.claude/projects') }, { id: 'b', dir: path.join(home, '.claude-b/projects') }, { id: 'c', dir: path.join(home, '.claude-c/projects') }]);
    const o = loadConfig({ DECK_CONFIG_DIR: '/cfg', DECK_PORT: '9999', DECK_URL: 'http://x', CLAUDE_PROTECT: 'b', DECK_LOOPBACK_ONLY: '1', DECK_DEV_ORIGIN: 'http://localhost:5173,http://127.0.0.1:5173', DECK_UI_DIR: '/ui' }, home, '/repo');
    expect(o).toMatchObject({ configDir: '/cfg', tokenFile: '/cfg/token', port: 9999, deckUrl: 'http://x', protectedAccount: 'b', loopbackOnly: true, devOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'], uiDir: '/ui' });
  });

  it('a protected account that is not configured is ignored with one warning (env and file)', () => {
    const home = path.join(dir, 'home2');
    fs.mkdirSync(path.join(home, '.config', 'offload'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude-b', 'projects'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'offload', 'protect'), 'c\n');
    const logs: string[] = [];
    expect(loadConfig({}, home, '/repo', (l) => logs.push(l)).protectedAccount).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/보호 계정 "c".*설정에 없는/);
    logs.length = 0;
    fs.writeFileSync(path.join(home, '.config', 'offload', 'protect'), 'b\n');
    expect(loadConfig({ CLAUDE_PROTECT: 'zz' }, home, '/repo', (l) => logs.push(l)).protectedAccount).toBe('b');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('CLAUDE_PROTECT="zz"');
    logs.length = 0;
    expect(loadConfig({ CLAUDE_PROTECT: 'b' }, home, '/repo', (l) => logs.push(l)).protectedAccount).toBe('b');
    expect(logs).toEqual([]);
  });

  it('a broken accounts.json stops loadConfig (the server does not start on discovered accounts)', () => {
    const home = path.join(dir, 'home3');
    fs.mkdirSync(path.join(home, '.config', 'deck'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'deck', 'accounts.json'), '{');
    expect(() => loadConfig({}, home, '/repo', () => {})).toThrow(/accounts\.json 을 쓸 수 없어 시작하지 않습니다/);
  });

  it('codex bin, sessions root and attachments dir (D11)', () => {
    const cfg = loadConfig({ PATH: '/nonexistent', CODEX_HOME: '/h/.codex-alt' }, '/h', '/repo');
    expect(cfg.codexBin).toBeNull();
    expect(cfg.geminiBin).toBeNull();
    expect(cfg.codexSessionsRoot).toBe('/h/.codex-alt/sessions');
    expect(cfg.codexArchivedRoot).toBe('/h/.codex-alt/archived_sessions');
    expect(cfg.attachmentsDir).toBe('/h/.config/deck/attachments');
    expect(cfg.backupRetentionDays).toBe(30);
    expect(loadConfig({ PATH: '/nonexistent', DECK_BACKUP_RETENTION_DAYS: '7' }, '/h', '/repo').backupRetentionDays).toBe(7);
    expect(loadConfig({ PATH: '/nonexistent', DECK_BACKUP_RETENTION_DAYS: '-1' }, '/h', '/repo').backupRetentionDays).toBe(30);
    expect(loadConfig({ PATH: '/nonexistent' }, '/h', '/repo').codexSessionsRoot).toBe('/h/.codex/sessions');
  });

  it('recent folders file and new-session cwd roots (F1)', () => {
    const cfg = loadConfig({ PATH: '/nonexistent' }, '/h', '/repo');
    expect(cfg.recentFoldersFile).toBe('/h/.config/deck/recent-folders.json');
    expect(cfg.pinsFile).toBe('/h/.config/deck/pins.json');
    expect(cfg.cwdRoots).toEqual(['/h']);
    expect(loadConfig({ PATH: '/nonexistent', DECK_LOOPBACK_ONLY: '1', DECK_EXTRA_CWD_ROOTS: '/tmp/x, /private/var/y' }, '/h', '/repo').cwdRoots).toEqual(['/h', '/tmp/x', '/private/var/y']);
  });

  it('DECK_EXTRA_CWD_ROOTS only counts with DECK_LOOPBACK_ONLY=1, and never / (review fix 2)', () => {
    expect(loadConfig({ PATH: '/nonexistent', DECK_EXTRA_CWD_ROOTS: '/tmp/x' }, '/h', '/repo').cwdRoots).toEqual(['/h']);
    expect(loadConfig({ PATH: '/nonexistent', DECK_LOOPBACK_ONLY: '1', DECK_EXTRA_CWD_ROOTS: '/, //, /./, /tmp/x, rel' }, '/h', '/repo').cwdRoots).toEqual(['/h', '/tmp/x']);
  });
});
