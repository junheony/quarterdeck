import { describe, expect, it } from 'vitest';
import { codexEnv } from './accounts';
import { testRegistry } from './accounts.testkit';

const reg = testRegistry('/Users/x');
const accountEnv = (account: string, base: NodeJS.ProcessEnv) => reg.env(account, base);

describe('accounts', () => {
  it('maps accounts to usage-deck card ids', () => {
    expect(reg.list()).toEqual(['a', 'b', 'c']);
    expect(Object.fromEntries(reg.list().map((a) => [a, reg.cardId(a)]))).toEqual({ a: 'claude:main', b: 'claude:second', c: 'claude:third' });
  });

  it('profile dirs follow the ~/.claude, ~/.claude-b, ~/.claude-c rule', () => {
    expect(reg.profileDir('a')).toBe('/Users/x/.claude');
    expect(reg.profileDir('b')).toBe('/Users/x/.claude-b');
    expect(reg.profileDir('c')).toBe('/Users/x/.claude-c');
    expect(reg.projectsDir('c')).toBe('/Users/x/.claude-c/projects');
  });

  it('strips every token variable and sets CLAUDE_CONFIG_DIR for b/c only', () => {
    const base = {
      PATH: '/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      ANTHROPIC_API_KEY: 'key',
      ANTHROPIC_AUTH_TOKEN: 'auth',
      CLAUDE_CONFIG_DIR: '/somewhere/else',
    };
    const a = accountEnv('a', base);
    expect(a.PATH).toBe('/bin');
    expect('CLAUDE_CONFIG_DIR' in a).toBe(false);
    expect('CLAUDE_CODE_OAUTH_TOKEN' in a).toBe(false);
    expect('ANTHROPIC_API_KEY' in a).toBe(false);
    expect('ANTHROPIC_AUTH_TOKEN' in a).toBe(false);

    const b = accountEnv('b', base);
    expect(b.CLAUDE_CONFIG_DIR).toBe('/Users/x/.claude-b');
    expect('ANTHROPIC_API_KEY' in b).toBe(false);
    expect(accountEnv('c', base).CLAUDE_CONFIG_DIR).toBe('/Users/x/.claude-c');
  });

  it('also strips variables that reroute or relabel the child (base URL, Bedrock, Vertex, entrypoint)', () => {
    const base = { PATH: '/bin', ANTHROPIC_BASE_URL: 'http://proxy', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' };
    for (const acct of ['a', 'b'] as const) {
      const env = accountEnv(acct, base);
      expect(env.PATH).toBe('/bin');
      for (const k of ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_ENTRYPOINT']) expect(k in env).toBe(false);
    }
  });

  it('does not mutate the base env', () => {
    const base = { ANTHROPIC_API_KEY: 'key' };
    accountEnv('a', base);
    expect(base.ANTHROPIC_API_KEY).toBe('key');
  });

  it('codexEnv strips OpenAI and Anthropic token/routing variables and keeps CODEX_HOME', () => {
    const env = codexEnv({ PATH: '/bin', OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'u', ANTHROPIC_API_KEY: 'a', CLAUDE_CODE_OAUTH_TOKEN: 't', CODEX_HOME: '/h/.codex' });
    expect(env).toEqual({ PATH: '/bin', CODEX_HOME: '/h/.codex' });
  });

  it('account labels', () => {
    expect(reg.list().map((a) => reg.label(a))).toEqual(['A', 'B', 'C']);
  });
});
