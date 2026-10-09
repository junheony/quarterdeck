import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../shared/protocol';
import { RECENT_SESSIONS_MAX, initialState, reducer, type Action, type AppState } from './state';

const pane = (s: AppState, i = 0) => s.panes[i]!;
const run = (s: AppState, ...as: Action[]) => as.reduce(reducer, s);
const server = (msg: ServerMessage): Action => ({ type: 'server', msg });
const open = (sessionId: string | null, paneId?: string): Action => ({ type: 'open', sessionId, cwd: '/w', title: 't', ...(paneId ? { paneId } : {}) });
const history = (sessionId: string, texts: string[], runningTurnId: string | null = null): Action => server({
  type: 'history', sessionId, cwd: '/w', account: 'a', runningTurnId,
  messages: texts.flatMap((t, n) => [{ kind: 'user' as const, text: t, ts: null, n }, { kind: 'assistant' as const, text: `re ${t}`, model: null, toolCalls: [], ts: null }]),
});

describe('recent sessions cache', () => {
  it('a session viewed before opens on its cached items (no skeleton), loading until its history replaces them without duplication', () => {
    let s = run(initialState, open('s1'), history('s1', ['q0', 'q1']), open('s2'));
    expect(pane(s).items).toEqual([]);
    expect(pane(s).loading).toBe(true);
    s = run(s, history('s2', ['x']), open('s1'));
    expect(pane(s).items.map((it) => it.kind === 'user' || it.kind === 'assistant' ? it.text : '')).toEqual(['q0', 're q0', 'q1', 're q1']);
    expect(pane(s).loading).toBe(true);
    s = run(s, history('s1', ['q0', 'q1', 'q2']));
    expect(pane(s).items).toHaveLength(6);
    expect(pane(s).loading).toBe(false);
  });

  it('the live part is not cached: a streaming item and a send still waiting for its turn are dropped; turn ids are cleared', () => {
    let s = run(initialState, open('s1'), history('s1', ['q0'], 't1'));
    expect(pane(s).items.at(-1)).toMatchObject({ streaming: true });
    s = run(s, { type: 'sent', text: 'pending', clientRef: 'r1' }, open('s2'), open('s1'));
    expect(pane(s).items).toHaveLength(2);
    expect(pane(s).items.some((it) => it.kind === 'assistant' && (it.streaming || it.turnId !== null))).toBe(false);
  });

  it('turn events before the history land on the cached items as on an empty pane; the history then replaces everything', () => {
    let s = run(initialState, open('s1'), history('s1', ['q0']), open('s2'), open('s1'));
    s = run(s, server({ type: 'turn_started', turnId: 't9', sessionId: 's1', cwd: '/w', account: 'a', model: 'opus', reason: 'r', attempt: 0 }));
    expect(pane(s).items).toHaveLength(3);
    expect(pane(s).items.at(-1)).toMatchObject({ turnId: 't9', streaming: true });
    s = run(s, history('s1', ['q0', 'q1'], 't9'));
    expect(pane(s).items.filter((it) => it.kind === 'assistant' && it.streaming)).toHaveLength(1);
  });

  it('clear_pane and close_pane keep the items; a new session (no id) is never cached', () => {
    let s = run(initialState, open('s1'), history('s1', ['q0']), { type: 'clear_pane' }, open('s1'));
    expect(pane(s).items).toHaveLength(2);
    s = run(initialState, { type: 'add_pane' }, open('s3', 'p1'), history('s3', ['z']), { type: 'close_pane', paneId: 'p1' }, open('s3'));
    expect(pane(s).items).toHaveLength(2);
    s = run(initialState, open(null), { type: 'sent', text: 'hi' }, open('s4'));
    expect(Object.keys(s.recent)).toEqual([]);
  });

  it('keeps the newest RECENT_SESSIONS_MAX sessions (a revisit counts as newest) and is memory only', () => {
    let s = initialState;
    for (let i = 0; i <= RECENT_SESSIONS_MAX + 1; i++) s = run(s, open(`s${i}`), history(`s${i}`, [`q${i}`]));
    s = run(s, open('s2'), open('other'));
    const keys = Object.keys(s.recent);
    expect(keys).toHaveLength(RECENT_SESSIONS_MAX);
    expect(keys).not.toContain('s0');
    expect(keys.at(-1)).toBe('s2');
    expect(initialState.recent).toEqual({});
  });
});
