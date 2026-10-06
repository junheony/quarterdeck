import { afterEach, describe, expect, it } from 'vitest';
import type { AccountInfo, ServerMessage } from '../shared/protocol';
import type { ClientMessage } from '../shared/protocol';
import { HANDOFF_PROMPT } from '../shared/handoff';
import { ACCOUNT_PALETTE_SIZE, LEGACY_ACCOUNT_LIST, accountListOf, activePin, seatLabel, uiAccounts } from './accounts';
import { startBranch } from './components/Pane';
import { setFeatures } from './features';
import { hydrate, parseUi } from './persist';
import { initialState, reducer, type AppState } from './state';

const acct = (id: string, label = id.toUpperCase(), extra: Partial<AccountInfo> = {}): AccountInfo => ({ id, label, home: false, retired: false, ...extra });
const FIVE: AccountInfo[] = [acct('a', 'Main', { home: true }), acct('b', 'Work'), acct('old', 'Old', { retired: true }), acct('d'), acct('team-2', 'Team-2')];
const usage = { generatedAt: 'x', deckReachable: true, accounts: {} };
const hello = (extra: Partial<Extract<ServerMessage, { type: 'hello' }>> = {}): ServerMessage => ({ type: 'hello', usage, projects: [], running: [], codex: { available: false }, ...extra });
const server = (s: AppState, msg: ServerMessage): AppState => reducer(s, { type: 'server', msg });

afterEach(() => setFeatures(undefined));

describe('the UI account list', () => {
  it('before any hello it is a/b/c with A as home', () => {
    expect(initialState.accounts).toEqual([
      { id: 'a', label: 'A', home: true, retired: false },
      { id: 'b', label: 'B', home: false, retired: false },
      { id: 'c', label: 'C', home: false, retired: false },
    ]);
    expect(LEGACY_ACCOUNT_LIST).toBe(initialState.accounts);
  });

  it('a server with the accounts feature fills it from hello.accounts, in its order, retired included', () => {
    setFeatures(['accounts']);
    const s = server(initialState, hello({ features: ['accounts'], accounts: FIVE }));
    expect(s.accounts).toEqual(FIVE);
    const names = uiAccounts(s.accounts);
    expect(names.active.map((a) => a.id)).toEqual(['a', 'b', 'd', 'team-2']);
    expect(names.home?.id).toBe('a');
  });

  it('an older server (no feature, no field) leaves a/b/c — and a field without the feature is not read', () => {
    expect(server(initialState, hello()).accounts).toEqual(LEGACY_ACCOUNT_LIST);
    expect(server(initialState, hello({ accounts: FIVE })).accounts).toEqual(LEGACY_ACCOUNT_LIST);
  });

  it('every hello replaces it: a reconnect to an older server goes back to a/b/c, to a newer one takes its list', () => {
    setFeatures(['accounts']);
    const s1 = server(initialState, hello({ features: ['accounts'], accounts: FIVE }));
    setFeatures(undefined);
    const s2 = server(s1, hello());
    expect(s2.accounts).toEqual(LEGACY_ACCOUNT_LIST);
    setFeatures(['accounts']);
    expect(server(s2, hello({ features: ['accounts'], accounts: [acct('solo', 'Solo', { home: true })] })).accounts).toEqual([acct('solo', 'Solo', { home: true })]);
  });

  it('a malformed or empty list is no list; bad entries and repeats are dropped, a missing label is the id in capitals', () => {
    expect(accountListOf(undefined)).toBe(LEGACY_ACCOUNT_LIST);
    expect(accountListOf([])).toBe(LEGACY_ACCOUNT_LIST);
    expect(accountListOf('abc' as never)).toBe(LEGACY_ACCOUNT_LIST);
    expect(accountListOf([null, 3, { id: '' }, { id: 'x' }, { id: 'x', label: 'Twice' }, { id: 'y', label: 'Why', home: 'yes', retired: true }] as never)).toEqual([
      { id: 'x', label: 'X', home: false, retired: false },
      { id: 'y', label: 'Why', home: false, retired: true },
    ]);
  });
});

