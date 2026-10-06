// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useReducer } from 'react';
import type { ClientMessage, ServerMessage } from '../../shared/protocol';
import { emptySnapshot, type UsageSnapshot } from '../../shared/usage-types';
import { initialState, reducer, type AppState } from '../state';
import { AccountPicker } from './AccountPicker';
import { Pane } from './Pane';
import { TurnBadge } from './TurnBadge';

Element.prototype.scrollIntoView = () => {};

function usage(): UsageSnapshot {
  const u = emptySnapshot(new Date('2026-10-02T00:00:00Z'), ['a', 'b', 'c']);
  const w = (usedPct: number) => ({ usedPct, resetsAt: null });
  u.accounts.a = { ...u.accounts.a!, status: 'ok', fiveHour: w(12), weekly: w(70) };
  u.accounts.b = { ...u.accounts.b!, status: 'ok', fiveHour: w(40), weekly: w(60) };
  return u;
}

describe('AccountPicker', () => {
  afterEach(cleanup);

  it('shows 자동 · current letter, lists 자동 / A (Desktop) / B / C with their 5h and weekly %, reports the pick', () => {
    const onPin = vi.fn();
    render(<AccountPicker pin={null} current="b" usage={usage()} onPin={onPin} />);
    expect(screen.getByTestId('account-picker').textContent).toContain('자동 · B');
    expect(screen.queryByTestId('account-menu')).toBeNull();
    fireEvent.click(screen.getByTestId('account-picker'));
    const items = within(screen.getByTestId('account-menu')).getAllByRole('menuitemradio');
    expect(items.map((b) => b.querySelector('.mp-name')?.textContent)).toEqual(['자동', 'A (Desktop)', 'B', 'C']);
    expect(items[0]!.getAttribute('aria-checked')).toBe('true');
    expect(items[1]!.textContent).toContain('5h 12% · 주간 70%');
    expect(items[2]!.textContent).toContain('5h 40% · 주간 60%');
    expect(items[3]!.textContent).toContain('5h —% · 주간 —%');
    fireEvent.click(items[2]!);
    expect(onPin).toHaveBeenCalledWith('b');
    expect(screen.queryByTestId('account-menu')).toBeNull();
  });

  it('pinned: the button shows the pinned letter; choosing 자동 clears it; re-choosing the same pin does nothing', () => {
    const onPin = vi.fn();
    render(<AccountPicker pin="a" current="b" usage={null} onPin={onPin} />);
    const btn = screen.getByTestId('account-picker');
    expect(btn.textContent).toContain('A');
    expect(btn.textContent).not.toContain('자동');
    expect(btn.getAttribute('aria-label')).toBe('계정: A (Desktop) 고정');
    fireEvent.click(btn);
    fireEvent.click(within(screen.getByTestId('account-menu')).getByText('A (Desktop)'));
    expect(onPin).not.toHaveBeenCalled();
    fireEvent.click(btn);
    fireEvent.click(within(screen.getByTestId('account-menu')).getByText('자동'));
    expect(onPin).toHaveBeenCalledWith(null);
  });

  it('turn badge shows a pin marker only when the account came from the pin', () => {
    const badge = { account: 'b' as const, model: 'opus' as const, reason: '고정 B', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, modelNote: null };
    const { rerender } = render(<TurnBadge badge={{ ...badge, pinned: true }} />);
    expect(screen.getByTestId('badge-pin')).toBeTruthy();
    rerender(<TurnBadge badge={badge} />);
    expect(screen.queryByTestId('badge-pin')).toBeNull();
  });
});

