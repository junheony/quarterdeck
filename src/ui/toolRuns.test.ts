import { describe, expect, it } from 'vitest';
import { mergeToolRuns } from './toolRuns';
import type { ChatItem } from './state';

const a = (text: string, tools: string[] = [], extra: Partial<Extract<ChatItem, { kind: 'assistant' }>> = {}): ChatItem => ({
  kind: 'assistant', turnId: null, text, toolCalls: tools.map((id) => ({ toolUseId: id, name: 'Bash', input: {}, result: 'ok', isError: false })), badge: null, streaming: false, error: null, notes: [], attempts: [], ...extra,
});

describe('mergeToolRuns', () => {
  it('folds consecutive tool-only items into the next assistant item, keeping order', () => {
    const out = mergeToolRuns([{ kind: 'user', text: 'go' }, a('', ['1']), a('', ['2']), a('done', ['3']), a('', ['4']), { kind: 'user', text: 'next' }]);
    expect(out).toHaveLength(4);
    const merged = out[1] as Extract<ChatItem, { kind: 'assistant' }>;
    expect(merged.text).toBe('done');
    expect(merged.toolCalls.map((c) => c.toolUseId)).toEqual(['1', '2', '3']);
    expect((out[2] as Extract<ChatItem, { kind: 'assistant' }>).toolCalls.map((c) => c.toolUseId)).toEqual(['4']);
  });

  it('never folds across a user message or an item with an error, and keeps streaming', () => {
    const out = mergeToolRuns([a('', ['1'], { error: 'x' }), a('', ['2']), a('', [], { streaming: true })]);
    expect(out).toHaveLength(2);
    expect((out[1] as Extract<ChatItem, { kind: 'assistant' }>).streaming).toBe(true);
    expect(mergeToolRuns([a('', ['1']), { kind: 'user', text: 'u' }])).toHaveLength(2);
  });
});
