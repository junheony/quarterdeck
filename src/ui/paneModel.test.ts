import { afterEach, describe, expect, it } from 'vitest';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import type { TranscriptMessage } from '../shared/session-types';
import { sendFromPane, startBranch, startHandoff } from './components/Pane';
import { setFeatures } from './features';
import { hydrate, parseUi, snapshotUi } from './persist';
import { initialState, reducer, type AppState } from './state';

const history = (sessionId: string, extra: Partial<Extract<ServerMessage, { type: 'history' }>> = {}, messages: TranscriptMessage[] = [{ kind: 'user', text: 'q', ts: null }]): ServerMessage =>
  ({ type: 'history', sessionId, cwd: '/w', account: 'b', engine: 'claude', runningTurnId: null, messages, ...extra });
const msg = (s: AppState, m: ServerMessage) => reducer(s, { type: 'server', msg: m });
const pane = (s: AppState) => s.panes[0]!;
const sendOf = (s: AppState, fn: 'send' | 'handoff' | 'branch' = 'send'): ClientMessage => {
  const out: ClientMessage[] = [];
  if (fn === 'send') sendFromPane(pane(s), 'hi', [], () => {}, (m) => out.push(m));
  else if (fn === 'handoff') startHandoff(pane(s), () => {}, (m) => out.push(m));
  else startBranch(pane(s), 1, 'edited', 'q', () => {}, (m) => out.push(m));
  return out[0]!;
};
const openExisting = (sessionModel?: 'sonnet' | 'opus' | 'fable', messages?: TranscriptMessage[]) => {
  const s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
  return msg(s, history('s1', sessionModel ? { sessionModel } : {}, messages));
};

describe('pane model: an existing session runs on its own default unless the user picks one', () => {
  afterEach(() => setFeatures(undefined));

  it('turn_started carries the session\'s model (picked on another device): a pane that picked none follows it, a picking pane keeps its own', () => {
    const started = (sessionModel: 'sonnet' | 'opus' | 'fable'): ServerMessage => ({ type: 'turn_started', turnId: 't1', sessionId: 's1', cwd: '/w', account: 'b', model: 'opus', reason: '', attempt: 0, engine: 'claude', sessionModel });
    let s = msg(openExisting('opus'), started('fable'));
    expect(pane(s).model).toBe('fable');
    expect(pane(s).modelPicked).toBe(false);
    s = reducer(openExisting('opus'), { type: 'set_model', model: 'sonnet' });
    s = msg(s, started('fable'));
    expect(pane(s).model).toBe('sonnet');
  });

  it('an existing Claude session with no pick sends no model (send, handoff, branch) and shows the server sessionModel', () => {
    const s = openExisting('opus');
    expect(pane(s).model).toBe('opus');
    expect(pane(s).modelPicked).toBe(false);
    for (const fn of ['send', 'handoff', 'branch'] as const) expect(sendOf(s, fn)).not.toHaveProperty('model');
  });

  it('an older server (no sessionModel): the transcript\'s last assistant model, else the imported default (Fable)', () => {
    const msgs: TranscriptMessage[] = [{ kind: 'user', text: 'q', ts: null }, { kind: 'assistant', text: 'a', model: 'claude-sonnet-5-5', toolCalls: [], ts: null }];
    expect(pane(openExisting(undefined, msgs)).model).toBe('sonnet');
    expect(pane(openExisting()).model).toBe('fable');
  });

  it('a server that sends sessionModel (features) and sent none: the imported default, never a guess from the transcript', () => {
    setFeatures(['sessionModel']);
    const msgs: TranscriptMessage[] = [{ kind: 'user', text: 'q', ts: null }, { kind: 'assistant', text: 'a', model: 'claude-sonnet-5-5', toolCalls: [], ts: null }];
    expect(pane(openExisting(undefined, msgs)).model).toBe('fable');
    expect(pane(openExisting('opus', msgs)).model).toBe('opus');
  });

  it('picking a model sends it from then on; opening another session drops the pick', () => {
    let s = openExisting('opus');
    s = reducer(s, { type: 'set_model', model: 'fable' });
    expect(sendOf(s)).toMatchObject({ model: 'fable' });
    s = msg(s, history('s1', { sessionModel: 'opus' }));
    expect(pane(s).model).toBe('fable');
    s = reducer(s, { type: 'open', sessionId: 's2', cwd: '/w', title: 'u' });
    s = msg(s, history('s2', { sessionModel: 'sonnet' }));
    expect(pane(s)).toMatchObject({ model: 'sonnet', modelPicked: false });
    expect(sendOf(s)).not.toHaveProperty('model');
  });

  it('a new session shows Fable and sends it; after its first send it keeps sending its model', () => {
    let s = openExisting('sonnet');
    s = reducer(s, { type: 'open', sessionId: null, cwd: '/w', title: '새 세션' });
    expect(pane(s).model).toBe('fable');
    expect(sendOf(s)).toMatchObject({ sessionId: null, model: 'fable' });
    s = reducer(s, { type: 'sent', text: 'hi', clientRef: 'r1' });
    expect(pane(s).modelPicked).toBe(true);
    // The id arrives; a later history keeps the pane's model and later sends carry it.
    s = { ...s, panes: s.panes.map((p) => ({ ...p, session: { ...p.session!, sessionId: 's9' }, awaitingStart: false })) };
    s = msg(s, history('s9', { sessionModel: 'opus' }));
    expect(pane(s).model).toBe('fable');
    expect(sendOf(s)).toMatchObject({ sessionId: 's9', model: 'fable' });
  });

  it('a reload keeps the rule: an unpicked pane still sends no model, a picked one still sends its pick', () => {
    const reload = (s: AppState) => hydrate(initialState, parseUi(snapshotUi(s, { collapsed: [], drawer: false })));
    let s = reload(openExisting('opus'));
    expect(pane(s).modelPicked).toBe(false);
    expect(sendOf(s)).not.toHaveProperty('model');
    s = msg(s, history('s1', { sessionModel: 'fable' }));
    expect(pane(s).model).toBe('fable');

    let p = reducer(openExisting('opus'), { type: 'set_model', model: 'sonnet' });
    p = reload(p);
    expect(pane(p)).toMatchObject({ model: 'sonnet', modelPicked: true });
    expect(sendOf(p)).toMatchObject({ model: 'sonnet' });
    // Stored by an older UI (no flag): treated as not picked.
    const old = parseUi({ v: 1, panes: [{ session: { sessionId: 's1', cwd: '/w', title: 't', engine: 'claude' }, model: 'fable' }], active: 0, collapsed: [], drawer: false });
    expect(sendOf(hydrate(initialState, old))).not.toHaveProperty('model');
  });

  it('a Codex session still sends its model', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 'c1', cwd: '/w', title: 't' });
    s = msg(s, { type: 'history', sessionId: 'c1', cwd: '/w', account: 'gpt', engine: 'codex', sandbox: 'read-only', runningTurnId: null, messages: [] });
    expect(sendOf(s)).toHaveProperty('model');
  });
});
