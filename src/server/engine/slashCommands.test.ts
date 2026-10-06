import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { noteCommands } from './ClaudeEngine';
import { DEFAULT_SLASH_COMMANDS, SlashCommandCache } from './slashCommands';

describe('SlashCommandCache', () => {
  it('defaults until a turn reports; then per session, per cwd, newest fallback', () => {
    const c = new SlashCommandCache();
    expect(c.get(null, null)).toEqual(DEFAULT_SLASH_COMMANDS);
    c.record('s1', '/w/a', ['compact', '/review', 'exit', 'compact'], ['exit']);
    c.record('s2', '/w/b', ['other']);
    expect(c.get('s1', null).map((x) => x.name)).toEqual(['compact', 'review']);
    expect(c.get(null, '/w/a').map((x) => x.name)).toEqual(['compact', 'review']);
    expect(c.get('unknown', '/w/unknown').map((x) => x.name)).toEqual(['other']);
  });

  it('commands_changed descriptions are kept for later plain-name lists', () => {
    const c = new SlashCommandCache();
    c.record('s1', '/w', [{ name: 'deploy', description: 'Ship it', argumentHint: '<env>' }]);
    c.record('s1', '/w', ['deploy', 'x']);
    expect(c.get('s1', null)).toEqual([{ name: 'deploy', description: 'Ship it', argumentHint: '<env>' }, { name: 'x', description: '', argumentHint: '' }]);
  });

  it('an empty list is ignored', () => {
    const c = new SlashCommandCache();
    c.record('s1', '/w', []);
    expect(c.get('s1', '/w')).toEqual(DEFAULT_SLASH_COMMANDS);
  });
});

describe('noteCommands (ClaudeEngine)', () => {
  it('reads system/init slash_commands minus terminal ones, and commands_changed', () => {
    const calls: unknown[][] = [];
    const on = (...a: unknown[]) => { calls.push(a); };
    noteCommands({ type: 'system', subtype: 'init', session_id: 's', cwd: '/real', slash_commands: ['a', 'b', 3], terminal_slash_commands: ['b'] } as unknown as SDKMessage, '/fallback', on);
    noteCommands({ type: 'system', subtype: 'commands_changed', session_id: 's', commands: [{ name: 'c', description: 'd', argumentHint: '' }, null] } as unknown as SDKMessage, '/fallback', on);
    noteCommands({ type: 'assistant' } as unknown as SDKMessage, '/fallback', on);
    expect(calls).toEqual([['s', '/real', ['a', 'b'], ['b']], ['s', '/fallback', [{ name: 'c', description: 'd', argumentHint: '' }], []]]);
  });
});