describe('labels and looks', () => {
  const names = uiAccounts(FIVE);

  it('a configured account shows its label, a retired one too; an id that is not configured shows as it is — never "undefined"', () => {
    expect(names.label('a')).toBe('Main');
    expect(names.label('old')).toBe('Old');
    expect(names.label('zz-gone')).toBe('zz-gone');
    expect(names.label('c')).toBe('c');
    expect(names.label('gpt')).toBe('GPT');
    expect(names.label('g1')).toBe('G1');
    for (const id of ['constructor', 'toString', '__proto__', 'x']) expect(seatLabel(FIVE, id)).toBe(id);
    expect(names.look('a')).toEqual({ slot: 0, kind: 'active' });
    expect(names.look('old')).toEqual({ slot: 2, kind: 'retired' });
    expect(names.look('zz-gone')).toEqual({ slot: null, kind: 'unknown' });
    expect(names.look('gpt')).toEqual({ slot: null, kind: 'other' });
    expect(names.look('g2')).toEqual({ slot: null, kind: 'other' });
    expect(names.has('old')).toBe(true);
    expect(names.has('zz-gone')).toBe(false);
    expect(names.isRetired('old')).toBe(true);
    expect(names.isRetired('zz-gone')).toBe(false);
  });

  it('palette slot: the position in the configured list (retired ones keep theirs), wrapping after eight', () => {
    expect(ACCOUNT_PALETTE_SIZE).toBe(8);
    expect(FIVE.map((a) => names.slot(a.id))).toEqual([0, 1, 2, 3, 4]);
    const ten = uiAccounts(Array.from({ length: 10 }, (_, i) => acct(`n${i}`)));
    expect(ten.all.map((a) => ten.slot(a.id))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0, 1]);
    expect(names.slot('zz-gone')).toBeNull();
    expect(names.slot('gpt')).toBeNull();
    expect(uiAccounts(LEGACY_ACCOUNT_LIST).all.map((a) => uiAccounts(LEGACY_ACCOUNT_LIST).slot(a.id))).toEqual([0, 1, 2]);
  });

  it('a retry note names both accounts by label, an unconfigured one by its id', () => {
    setFeatures(['accounts']);
    let s = server(initialState, hello({ features: ['accounts'], accounts: FIVE }));
    s = reducer(s, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
    s = server(s, { type: 'history', sessionId: 's1', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, messages: [], runningTurnId: null });
    s = server(s, { type: 'turn_started', turnId: 't1', sessionId: 's1', cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 1 });
    s = server(s, { type: 'turn_retry', turnId: 't1', sessionId: 's1', cwd: '/w', fromAccount: 'b', toAccount: 'zz-gone', reason: '한도', attempt: 1 });
    const notes = s.panes[0]!.items.flatMap((it) => (it.kind === 'assistant' ? it.notes : []));
    expect(notes).toEqual(['재시도 Work → zz-gone: 한도']);
  });

  it('a new session\'s stored pin on a fourth account survives a reload', () => {
    const ui = parseUi({ v: 1, panes: [{ session: { sessionId: null, cwd: '/w', title: 't', engine: 'claude' }, accountPin: 'team-2' }], active: 0, collapsed: [], drawer: false });
    expect(hydrate(initialState, ui).panes[0]!.session).toMatchObject({ accountPin: 'team-2' });
  });
});

