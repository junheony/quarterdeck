import { describe, expect, it } from 'vitest';
import { HANDOFF_PROMPT } from '../shared/handoff';
import type { ServerMessage } from '../shared/protocol';
import { initialState, nextQueued, reducer, type AppState } from './state';

const pane = (s: AppState) => s.panes[0]!;
const usage = { generatedAt: 'x', deckReachable: true, accounts: {} } as unknown as Extract<ServerMessage, { type: 'hello' }>['usage'];
const hello: ServerMessage = { type: 'hello', usage, projects: [], running: [], codex: { available: false } };
const play = (msgs: ServerMessage[], s: AppState) => msgs.reduce((x, msg) => reducer(x, { type: 'server', msg }), s);
const opened = (sessionId: string | null): AppState => play([hello], reducer(initialState, { type: 'open', sessionId, cwd: '/w', title: 't' }));
const started = (turnId: string, clientRef?: string, sessionId: string | null = 's1'): ServerMessage => ({ type: 'turn_started', turnId, sessionId, cwd: '/w', account: 'b', model: 'fable', reason: '', attempt: 1, ...(clientRef ? { clientRef } : {}), prompt: { text: 'hi', attachments: [] } });

describe('cancel_start (시작하는 중… 취소)', () => {
  it('ends the wait, takes the bubble back and puts the text (and files) back into the composer', () => {
    let s = reducer(opened('s1'), { type: 'sent', text: 'hi', clientRef: 'r1', attachments: [{ id: 'f1', name: 'a.png', isImage: true }] });
    expect(pane(s).awaitingStart).toBe(true);
    s = reducer(s, { type: 'cancel_start', paneId: 'p0' });
    const p = pane(s);
    expect(p.awaitingStart).toBe(false);
    expect(p.awaitingRef).toBeNull();
    expect(p.awaitingSend).toBeNull();
    expect(p.items).toEqual([]);
    expect(p.prefill).toBe('hi');
    expect(p.attachments.map((a) => a.id)).toEqual(['f1']);
    expect(p.runStartedAt).toBeNull();
    expect(p.queue).toEqual([]);
  });

  it('a late turn_started for the cancelled ref attaches to the running turn as another device\'s would', () => {
    let s = reducer(opened('s1'), { type: 'sent', text: 'hi', clientRef: 'r1' });
    s = reducer(s, { type: 'cancel_start', paneId: 'p0' });
    s = play([started('t1', 'r1')], s);
    const p = pane(s);
    expect(p.awaitingStart).toBe(false);
    expect(p.myTurns).toEqual([]);
    expect(p.activeTurnId).toBe('t1');
    // The server's copy of the prompt, then the streaming answer.
    expect(p.items.map((it) => it.kind)).toEqual(['user', 'assistant']);
  });

  it('a handoff note is just cancelled (nothing to put back)', () => {
    let s = reducer(opened('s1'), { type: 'sent', text: HANDOFF_PROMPT, clientRef: 'h1', handoff: true });
    expect(pane(s).handoff).not.toBeNull();
    s = reducer(s, { type: 'cancel_start', paneId: 'p0' });
    expect(pane(s).awaitingStart).toBe(false);
    expect(pane(s).handoff).toBeNull();
    expect(pane(s).items).toEqual([]);
    expect(pane(s).prefill).toBeNull();
  });

  it('does nothing when the pane is not waiting', () => {
    const s = opened('s1');
    expect(reducer(s, { type: 'cancel_start', paneId: 'p0' })).toEqual(s);
  });
});

