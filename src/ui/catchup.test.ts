import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ClientMessageSchema, type ClientMessage, type ServerMessage, type StreamPos } from '../shared/protocol';
import { CATCHUP_RETRY_MAX_MS, CATCHUP_RETRY_MIN_MS, CATCHUP_STALL_MS, CATCHUP_VISIBLE_STALL_MS, createCatchup } from './catchup';
import { initialState, nextQueued, reducer, type AppState } from './state';

const S = 's1';
const pos = (seq: number, epoch = 'e1', sid = S): StreamPos => ({ sid, epoch, seq });
const delta = (seq: number, epoch = 'e1', sid = S): ServerMessage => ({ type: 'delta', turnId: 't', sessionId: sid, cwd: '/w', text: `d${seq}`, pos: pos(seq, epoch, sid) });
const history = (p?: StreamPos, sid = S): ServerMessage => ({ type: 'history', sessionId: sid, cwd: '/w', account: 'a', messages: [], runningTurnId: null, ...(p ? { pos: p } : {}) });
const caughtUp = (sid = S): ServerMessage => ({ type: 'catchup', sessionId: sid, runningTurnId: null });
const refused = (message = '기록을 읽지 못했습니다', sid = S): ServerMessage => ({ type: 'error', turnId: null, sessionId: sid, message });

