import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../shared/protocol';
import { initialState, reducer, type AppState, type ChatItem } from './state';

function play(msgs: ServerMessage[], start: AppState): AppState {
  return msgs.reduce((s, msg) => reducer(s, { type: 'server', msg }), start);
}

const scope = { sessionId: 's1', cwd: '/w' };
const assistants = (s: AppState) => s.panes[0]!.items.filter((it): it is Extract<ChatItem, { kind: 'assistant' }> => it.kind === 'assistant');
const started = (turnId: string, reason = 'r'): ServerMessage => ({ type: 'turn_started', turnId, ...scope, account: 'b', model: 'opus', reason, attempt: 0, engine: 'claude' });

describe('reducer: background work (turn_background, 백그라운드 계속)', () => {
  it('keeps the pill on the pane after the result, streams the continuation as its own item, then clears', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
    s = play([
      started('t1'),
      { type: 'delta', turnId: 't1', ...scope, text: 'launched' },
      { type: 'turn_result', turnId: 't1', ...scope, ok: true, text: 'launched', badge: null, errorText: null },
      { type: 'turn_background', turnId: 't1', ...scope, tasks: ['explore repo', 'review'], detail: [{ id: 'k1', description: 'explore repo', type: 'local_agent', ageMs: 1000 }, { id: 'k2', description: 'review', type: 'local_bash', ageMs: 0 }], canStop: true },
    ], s);
    expect(s.panes[0]!.bg).toMatchObject({ turnId: 't1', tasks: ['explore repo', 'review'], canStop: true, detail: [{ id: 'k1' }, { id: 'k2' }] });
    expect(s.panes[0]!.activeTurnId).toBeNull();
    expect(s.panes[0]!.runStartedAt).toBeNull();

    s = play([
      { type: 'turn_background', turnId: 't1', ...scope, tasks: [] },
      started('t1:bg1', '백그라운드 계속'),
      { type: 'turn_notice', turnId: 't1:bg1', ...scope, message: '백그라운드 계속 — 백그라운드 작업이 끝나 이어서 진행합니다' },
      { type: 'delta', turnId: 't1:bg1', ...scope, text: 'found' },
    ], s);
    const items = assistants(s);
    expect(items).toHaveLength(2);
    expect(s.panes[0]!.bg).toBeNull();
    expect(items[1]).toMatchObject({ turnId: 't1:bg1', text: 'found', streaming: true, notes: [expect.stringContaining('백그라운드 계속')] });
    expect(s.panes[0]!.activeTurnId).toBe('t1:bg1');
    expect(s.panes[0]!.runStartedAt).toBeTypeOf('number');
  });

  it('after a reload the pill comes back from the replayed turn_background', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
    s = play([{ type: 'history', sessionId: 's1', cwd: '/w', account: 'b', runningTurnId: null, messages: [
      { kind: 'user', text: 'go', ts: null },
      { kind: 'assistant', text: 'launched', model: null, toolCalls: [], ts: null },
    ] }], s);
    s = play([{ type: 'turn_background', turnId: 't9', ...scope, tasks: ['build'] }], s);
    expect(s.panes[0]!.bg).toMatchObject({ turnId: 't9', tasks: ['build'], detail: [], canStop: false });
  });

  it('an activity snapshot without background work for the session clears a lingering pill (missed empty turn_background)', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
    s = play([{ type: 'turn_background', turnId: 't1', ...scope, tasks: ['sleep 20'] }], s);
    s = play([{ type: 'activity', sessions: [{ sessionId: 's1', cwd: '/w', turnId: 't1', running: false, bg: 1, forMs: 0 }] }], s);
    expect(s.panes[0]!.bg).not.toBeNull();
    s = play([{ type: 'activity', sessions: [] }], s);
    expect(s.panes[0]!.bg).toBeNull();
  });
});

describe('reducer: live activity (status row, agent cards, sidebar)', () => {
  it('progress, subagent updates and calls land on the pane by the Agent call id', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
    s = play([
      started('t1'),
      { type: 'turn_progress', turnId: 't1', ...scope, outputTokens: 120, phase: 'thinking' },
      { type: 'tool_call', turnId: 't1', ...scope, toolUseId: 'ag', name: 'Agent', input: { description: 'count files' } },
      { type: 'task_update', turnId: 't1', ...scope, taskId: 'a1', toolUseId: 'ag', status: 'running', description: 'count files', subagentType: 'general-purpose' },
      { type: 'task_update', turnId: 't1', ...scope, taskId: 'a1', toolUseId: null, usage: { totalTokens: 300, toolUses: 1, durationMs: 1000 } },
      { type: 'sub_tool_call', turnId: 't1', ...scope, parentToolUseId: 'ag', toolUseId: 'x1', name: 'Bash', input: { command: 'ls' } },
      { type: 'sub_tool_result', turnId: 't1', ...scope, parentToolUseId: 'ag', toolUseId: 'x1', isError: false },
      { type: 'task_done', turnId: 't1', ...scope, status: 'completed', summary: '42', taskId: 'a1', toolUseId: 'ag', usage: { totalTokens: 900, toolUses: 1, durationMs: 4000 } },
    ], s);
    const p = s.panes[0]!;
    expect(p.progress).toEqual({ outputTokens: 120, phase: 'thinking' });
    expect(p.agents.ag).toMatchObject({ taskId: 'a1', status: 'completed', subagentType: 'general-purpose', usage: { durationMs: 4000 }, calls: [{ toolUseId: 'x1', name: 'Bash', done: true, isError: false }] });
    // No subagent message enters the transcript.
    expect(assistants(s)[0]!.toolCalls.map((c) => c.toolUseId)).toEqual(['ag']);
    s = play([{ type: 'turn_result', turnId: 't1', ...scope, ok: true, text: 'done', badge: null, errorText: null }], s);
    expect(s.panes[0]!.runStartedAt).toBeNull();
    expect(s.panes[0]!.progress).toBeNull();
  });

  it('a late device backdates the agent timer by ageMs', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
    const before = Date.now();
    s = play([{ type: 'task_update', turnId: 't1', ...scope, taskId: 'a1', toolUseId: 'ag', status: 'running', ageMs: 60_000 }], s);
    expect(s.panes[0]!.agents.ag!.startedAt).toBeLessThanOrEqual(before - 59_000);
  });

  it('a session that stops running while not shown in the focused pane gets an unread dot until opened', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
    s = play([{ type: 'activity', sessions: [
      { sessionId: 's1', cwd: '/w', turnId: 't1', running: true, bg: 0, forMs: 0 },
      { sessionId: 's2', cwd: '/w', turnId: 't2', running: true, bg: 0, forMs: 0 },
    ] }], s);
    expect(s.activity).toHaveLength(2);
    s = play([{ type: 'activity', sessions: [] }], s);
    expect(s.unread).toEqual(['s2']);
    s = reducer(s, { type: 'open', sessionId: 's2', cwd: '/w', title: 'two' });
    expect(s.unread).toEqual([]);
  });
});