describe('send_failed (sent while disconnected)', () => {
  it('no bubble, no wait: one held queue item that the next hello sends', () => {
    let s = reducer(opened('s1'), { type: 'sent', text: 'hi', clientRef: 'r1' });
    s = reducer(s, { type: 'send_failed', clientRef: 'r1', paneId: 'p0' });
    let p = pane(s);
    expect(p.items).toEqual([]);
    expect(p.awaitingStart).toBe(false);
    expect(p.runStartedAt).toBeNull();
    expect(p.queue).toHaveLength(1);
    expect(p.queue[0]).toMatchObject({ text: 'hi', restart: 'hold', ref: 'r1' });
    expect(p.queue[0]!.maybeSent).toBeUndefined();
    expect(nextQueued(p)).toBeNull();
    // Reconnect: held → checked against the history → released.
    s = play([hello], reducer(s, { type: 'connected', value: false }));
    expect(pane(s).queue[0]!.restart).toBe('hello');
    s = play([{ type: 'history', sessionId: 's1', cwd: '/w', account: null, messages: [], runningTurnId: null, acceptedRefs: [] } as ServerMessage], s);
    p = pane(s);
    expect(p.queue[0]!.restart).toBe('go');
    expect(nextQueued(p)?.text).toBe('hi');
  });

  it('a new session: released by the hello itself', () => {
    let s = reducer(opened(null), { type: 'sent', text: 'first', clientRef: 'r1' });
    s = reducer(s, { type: 'send_failed', clientRef: 'r1', paneId: 'p0' });
    expect(pane(s).queue[0]!.restart).toBe('hold');
    s = play([hello], s);
    expect(nextQueued(pane(s))?.text).toBe('first');
  });

  it('a handoff note that never left: the pane stays where it was, with a notice', () => {
    let s = reducer(opened('s1'), { type: 'sent', text: HANDOFF_PROMPT, clientRef: 'h1', handoff: true });
    s = reducer(s, { type: 'send_failed', clientRef: 'h1', paneId: 'p0' });
    const p = pane(s);
    expect(p.awaitingStart).toBe(false);
    expect(p.handoff).toBeNull();
    expect(p.items).toEqual([]);
    expect(p.queue).toEqual([]);
    expect(p.notices?.map((n) => n.message)).toEqual(['연결이 끊겨 보내지 못했습니다 — 다시 연결된 뒤 시도하세요']);
  });

  it('ignores a stale ref', () => {
    const s = reducer(opened('s1'), { type: 'sent', text: 'hi', clientRef: 'r2' });
    expect(reducer(s, { type: 'send_failed', clientRef: 'r1', paneId: 'p0' })).toEqual(s);
  });
});

describe('7b: a new session learns its id before turn_result', () => {
  const SID = '22222222-2222-4222-8222-222222222222';
  const act = (sessionId: string, turnId: string): ServerMessage => ({ type: 'activity', sessions: [{ sessionId, cwd: '/w', turnId, running: true, bg: 0, forMs: 10 }] });

  it('activity naming this pane\'s own running turn gives the pane the session id', () => {
    let s = reducer(opened(null), { type: 'sent', text: 'hi', clientRef: 'r1' });
    s = play([started('t1', 'r1', null)], s);
    expect(pane(s).session?.sessionId).toBeNull();
    s = play([act(SID, 't1')], s);
    expect(pane(s).session?.sessionId).toBe(SID);
    expect(pane(s).activeTurnId).toBe('t1');
    // A retry on another account that produced a different id is followed too.
    s = play([act('33333333-3333-4333-8333-333333333333', 't1')], s);
    expect(pane(s).session?.sessionId).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('activity for a turn that is not this pane\'s own leaves the pane alone', () => {
    let s = reducer(opened(null), { type: 'sent', text: 'hi', clientRef: 'r1' });
    s = play([started('t1', 'r1', null), act(SID, 't-other')], s);
    expect(pane(s).session?.sessionId).toBeNull();
  });

  it('hello.running naming the pane\'s turn with an id (reload mid first turn) adopts it and marks the pane loading', () => {
    let s = reducer(opened(null), { type: 'sent', text: 'hi', clientRef: 'r1' });
    s = play([started('t1', 'r1', null)], s);
    s = play([{ ...hello, running: [{ turnId: 't1', sessionId: SID, cwd: '/w' }] }], s);
    expect(pane(s).session).toMatchObject({ sessionId: SID, cwd: '/w' });
    expect(pane(s).activeTurnId).toBe('t1');
    expect(pane(s).loading).toBe(true);
  });

  it('hello without an id for the turn (older server) changes nothing about the session', () => {
    let s = reducer(opened(null), { type: 'sent', text: 'hi', clientRef: 'r1' });
    s = play([started('t1', 'r1', null)], s);
    s = play([{ ...hello, running: [{ turnId: 't1', sessionId: null, cwd: '/w' }] }], s);
    expect(pane(s).session?.sessionId).toBeNull();
    expect(pane(s).loading).toBeFalsy();
  });

  it('hello that no longer runs the pane\'s turn (restored by hydrate) drops it from myTurns too', () => {
    let s = reducer(opened(null), { type: 'sent', text: 'hi', clientRef: 'r1' });
    s = play([started('t1', 'r1', null)], s);
    expect(pane(s)).toMatchObject({ activeTurnId: 't1', myTurns: ['t1'] });
    s = { ...s, panes: s.panes.map((p) => ({ ...p, myTurns: ['t-old', 't1'] })) };
    s = play([hello], s);
    expect(pane(s).activeTurnId).toBeNull();
    expect(pane(s).myTurns).toEqual(['t-old']);
  });
});

describe('pane_notice', () => {
  it('adds a bar for the pane\'s session', () => {
    const s = reducer(opened('s1'), { type: 'pane_notice', paneId: 'p0', message: 'x' });
    expect(pane(s).notices).toEqual([{ sessionId: 's1', message: 'x', level: 'notice' }]);
  });
});