function setup(o: { enabled?: boolean; connected?: boolean; shown?: string[] } = {}) {
  const state = { enabled: o.enabled ?? true, connected: o.connected ?? true, shown: o.shown ?? [S, 's2'], stalled: 0 };
  const out: ClientMessage[] = [];
  const c = createCatchup({
    send: (m) => { if (!state.connected) return false; out.push(m); return true; },
    enabled: () => state.enabled,
    shown: () => state.shown,
    stalled: () => { state.stalled++; },
  });
  /** The catch-up requests sent so far. */
  const asked = () => out.flatMap((m) => (m.type === 'open_session' && m.after ? [{ sessionId: m.sessionId, after: m.after }] : []));
  return { c, out, asked, state };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('catch-up tracker: order', () => {
  it('events in order are applied; a repeat of one already applied is dropped; nothing is asked', () => {
    const { c, out } = setup();
    expect(c.accept(delta(4))).toBe(true);
    expect(c.accept(delta(5))).toBe(true);
    expect(c.accept(delta(5))).toBe(false);
    expect(c.accept(delta(4))).toBe(false);
    expect(c.accept(delta(6))).toBe(true);
    // The session's next process counts on under a new epoch.
    expect(c.accept(delta(7, 'e2'))).toBe(true);
    expect(out).toEqual([]);
  });

  it('messages without a position (an older server, a card, the index) always pass', () => {
    const { c, out } = setup();
    expect(c.accept({ type: 'delta', turnId: 't', sessionId: S, cwd: '/w', text: 'x' })).toBe(true);
    expect(c.accept({ type: 'index', projects: [] })).toBe(true);
    expect(c.accept({ type: 'error', turnId: null, message: 'm' })).toBe(true);
    expect(c.accept(refused())).toBe(true);
    expect(out).toEqual([]);
  });

  it('a skipped number is not applied: what is missing is asked for once, from the last applied position, and then comes in order', () => {
    const { c, asked, state } = setup();
    c.accept(delta(1));
    expect(c.accept(delta(3))).toBe(false);
    expect(c.accept(delta(4))).toBe(false);
    expect(asked()).toEqual([{ sessionId: S, after: { epoch: 'e1', seq: 1 } }]);
    expect(c.accept(caughtUp())).toBe(true);
    expect([2, 3, 4].map((n) => c.accept(delta(n)))).toEqual([true, true, true]);
    expect(c.accept(delta(5))).toBe(true);
    vi.advanceTimersByTime(10 * CATCHUP_STALL_MS);
    expect(asked().length).toBe(1);
    expect(state.stalled).toBe(0);
  });

  it('an event of another epoch that does not follow on is a gap too', () => {
    const { c, asked } = setup();
    c.accept(delta(9));
    expect(c.accept(delta(2, 'e2'))).toBe(false);
    expect(asked()).toEqual([{ sessionId: S, after: { epoch: 'e1', seq: 9 } }]);
  });

  it('a history is the new starting point (its position, or none) — also as the answer of a server that could not catch up', () => {
    const { c, asked, state } = setup();
    c.accept(delta(1));
    c.accept(delta(5));
    expect(asked().length).toBe(1);
    expect(c.accept(history(pos(40, 'e3')))).toBe(true);
    expect(c.accept(delta(40, 'e3'))).toBe(false);
    expect(c.accept(delta(41, 'e3'))).toBe(true);
    c.accept(history());
    expect(c.accept(delta(7, 'e9'))).toBe(true);
    vi.advanceTimersByTime(10 * CATCHUP_STALL_MS);
    expect(asked().length).toBe(1);
    expect(state.stalled).toBe(0);
  });

  it('sessions are tracked apart', () => {
    const { c, out } = setup();
    c.accept(delta(1));
    expect(c.accept(delta(8, 'x', 's2'))).toBe(true);
    expect(c.accept(delta(2))).toBe(true);
    expect(out).toEqual([]);
  });

  it('a session no pane shows is not kept in order: its events pass and nothing is asked', () => {
    const { c, out, state } = setup({ shown: [] });
    expect([1, 5, 5].map((n) => c.accept(delta(n)))).toEqual([true, true, true]);
    state.shown = [S];
    // Shown again: in order from whatever comes first.
    expect([9, 10, 12].map((n) => c.accept(delta(n)))).toEqual([true, true, false]);
    expect(out).toEqual([{ type: 'open_session', sessionId: S, after: { epoch: 'e1', seq: 10 } }]);
  });
});

describe('catch-up tracker: failures', () => {
  it('no answer: the same request is not sent again on that socket — after the stall time the socket is given up (reconnect)', () => {
    const { c, asked, state } = setup();
    c.accept(delta(1));
    c.accept(delta(3));
    c.accept(delta(4));
    vi.advanceTimersByTime(CATCHUP_STALL_MS - 1);
    expect(asked().length).toBe(1);
    expect(state.stalled).toBe(0);
    vi.advanceTimersByTime(1);
    expect(state.stalled).toBe(1);
    // Nothing more until the new socket's hello.
    vi.advanceTimersByTime(10 * CATCHUP_STALL_MS);
    expect(asked().length).toBe(1);
    expect(state.stalled).toBe(1);
    c.hello();
    expect(asked().length).toBe(2);
    expect(CATCHUP_STALL_MS).toBe(30_000);
  });

  it('the server failing (an error about that session): asked again after 1s, then 2s, 4s … up to 30s; the error is shown once', () => {
    const { c, asked } = setup();
    c.accept(delta(1));
    c.accept(delta(3));
    expect(c.accept(refused())).toBe(true);
    let wait = CATCHUP_RETRY_MIN_MS;
    for (let n = 2; n <= 8; n++) {
      vi.advanceTimersByTime(wait - 1);
      expect(asked().length).toBe(n - 1);
      vi.advanceTimersByTime(1);
      expect(asked().length).toBe(n);
      // The same failure again: not shown again.
      expect(c.accept(refused())).toBe(false);
      wait = Math.min(wait * 2, CATCHUP_RETRY_MAX_MS);
    }
    expect(wait).toBe(CATCHUP_RETRY_MAX_MS);
    expect(CATCHUP_RETRY_MIN_MS).toBe(1000);
    expect(CATCHUP_RETRY_MAX_MS).toBe(30_000);
    // An answer ends it; the next failure starts at 1s again, and is shown.
    c.accept(history(pos(3)));
    vi.advanceTimersByTime(10 * CATCHUP_RETRY_MAX_MS);
    expect(asked().length).toBe(8);
    c.accept(delta(9));
    expect(asked().length).toBe(9);
    expect(c.accept(refused())).toBe(true);
    vi.advanceTimersByTime(CATCHUP_RETRY_MIN_MS);
    expect(asked().length).toBe(10);
  });

  it('an error about the session while nothing is asked changes nothing', () => {
    const { c, out } = setup();
    c.accept(delta(1));
    expect(c.accept(refused())).toBe(true);
    expect(c.accept(refused())).toBe(true);
    vi.advanceTimersByTime(10 * CATCHUP_RETRY_MAX_MS);
    expect(out).toEqual([]);
  });

  it('the session is gone (not_found): shown once, never asked again', () => {
    const { c, asked, state } = setup();
    c.accept(delta(1));
    c.accept(delta(3));
    expect(c.accept({ type: 'error', turnId: null, sessionId: S, message: '세션을 찾을 수 없습니다', code: 'not_found' })).toBe(true);
    vi.advanceTimersByTime(10 * CATCHUP_RETRY_MAX_MS);
    c.visible();
    expect(asked().length).toBe(1);
    expect(state.stalled).toBe(0);
  });

  it('a pane closed while its request waits: no retry, no request for it afterwards', () => {
    const { c, asked, state } = setup();
    c.accept(delta(1));
    c.accept(delta(3));
    c.accept(refused());
    state.shown = [];
    vi.advanceTimersByTime(10 * CATCHUP_RETRY_MAX_MS);
    c.visible();
    expect(asked().length).toBe(1);
    // forget (close_session): an outstanding request's clock stops too.
    const b = setup();
    b.c.accept(delta(1));
    b.c.accept(delta(3));
    b.c.forget(S);
    vi.advanceTimersByTime(10 * CATCHUP_STALL_MS);
    expect(b.state.stalled).toBe(0);
    expect(b.c.accept(delta(9))).toBe(true);
  });

  it('not connected: nothing is asked and nothing is retried (the reconnect asks); cancel stops the clocks', () => {
    const { c, out, state } = setup({ connected: false });
    c.accept(delta(1));
    c.accept(delta(3));
    c.visible();
    vi.advanceTimersByTime(10 * CATCHUP_RETRY_MAX_MS);
    expect(out).toEqual([]);
    state.connected = true;
    c.visible();
    expect(out.length).toBe(1);
    c.cancel();
    vi.advanceTimersByTime(10 * CATCHUP_STALL_MS);
    expect(state.stalled).toBe(0);
  });
});

describe('catch-up tracker: reconnect and coming back into view', () => {
  it('hello: every shown session is opened again once — with its position where one is known, plainly otherwise', () => {
    const { c, out, state } = setup({ shown: [S, 's2', 's3', S] });
    c.accept(delta(5));
    c.accept(delta(2, 'x', 's2'));
    c.hello();
    expect(out).toEqual([
      { type: 'open_session', sessionId: S, after: { epoch: 'e1', seq: 5 } },
      { type: 'open_session', sessionId: 's2', after: { epoch: 'x', seq: 2 } },
      { type: 'open_session', sessionId: 's3' },
    ]);
    // A new socket: what the old one was asked does not count.
    c.hello();
    expect(out.length).toBe(6);
    expect(state.stalled).toBe(0);
  });

  it('hello from an older server: plain opens only, and the positions are forgotten', () => {
    const { c, out, state } = setup();
    c.accept(delta(5));
    state.enabled = false;
    c.hello();
    expect(out).toEqual([{ type: 'open_session', sessionId: S }, { type: 'open_session', sessionId: 's2' }]);
    c.visible();
    state.enabled = true;
    c.visible();
    expect(out.length).toBe(2);
    vi.advanceTimersByTime(10 * CATCHUP_STALL_MS);
    expect(state.stalled).toBe(0);
  });

  it('back in view: the shown sessions with a position are asked about (nothing is opened plainly), and a waiting retry runs now with its delay back at 1s', () => {
    const { c, out, asked } = setup({ shown: [S, 's3'] });
    c.accept(delta(5));
    c.visible();
    expect(out).toEqual([{ type: 'open_session', sessionId: S, after: { epoch: 'e1', seq: 5 } }]);
    c.accept(refused());
    vi.advanceTimersByTime(CATCHUP_RETRY_MIN_MS);
    c.accept(refused());
    // waiting 2s now
    c.visible();
    expect(asked().length).toBe(3);
    c.accept(refused());
    vi.advanceTimersByTime(CATCHUP_RETRY_MIN_MS);
    expect(asked().length).toBe(4);
  });
});

describe('an older server', () => {
  it('its schema drops `after` and answers as to any open_session', () => {
    // The open_session schema before `after` existed.
    const old = z.object({ type: z.literal('open_session'), sessionId: z.string().min(1) });
    const sent = { type: 'open_session', sessionId: S, after: { epoch: 'e1', seq: 3 } };
    expect(old.parse(sent)).toEqual({ type: 'open_session', sessionId: S });
    expect(ClientMessageSchema.parse(sent)).toEqual(sent);
  });
});

describe('tracker and reducer together', () => {
  const pane = (s: AppState) => s.panes[0]!;
  it('a send whose turn_started fell behind a gap is still this pane\'s once the history lists it: the pane is not left waiting', () => {
    const { c } = setup();
    let s = reducer(initialState, { type: 'open', sessionId: S, cwd: '/w', title: 't' });
    const play = (m: ServerMessage) => { if (c.accept(m)) s = reducer(s, { type: 'server', msg: m }); };
    play({ type: 'history', sessionId: S, cwd: '/w', account: null, runningTurnId: null, messages: [], acceptedRefs: [], pos: pos(40, 'A') });
    s = reducer(s, { type: 'sent', text: 'go', clientRef: 'r1' });
    expect(pane(s)).toMatchObject({ awaitingStart: true, awaitingRef: 'r1' });
    // 41‥90 never reached this socket.
    play({ type: 'turn_started', turnId: 'tB', sessionId: S, cwd: '/w', account: 'b', model: 'opus', reason: '', attempt: 1, clientRef: 'r1', pos: pos(91, 'B') });
    expect(pane(s).awaitingStart).toBe(true);
    play({ type: 'history', sessionId: S, cwd: '/w', account: null, runningTurnId: 'tB', messages: [{ kind: 'user', text: 'go', ts: null, n: 0 }], acceptedRefs: ['r1'], pos: pos(91, 'B') });
    expect(pane(s)).toMatchObject({ awaitingStart: false, awaitingRef: null, awaitingSend: null, activeTurnId: 'tB' });
    expect(pane(s).myTurns).toContain('tB');
    play({ type: 'turn_result', turnId: 'tB', sessionId: S, cwd: '/w', ok: true, text: 'done', badge: null, errorText: null, pos: pos(92, 'B') });
    expect(pane(s)).toMatchObject({ awaitingStart: false, activeTurnId: null });
    // The pane is free again: the next queued message may go.
    s = reducer(s, { type: 'queue_add', text: 'next' });
    expect(nextQueued(pane(s))?.text).toBe('next');
  });

  it('a send the history does not list keeps waiting for its turn_started', () => {
    let s = reducer(initialState, { type: 'open', sessionId: S, cwd: '/w', title: 't' });
    s = reducer(s, { type: 'sent', text: 'go', clientRef: 'r1' });
    s = reducer(s, { type: 'server', msg: { type: 'history', sessionId: S, cwd: '/w', account: null, runningTurnId: null, messages: [], acceptedRefs: ['other'], pendingRefs: ['r1'] } });
    expect(pane(s)).toMatchObject({ awaitingStart: true, awaitingRef: 'r1' });
  });

  it('visible() gives the request 5 s, not 30 s, before reporting the socket stalled', () => {
    const { c, asked, state } = setup();
    c.accept(delta(1));
    c.visible();
    expect(asked().length).toBe(1);
    vi.advanceTimersByTime(CATCHUP_VISIBLE_STALL_MS - 1);
    expect(state.stalled).toBe(0);
    vi.advanceTimersByTime(1);
    expect(state.stalled).toBe(1);
  });

  it('visible() with a request already out shortens its remaining wait to 5 s', () => {
    const { c, asked, state } = setup();
    c.accept(delta(1));
    c.accept(delta(3));
    expect(asked().length).toBe(1);
    vi.advanceTimersByTime(10_000);
    c.visible();
    expect(asked().length).toBe(1);
    vi.advanceTimersByTime(CATCHUP_VISIBLE_STALL_MS);
    expect(state.stalled).toBe(1);
  });
});
