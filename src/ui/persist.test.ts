import { describe, expect, it } from 'vitest';
import { QUEUE_KEY, SENT_KEY, UI_KEY, hydrate, loadQueues, loadSent, loadUi, parseQueues, parseUi, saveQueues, saveSent, saveUi, snapshotQueues, snapshotUi } from './persist';
import type { ClientMessage } from '../shared/protocol';
import { sendFromPane } from './components/Pane';
import { initialState, newPane, nextQueued, reducer, type AppState, type PaneState } from './state';

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  let writes = 0;
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { writes++; m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, raw: m, writes: () => writes };
}

const twoPanes = (): AppState => {
  let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 'one' });
  s = reducer(s, { type: 'set_model', model: 'fable' });
  s = reducer(s, { type: 'set_effort', engine: 'claude', effort: 'xhigh' });
  s = reducer(s, { type: 'add_pane' });
  s = reducer(s, { type: 'set_engine', engine: 'codex' });
  s = reducer(s, { type: 'set_sandbox', sandbox: 'workspace-write' });
  s = reducer(s, { type: 'open', sessionId: null, cwd: '/x', title: 'x · 새 세션' });
  return s;
};

describe('persist (ux-state)', () => {
  it('round-trips panes, sessions, pickers, active pane, collapsed groups and the drawer', () => {
    const store = memStore();
    const s = twoPanes();
    saveUi(snapshotUi(s, { collapsed: ['/w'], drawer: true }), null, store);
    const ui = loadUi(store);
    expect(ui).toMatchObject({ v: 1, active: 1, collapsed: ['/w'], drawer: true });
    const h = hydrate(initialState, ui);
    expect(h.panes.map((p) => p.id)).toEqual(['p0', 'p1']);
    expect(h.activePaneId).toBe('p1');
    expect(h.panes[0]).toMatchObject({ session: { sessionId: 's1', cwd: '/w', title: 'one', account: null }, model: 'fable', efforts: { claude: 'xhigh', codex: 'medium' }, items: [], queue: [] });
    expect(h.panes[1]).toMatchObject({ session: { sessionId: null, cwd: '/x', engine: 'codex' }, engine: 'codex', model: 'gpt-6-sol', sandbox: 'workspace-write' });
    // a restored session waits for its history (placeholder); a new chat does not
    expect(h.panes[0]?.loading).toBe(true);
    expect(h.panes[1]?.loading).toBeFalsy();
    // add_pane after hydration keeps ids unique
    expect(reducer(h, { type: 'add_pane' }).panes.map((p) => p.id)).toEqual(['p0', 'p1', 'p2']);
  });

  it('a pending handoff (new session, no id yet) survives a reload: the 이전 세션 link and the prefilled note come back and ride the first send', () => {
    const SID = '11111111-1111-4111-8111-111111111111';
    const store = memStore();
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: '작업 (이어서)' });
    s = { ...s, panes: s.panes.map((p) => ({ ...p, handoffFrom: { sessionId: SID, title: '작업' }, prefill: '인계 메모' })) };
    saveUi(snapshotUi(s, { collapsed: [], drawer: false }), null, store);
    const h = hydrate(initialState, loadUi(store));
    expect(h.panes[0]).toMatchObject({ session: { sessionId: null, cwd: '/w' }, handoffFrom: { sessionId: SID, title: '작업' }, prefill: '인계 메모' });
    const sent: ClientMessage[] = [];
    sendFromPane(h.panes[0]!, '인계 메모', [], () => {}, (m) => sent.push(m));
    expect(sent[0]).toMatchObject({ type: 'send', sessionId: null, handoffFrom: SID });

    // After the first send (prefill cleared, id not known yet) the link is still kept for a retry after a reload.
    const afterSend = reducer(s, { type: 'sent', text: '인계 메모', clientRef: 'r1' });
    expect(hydrate(initialState, parseUi(snapshotUi(afterSend, { collapsed: [], drawer: false }))).panes[0]).toMatchObject({ handoffFrom: { sessionId: SID }, prefill: null });
  });

  it('an id-less session keeps its account pin across a reload (it rides the first send); bad or id-ful pins are not restored', () => {
    const store = memStore();
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: '작업 (이어서)' });
    s = reducer(s, { type: 'set_account_pin', pin: 'c' });
    saveUi(snapshotUi(s, { collapsed: [], drawer: false }), null, store);
    const h = hydrate(initialState, loadUi(store));
    expect(h.panes[0]!.session).toMatchObject({ sessionId: null, accountPin: 'c' });
    const sent: ClientMessage[] = [];
    sendFromPane(h.panes[0]!, 'hi', [], () => {}, (m) => sent.push(m));
    expect(sent[0]).toMatchObject({ sessionId: null, accountPin: 'c' });
    // An existing session's pin is the server's (history brings it): not persisted.
    let e = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
    e = reducer(e, { type: 'set_account_pin', pin: 'b' });
    expect(snapshotUi(e, { collapsed: [], drawer: false }).panes[0]).not.toHaveProperty('accountPin');
    const bad = parseUi({ v: 1, panes: [{ session: { sessionId: null, cwd: '/w', title: 't', engine: 'claude' }, accountPin: 'gpt' }], active: 0, collapsed: [], drawer: false });
    expect(hydrate(initialState, bad).panes[0]!.session).not.toHaveProperty('accountPin');
  });

  it('a pane\'s queue survives a reload (tab storage, not the shared one): files, paused flag, the restart hold; fresh ids; steers come back as lost steers', () => {
    const F = '22222222-2222-4222-8222-222222222222';
    const store = memStore();
    const tab = memStore();
    let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
    s = reducer(s, { type: 'sent', text: 'held', attachments: [{ id: F, name: 'a.png', isImage: true }], clientRef: 'r1' });
    s = reducer(s, { type: 'server', msg: { type: 'error', turnId: null, message: 'restart', clientRef: 'r1', code: 'draining' } });
    s = reducer(s, { type: 'attach', attachment: { id: F, name: 'b.txt', size: 5, isImage: false, previewUrl: 'blob:x' } });
    s = reducer(s, { type: 'queue_add', text: 'plain' });
    s = reducer(s, { type: 'queue_add', text: 'steer', steerId: 'k1' });
    const before = s.panes[0]!.queue.map((q) => q.id);
    saveUi(snapshotUi(s, { collapsed: [], drawer: false }), null, store);
    saveQueues(snapshotQueues(s), null, tab);
    // M3: tabs share localStorage — the queue lives only in this tab's sessionStorage
    expect(store.raw.get(UI_KEY)).not.toContain('held');
    expect(tab.raw.get(QUEUE_KEY)).not.toContain('blob:x');
    expect(hydrate(initialState, loadUi(store)).panes[0]!.queue).toEqual([]); // another tab: nothing to send
    const p = hydrate(initialState, loadUi(store), loadQueues(tab)).panes[0]!;
    expect(p.queue.map((q) => [q.text, q.attachments.map((a) => a.name), q.restart, q.lostSteer])).toEqual([
      ['held', ['a.png'], 'hold', undefined],
      ['plain', ['b.txt'], undefined, undefined],
      ['steer', [], undefined, 'k1'],
    ]);
    expect(p.queue.some((q) => before.includes(q.id) || q.steer)).toBe(false);
    expect(p.queuePaused).toBe(true); // a steer may have gone in
    // the held message is sent after the reconnect + history, once
    const h = reducer({ ...initialState, panes: [p] }, { type: 'server', msg: { type: 'hello', usage: { generatedAt: 'x', deckReachable: true, accounts: {} } as never, projects: [], running: [], codex: { available: false } } });
    expect(nextQueued(h.panes[0]!)).toBeNull();
    const ready = reducer(h, { type: 'server', msg: { type: 'history', sessionId: 's1', cwd: '/w', account: null, runningTurnId: null, messages: [] } });
    expect(nextQueued(ready.panes[0]!)?.text).toBe('held'); // even though the rest stays paused
  });

  it('a restored queue never auto-sends into a session it was not typed for: id-less sessions come back paused, a moved session\'s queue is parked (an id-less one with its folder), bad items are dropped', () => {
    const F = '22222222-2222-4222-8222-222222222222';
    const ui = parseUi({ v: 1, active: 0, collapsed: [], drawer: false, panes: [
      { session: { sessionId: null, cwd: '/w', title: 'n', engine: 'claude' } },
      { session: null },
      { session: { sessionId: 's1', cwd: '/w', title: 't', engine: 'claude' } },
    ] });
    const q = parseQueues({ v: 1, queues: [
      { pane: 0, sessionId: null, cwd: '/w', queue: [{ text: 'first', attachments: [], restart: true }] },
      { pane: 1, sessionId: null, cwd: '/x', queue: [{ text: 'orphan', attachments: [] }] },
      { pane: 0, sessionId: 's1', cwd: '/w', queue: [{ text: 7 }, { text: 'ok', attachments: [{ id: '../etc', name: 'x' }, { id: F, name: 'f', size: 3, isImage: false }] }, 'junk'] },
      { pane: 2, sessionId: 's9', cwd: '/w', queue: [{ text: 'moved', attachments: [], restart: true, maybeSent: 4 }] },
    ] });
    const h = hydrate(initialState, ui, q);
    expect(h.panes[0]).toMatchObject({ queuePaused: true });
    expect(h.panes[0]!.queue.map((x) => [x.text, x.restart])).toEqual([['first', undefined]]);
    expect(h.panes[1]!.queue).toEqual([]);
    expect(h.panes[2]!.queue.map((x) => [x.text, x.attachments.map((a) => a.id)])).toEqual([['ok', [F]]]);
    expect(h.panes[2]!.queuePaused).toBe(false);
    expect(h.parked.s9!.cwd).toBe('/w');
    expect(h.parked.s9!.queue.map((x) => [x.text, x.restart, x.maybeSent])).toEqual([['moved', undefined, 4]]);
    expect(h.parked['__new__:/x']!.queue.map((x) => x.text)).toEqual(['orphan']);
    // parked messages are kept across a reload too, with their real folder (L6)
    const again = parseQueues(snapshotQueues(h))!.queues.filter((x) => x.pane === null);
    expect(again).toHaveLength(2);
    expect(again).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 's9', cwd: '/w', queue: [expect.objectContaining({ text: 'moved' })] }),
      expect.objectContaining({ sessionId: null, cwd: '/x', queue: [expect.objectContaining({ text: 'orphan' })] }),
    ]));
    // the id-less one comes back into the next new session in that folder, paused
    const opened = reducer(hydrate(initialState, null, parseQueues(snapshotQueues(h))), { type: 'open', sessionId: null, cwd: '/x', title: 'n' });
    expect(opened.panes[0]).toMatchObject({ queuePaused: true, queue: [expect.objectContaining({ text: 'orphan' })] });
    expect(opened.parked['__new__:/x']).toBeUndefined();
  });

  it('M1 + M3: a send lost with the socket, saved as of the hello before an auto-reload, is still recognised by its ref after a server restart and the reload', () => {
    const tab = memStore();
    const hello = { type: 'hello', usage: { generatedAt: 'x', deckReachable: true, accounts: {} }, projects: [], running: [], codex: { available: false } } as never;
    let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
    s = reducer(s, { type: 'server', msg: { type: 'history', sessionId: 's1', cwd: '/w', account: null, runningTurnId: null, messages: [{ kind: 'user', text: 'old', ts: null, n: 0 }] } });
    s = reducer(s, { type: 'sent', text: 'went in', clientRef: 'tab-7' });
    // App's auto-reload: the reducer's view after this hello is saved synchronously, then the page reloads.
    saveQueues(snapshotQueues(reducer(s, { type: 'server', msg: hello })), null, tab);
    const ui = parseUi({ v: 1, active: 0, collapsed: [], drawer: false, panes: [{ session: { sessionId: 's1', cwd: '/w', title: 't', engine: 'claude' } }] });
    let r = hydrate(initialState, ui, loadQueues(tab));
    expect(r.panes[0]!.queue.map((q) => [q.text, q.ref, q.maybeSent])).toEqual([['went in', 'tab-7', 1]]);
    r = reducer(r, { type: 'server', msg: hello });
    expect(nextQueued(r.panes[0]!)).toBeNull();
    // the restarted server still knows the ref (AcceptedRefs is on disk)
    r = reducer(r, { type: 'server', msg: { type: 'history', sessionId: 's1', cwd: '/w', account: null, runningTurnId: null, messages: [{ kind: 'user', text: 'old', ts: null, n: 0 }], acceptedRefs: ['tab-7'] } });
    expect(r.panes[0]!.queue).toEqual([]);
  });

  it('E: a send still waiting for its turn_started is saved at the head of its queue as maybe-sent (ref, ordinal, send time) and checked after the reload', () => {
    const tab = memStore();
    let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
    s = reducer(s, { type: 'server', msg: { type: 'history', sessionId: 's1', cwd: '/w', account: null, runningTurnId: null, messages: [{ kind: 'user', text: 'old', ts: null, n: 0 }] } });
    s = reducer(s, { type: 'queue_add', text: 'next' });
    s = reducer(s, { type: 'sent', text: 'in flight', clientRef: 'r5' });
    const saved = snapshotQueues(s).queues[0]!;
    expect(saved.queue.map((q) => [q.text, q.restart, q.maybeSent, q.ref])).toEqual([['in flight', true, 1, 'r5'], ['next', undefined, undefined, undefined]]);
    expect(saved.queue[0]!.at).toEqual(expect.any(Number));
    expect(saved.paused).toBeUndefined();
    saveQueues(snapshotQueues(s), null, tab);
    const ui = parseUi({ v: 1, active: 0, collapsed: [], drawer: false, panes: [{ session: { sessionId: 's1', cwd: '/w', title: 't', engine: 'claude' } }] });
    const r = hydrate(initialState, ui, loadQueues(tab));
    expect(r.panes[0]!.queue[0]).toMatchObject({ text: 'in flight', restart: 'hold', maybeSent: 1, ref: 'r5', at: saved.queue[0]!.at });
    // a new session's pending send cannot be checked: a plain item, the queue saved paused
    let n = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'n' });
    n = reducer(n, { type: 'sent', text: 'first', clientRef: 'r6' });
    expect(snapshotQueues(n).queues[0]).toMatchObject({ sessionId: null, paused: true, queue: [{ text: 'first', ref: 'r6' }] });
    expect(snapshotQueues(n).queues[0]!.queue[0]).not.toHaveProperty('restart');
  });

  it('F: kept and the send time survive a reload; bad values are dropped', () => {
    const q = parseQueues({ v: 1, queues: [{ pane: 0, sessionId: 's1', cwd: '/w', queue: [{ text: 'a', attachments: [], kept: true, at: 123 }, { text: 'b', attachments: [], kept: 'yes', at: 'x' }] }] });
    expect(q!.queues[0]!.queue).toEqual([{ text: 'a', attachments: [], kept: true, at: 123 }, { text: 'b', attachments: [] }]);
    const ui = parseUi({ v: 1, active: 0, collapsed: [], drawer: false, panes: [{ session: { sessionId: 's1', cwd: '/w', title: 't', engine: 'claude' } }] });
    expect(snapshotQueues(hydrate(initialState, ui, q)).queues[0]!.queue[0]).toEqual({ text: 'a', attachments: [], kept: true, at: 123 });
  });

  it('M4: a queue write that fails (quota) removes the stored copy, so an older queue never comes back and sends again', () => {
    const tab = memStore();
    let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
    s = reducer(s, { type: 'queue_add', text: 'old' });
    const last = saveQueues(snapshotQueues(s), null, tab);
    expect(loadQueues(tab)!.queues).toHaveLength(1);
    s = reducer(s, { type: 'queue_remove', id: s.panes[0]!.queue[0]!.id });
    s = reducer(s, { type: 'queue_add', text: 'x'.repeat(10) });
    const full = { ...tab, setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(saveQueues(snapshotQueues(s), last, full)).toBeNull(); // tried again on the next change
    expect(loadQueues(tab)).toBeNull();
  });

  it('a handoff link is only kept while the session has no id, and bad values are dropped', () => {
    const SID = '11111111-1111-4111-8111-111111111111';
    let s = reducer(initialState, { type: 'open', sessionId: 'new1', cwd: '/w', title: 't' });
    s = { ...s, panes: s.panes.map((p) => ({ ...p, handoffFrom: { sessionId: SID, title: '작업' } })) };
    expect(snapshotUi(s, { collapsed: [], drawer: false }).panes[0]).not.toHaveProperty('handoffFrom');
    const ui = parseUi({ v: 1, panes: [{ session: { sessionId: null, cwd: '/w', title: 't', engine: 'claude' }, handoffFrom: { sessionId: 7, title: 'x' }, prefill: 3 }], active: 0, collapsed: [], drawer: false });
    expect(hydrate(initialState, ui).panes[0]).toMatchObject({ handoffFrom: null, prefill: null });
  });

  it('nothing stored, corrupt JSON, wrong shape or an unknown version → null (start fresh)', () => {
    expect(loadUi(memStore())).toBeNull();
    expect(loadUi(memStore({ [UI_KEY]: '{not json' }))).toBeNull();
    expect(parseUi('x')).toBeNull();
    expect(parseUi([])).toBeNull();
    expect(parseUi({ v: 2, panes: [{}] })).toBeNull();
    expect(parseUi({ panes: [{}] })).toBeNull();
    expect(parseUi({ v: 1, panes: [] })).toBeNull();
    expect(parseUi({ v: 1, panes: 'nope' })).toBeNull();
    expect(hydrate(initialState, null)).toBe(initialState);
  });

  it('a bad field falls back to its default without losing the good ones', () => {
    const ui = parseUi({
      v: 1,
      active: 9,
      collapsed: ['/ok', 3, null],
      drawer: 'yes',
      panes: [
        { session: { sessionId: 's1', cwd: '/w', title: 7, engine: 'llama' }, model: 'gpt-9', efforts: { claude: 'max', codex: 'low' }, engine: 'x', sandbox: 'danger-full-access' },
        { session: { sessionId: 's2', cwd: 'relative/path' }, model: 'sonnet' },
        { session: { sessionId: 42, cwd: '/w' } },
        null,
        'junk',
        {}, {}, {}, // more than MAX_PANES (5) in total
      ],
    })!;
    expect(ui.panes).toHaveLength(5);
    expect(ui.active).toBe(0);
    expect(ui.collapsed).toEqual(['/ok']);
    expect(ui.drawer).toBe(false);
    const d = newPane('');
    expect(ui.panes[0]).toEqual({ session: { sessionId: 's1', cwd: '/w', title: 's1', engine: null }, model: d.model, efforts: { claude: 'high', codex: 'low', gemini: 'medium' }, autoEffort: null, engine: 'claude', sandbox: 'read-only' });
    expect(ui.panes[1]).toMatchObject({ session: null, model: 'sonnet' });
    expect(ui.panes[2]!.session).toBeNull();
    expect(ui.panes[3]).toEqual({ session: null, model: d.model, efforts: d.efforts, autoEffort: null, engine: d.engine, sandbox: d.sandbox });
  });

  it('keeps 자동 (model and its effort) and Gemini panes across a reload', () => {
    const store = memStore();
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'w · 새 세션' });
    s = reducer(s, { type: 'set_model', model: 'auto' });
    s = reducer(s, { type: 'set_auto_effort', effort: 'low' });
    s = reducer(s, { type: 'add_pane' });
    s = reducer(s, { type: 'set_engine', engine: 'gemini' });
    s = reducer(s, { type: 'open', sessionId: 'g-1', cwd: '/x', title: 'gem' });
    s = { ...s, panes: s.panes.map((p, i) => (i === 1 && p.session ? { ...p, session: { ...p.session, engine: 'gemini' as const } } : p)) };
    saveUi(snapshotUi(s, { collapsed: [], drawer: false }), null, store);
    const h = hydrate(initialState, loadUi(store));
    expect(h.panes[0]).toMatchObject({ model: 'auto', autoEffort: 'low' });
    expect(h.panes[1]).toMatchObject({ engine: 'gemini', model: 'gemini-pro', session: { sessionId: 'g-1', engine: 'gemini' } });
    expect(parseUi({ v: 1, panes: [{ model: 'auto', autoEffort: 'max' }] })!.panes[0]).toMatchObject({ model: 'auto', autoEffort: null });
  });

  it('saveUi writes only on change and survives a throwing storage', () => {
    const store = memStore();
    const ui = snapshotUi(twoPanes(), { collapsed: [], drawer: false });
    const last = saveUi(ui, null, store);
    saveUi(ui, last, store);
    expect(store.writes()).toBe(1);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
    expect(() => saveUi(ui, null, broken)).not.toThrow();
    expect(loadUi(broken)).toBeNull();
    expect(loadSent('s1', broken)).toEqual([]);
  });

  it('remembers sent files per session (validated, deduped) for transcript reloads', () => {
    const store = memStore();
    const file = { id: '11111111-2222-3333-4444-555555555555', name: 'shot.png', isImage: true };
    const p: PaneState = { ...newPane('p0'), session: { sessionId: 's1', cwd: '/w', account: null, title: 't', engine: 'claude', sandbox: null }, items: [{ kind: 'user', text: 'look', attachments: [file] }, { kind: 'user', text: 'plain' }] };
    const unsaved: PaneState = { ...p, session: { ...p.session!, sessionId: null } };
    saveSent([p, unsaved], 1, store);
    saveSent([p], 2, store);
    expect(loadSent('s1', store)).toEqual([{ text: 'look', files: [file] }]);
    expect(loadSent('nope', store)).toEqual([]);
    // tampered storage: bad ids / shapes are dropped
    const bad = memStore({ [SENT_KEY]: JSON.stringify({ s1: { at: 1, records: [{ text: 'a', files: [{ id: '../../etc', name: 'x' }] }, { text: 'b', files: [file] }, 'junk'] }, s2: 'junk' }) });
    expect(loadSent('s1', bad)).toEqual([{ text: 'b', files: [file] }]);
    expect(loadSent('s2', bad)).toEqual([]);
  });
});