describe('Pane · account pin', () => {
  afterEach(cleanup);

  function harness(s0: AppState, frames: ClientMessage[]) {
    let dispatchRef!: (a: Parameters<typeof reducer>[1]) => void;
    function Harness() {
      const [state, dispatch] = useReducer(reducer, s0);
      dispatchRef = dispatch;
      return <Pane pane={state.panes[0]!} app={state} active closable={false} dispatch={dispatch} send={(m) => frames.push(m)} onClose={() => {}} />;
    }
    render(<Harness />);
    return (m: ServerMessage) => act(() => dispatchRef({ type: 'server', msg: m }));
  }

  it('a new session sends its pin with the first turn; an existing one sends set_account_pin and follows the server', () => {
    const frames: ClientMessage[] = [];
    harness({ ...reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'n' }), usage: usage() }, frames);
    fireEvent.click(screen.getByTestId('account-picker'));
    fireEvent.click(within(screen.getByTestId('account-menu')).getByText('B'));
    expect(frames).toEqual([]);
    fireEvent.change(screen.getByPlaceholderText(/메시지/), { target: { value: 'hi' } });
    fireEvent.click(screen.getByText('보내기'));
    expect(frames[0]).toMatchObject({ type: 'send', sessionId: null, accountPin: 'b' });
    cleanup();

    const frames2: ClientMessage[] = [];
    const server = harness(reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' }), frames2);
    server({ type: 'history', sessionId: 's1', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, accountPin: 'c', messages: [], runningTurnId: null });
    expect(screen.getByTestId('account-picker').textContent).toContain('C');
    fireEvent.click(screen.getByTestId('account-picker'));
    fireEvent.click(within(screen.getByTestId('account-menu')).getByText('자동'));
    expect(frames2).toEqual([{ type: 'set_account_pin', sessionId: 's1', pin: null }]);
    expect(screen.getByTestId('account-picker').textContent).toContain('자동 · B');
    // Another device pinned it: every pane on the session follows the broadcast.
    server({ type: 'account_pin', sessionId: 's1', pin: 'a' });
    expect(screen.getByTestId('account-picker').getAttribute('aria-label')).toBe('계정: A (Desktop) 고정');
    fireEvent.change(screen.getByPlaceholderText(/메시지/), { target: { value: 'go' } });
    fireEvent.click(screen.getByText('보내기'));
    expect(frames2.at(-1)).not.toHaveProperty('accountPin');
  });

  it('no picker on GPT sessions', () => {
    const s = reducer(initialState, { type: 'open', sessionId: 'g1', cwd: '/w', title: 't' });
    const server = harness({ ...s, codexAvailable: true }, []);
    server({ type: 'history', sessionId: 'g1', cwd: '/w', account: 'gpt', engine: 'codex', sandbox: 'read-only', messages: [], runningTurnId: null });
    expect(screen.queryByTestId('account-picker')).toBeNull();
  });
});

describe('Pane · composer draft per session', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(cleanup);

  it('switching the pane to another session shows that session\'s draft, not the previous one\'s', () => {
    let dispatchRef!: (a: Parameters<typeof reducer>[1]) => void;
    function Harness() {
      const [state, dispatch] = useReducer(reducer, reducer(initialState, { type: 'open', sessionId: 'sA', cwd: '/w', title: 'A' }));
      dispatchRef = dispatch;
      return <Pane pane={state.panes[0]!} app={state} active closable={false} dispatch={dispatch} send={() => {}} onClose={() => {}} />;
    }
    render(<Harness />);
    const box = () => screen.getByPlaceholderText(/메시지/) as HTMLTextAreaElement;
    fireEvent.change(box(), { target: { value: 'draft for A' } });
    act(() => dispatchRef({ type: 'open', sessionId: 'sB', cwd: '/w', title: 'B' }));
    expect(box().value).toBe('');
    expect(sessionStorage.getItem('deck.draft.sB')).toBeNull();
    fireEvent.change(box(), { target: { value: 'draft for B' } });
    act(() => dispatchRef({ type: 'open', sessionId: 'sA', cwd: '/w', title: 'A' }));
    expect(box().value).toBe('draft for A');
    act(() => dispatchRef({ type: 'open', sessionId: 'sB', cwd: '/w', title: 'B' }));
    expect(box().value).toBe('draft for B');
  });
});