describe('a pin on an account that cannot run a turn', () => {
  const stored = (pin: string): AppState => hydrate(initialState, parseUi({ v: 1, panes: [{ session: { sessionId: null, cwd: '/w', title: 't', engine: 'claude' }, accountPin: pin }], active: 0, collapsed: [], drawer: false }));
  const listed = (list: AccountInfo[]): ServerMessage => hello({ features: ['accounts'], accounts: list });
  const pin = (s: AppState) => s.panes[0]!.session?.accountPin;
  const notices = (s: AppState) => (s.panes[0]!.notices ?? []).map((n) => n.message);
  /** A pane on session s1 (account b) whose stored pin is `p`. */
  const onSession = (p: string): AppState => {
    let s = reducer(server(initialState, listed(FIVE)), { type: 'open', sessionId: 's1', cwd: '/w', title: '작업' });
    s = server(s, { type: 'history', sessionId: 's1', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, messages: [], runningTurnId: null });
    return server(s, { type: 'account_pin', sessionId: 's1', pin: p });
  };

  it('activePin: an active account of the list, nothing else', () => {
    expect(activePin(FIVE, 'd')).toBe('d');
    expect(activePin(FIVE, 'old')).toBeNull();
    expect(activePin(FIVE, 'c')).toBeNull();
    expect(activePin(FIVE, null)).toBeNull();
    expect(activePin(FIVE, undefined)).toBeNull();
  });

  it('a waiting pane (no session yet): hello with a list where its pin is retired or missing turns it to 자동 with one notice; an active pin stays', () => {
    setFeatures(['accounts']);
    let s = server(stored('team-2'), listed(FIVE));
    expect(pin(s)).toBe('team-2');
    expect(notices(s)).toEqual([]);
    // The list changes while the pane waits: team-2 is retired now.
    const later = FIVE.map((a) => (a.id === 'team-2' ? { ...a, retired: true } : a));
    s = server(s, listed(later));
    expect(pin(s)).toBeNull();
    expect(notices(s)).toEqual(['고정해 둔 계정(Team-2)을 지금 쓸 수 없어 자동으로 바꿨습니다']);
    s = server(s, listed(later));
    expect(notices(s)).toHaveLength(1);
    // Restored from localStorage, not in the server's list at all: the id itself in the notice.
    const gone = server(stored('zz'), listed(FIVE));
    expect(pin(gone)).toBeNull();
    expect(notices(gone)).toEqual(['고정해 둔 계정(zz)을 지금 쓸 수 없어 자동으로 바꿨습니다']);
  });

  it('an older server: a restored pin on a fourth account is dropped at its hello, one of a/b/c is kept', () => {
    expect(pin(stored('team-2'))).toBe('team-2');
    expect(pin(server(stored('team-2'), hello()))).toBeNull();
    const c = server(stored('c'), hello());
    expect(pin(c)).toBe('c');
    expect(notices(c)).toEqual([]);
  });

  it('an existing session keeps its pin whatever the list says (the server ignores it), without a notice', () => {
    setFeatures(['accounts']);
    let s = onSession('old');
    s = server(s, listed(FIVE));
    expect(pin(s)).toBe('old');
    s = server(s, listed([acct('a', 'Main', { home: true })]));
    expect(pin(s)).toBe('old');
    expect(notices(s)).toEqual([]);
  });

  it('a hello with the same list keeps the same array (nothing reading it re-renders); a changed one replaces it', () => {
    setFeatures(['accounts']);
    const s1 = server(initialState, listed(FIVE));
    const s2 = server(s1, listed(FIVE.map((a) => ({ ...a }))));
    expect(s2.accounts).toBe(s1.accounts);
    const s3 = server(s2, listed(FIVE.map((a) => (a.id === 'b' ? { ...a, label: 'Job' } : a))));
    expect(s3.accounts).not.toBe(s1.accounts);
    expect(uiAccounts(s3.accounts).label('b')).toBe('Job');
    expect(server(s3, listed([...FIVE].reverse())).accounts).not.toBe(s3.accounts);
    setFeatures(undefined);
    expect(server(initialState, hello()).accounts).toBe(initialState.accounts);
  });

  it('an edit branch carries the parent\'s pin only when it is an active account — in the pane and in the send', () => {
    setFeatures(['accounts']);
    const branch = (p: string) => {
      const s = onSession(p);
      const out: ClientMessage[] = [];
      startBranch(s.panes[0]!, 0, 'edited', '', () => {}, (m) => out.push(m), s.accounts);
      return { sent: out[0] as Extract<ClientMessage, { type: 'send' }>, pane: reducer(s, { type: 'branch_edit', n: 0, text: 'edited', clientRef: 'b1' }).panes[0]! };
    };
    const kept = branch('d');
    expect(kept.sent).toMatchObject({ sessionId: null, accountPin: 'd', branch: { from: 's1', n: 0 } });
    expect(kept.pane.session).toMatchObject({ sessionId: null, accountPin: 'd' });
    for (const p of ['old', 'zz']) {
      const dropped = branch(p);
      expect(dropped.sent).toMatchObject({ sessionId: null, branch: { from: 's1', n: 0 } });
      expect(dropped.sent).not.toHaveProperty('accountPin');
      expect(dropped.pane.session).not.toHaveProperty('accountPin');
    }
  });

  it('새 세션으로 이어가기 carries the pin the same way', () => {
    setFeatures(['accounts']);
    const badge = { account: 'b', model: 'opus' as const, reason: 'r', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }, modelNote: null };
    const handoff = (p: string) => {
      let s = reducer(onSession(p), { type: 'sent', text: HANDOFF_PROMPT, clientRef: 'h1', handoff: true });
      s = server(s, { type: 'turn_started', turnId: 'th', sessionId: 's1', cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0, clientRef: 'h1' });
      s = server(s, { type: 'delta', turnId: 'th', sessionId: 's1', cwd: '/w', text: '## 목표' });
      return server(s, { type: 'turn_result', turnId: 'th', sessionId: 's1', cwd: '/w', ok: true, text: '## 목표', badge, errorText: null }).panes[0]!.session!;
    };
    expect(handoff('d')).toMatchObject({ sessionId: null, accountPin: 'd' });
    expect(handoff('old').sessionId).toBeNull();
    expect(handoff('old')).not.toHaveProperty('accountPin');
    expect(handoff('zz')).not.toHaveProperty('accountPin');
  });
});
