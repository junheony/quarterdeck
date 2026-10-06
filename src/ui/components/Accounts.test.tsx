// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AccountInfo } from '../../shared/protocol';
import type { UsageHistory, UsageRow } from '../../shared/token-usage';
import type { UsageSnapshot } from '../../shared/usage-types';
import { AccountsContext, LEGACY_UI_ACCOUNTS, uiAccounts } from '../accounts';
import { setFeatures } from '../features';
import { newPane, type PaneState } from '../state';
import { Pane } from './Pane';
import { AccountPicker } from './AccountPicker';
import { TurnBadge } from './TurnBadge';
import { UsagePanel } from './UsagePanel';
import { UsageView, usageTabs } from './UsageView';

const acct = (id: string, label = id.toUpperCase(), extra: Partial<AccountInfo> = {}): AccountInfo => ({ id, label, home: false, retired: false, ...extra });
/** Five active accounts and a retired one. */
const SIX: AccountInfo[] = [acct('a', 'Main'), acct('b', 'Work', { home: true }), acct('old', 'Old', { retired: true }), acct('d'), acct('team-2', 'Team-2'), acct('p', 'Personal')];
const ONE: AccountInfo[] = [acct('solo', 'Solo', { home: true })];
const With = ({ list, children }: { list: AccountInfo[]; children: ReactNode }) => <AccountsContext value={uiAccounts(list)}>{children}</AccountsContext>;
const w = (usedPct: number) => ({ usedPct, resetsAt: null });
/** A partial snapshot: only a and d have a card. */
const usage: UsageSnapshot = {
  generatedAt: 'x', deckReachable: true,
  accounts: { a: { status: 'ok', fetchedAt: null, fiveHour: w(10), weekly: w(20), fable: null }, d: { status: 'ok', fetchedAt: null, fiveHour: w(60), weekly: w(5), fable: null }, old: { status: 'ok', fetchedAt: null, fiveHour: w(1), weekly: w(1), fable: null } },
};
const cards = () => [...document.querySelectorAll('.usage-card')].map((c) => c.querySelector('.usage-letter')!.textContent);

afterEach(() => { cleanup(); setFeatures(undefined); });

describe('UsagePanel with any number of accounts', () => {
  it('one account: its card and GPT, the full card (no compact layout), two grid columns', () => {
    render(<With list={ONE}><UsagePanel usage={{ ...usage, accounts: {} }} current="solo" now={0} /></With>);
    expect(cards()).toEqual(['Solo', 'GPT']);
    const panel = document.querySelector<HTMLElement>('.usage-panel')!;
    expect(panel.style.getPropertyValue('--usage-cards')).toBe('2');
    expect(panel.hasAttribute('data-dense')).toBe(false);
    expect(screen.getByTestId('account-solo').className).toContain('current');
    // No card in the snapshot for it: empty values, not a crash.
    expect(screen.getByTestId('solo-fiveHour').textContent).toContain('—');
  });

  it('five active accounts: a card each in configured order (the retired one has none) and GPT, compact, six columns', () => {
    render(<With list={SIX}><UsagePanel usage={usage} current="d" now={0} /></With>);
    expect(cards()).toEqual(['Main', 'Work', 'D', 'Team-2', 'Personal', 'GPT']);
    const panel = document.querySelector<HTMLElement>('.usage-panel')!;
    expect(panel.style.getPropertyValue('--usage-cards')).toBe('6');
    expect(panel.hasAttribute('data-dense')).toBe(true);
    expect(screen.queryByTestId('account-old')).toBeNull();
    expect(screen.getByTestId('a-fiveHour').textContent).toContain('90%');
    expect(screen.getByTestId('d-weekly').textContent).toContain('95%');
    // Accounts the snapshot does not carry read as empty.
    expect(screen.getByTestId('b-fiveHour').textContent).toContain('—');
    expect(screen.getByTestId('team-2-weekly').textContent).toContain('—');
    expect(screen.getByTestId('account-d').className).toContain('current');
    expect(document.body.textContent).not.toContain('undefined');
  });

  it('seven cards and more wrap into two rows on a phone: data-wrap and the columns of one row; up to six stay in one', () => {
    const eight = Array.from({ length: 8 }, (_, i) => acct(`n${i}`));
    render(<With list={eight}><UsagePanel usage={{ ...usage, accounts: {} }} current={null} now={0} /></With>);
    let panel = document.querySelector<HTMLElement>('.usage-panel')!;
    expect(panel.style.getPropertyValue('--usage-cards')).toBe('9');
    expect(panel.hasAttribute('data-wrap')).toBe(true);
    expect(panel.style.getPropertyValue('--usage-cols-wrap')).toBe('5');
    cleanup();
    render(<With list={eight.slice(0, 6)}><UsagePanel usage={{ ...usage, accounts: {} }} current={null} now={0} /></With>);
    panel = document.querySelector<HTMLElement>('.usage-panel')!;
    expect(panel.hasAttribute('data-wrap')).toBe(true);
    expect(panel.style.getPropertyValue('--usage-cols-wrap')).toBe('4');
    cleanup();
    render(<With list={eight.slice(0, 5)}><UsagePanel usage={{ ...usage, accounts: {} }} current={null} now={0} /></With>);
    panel = document.querySelector<HTMLElement>('.usage-panel')!;
    expect(panel.hasAttribute('data-dense')).toBe(true);
    expect(panel.hasAttribute('data-wrap')).toBe(false);
    expect(panel.style.getPropertyValue('--usage-cols-wrap')).toBe('');
  });

  it('the default list (no provider): A, B, C, GPT as four columns in the full layout', () => {
    render(<UsagePanel usage={usage} current={null} now={0} />);
    expect(cards()).toEqual(['A', 'B', 'C', 'GPT']);
    const panel = document.querySelector<HTMLElement>('.usage-panel')!;
    expect(panel.style.getPropertyValue('--usage-cards')).toBe('4');
    expect(panel.hasAttribute('data-dense')).toBe(false);
  });
});

describe('AccountPicker with the configured accounts', () => {
  const names = () => within(screen.getByTestId('account-menu')).getAllByRole('menuitemradio').map((b) => b.querySelector('.mp-name')?.textContent);

  it('lists the active accounts only, by label, (Desktop) on the home one; picks report the id', () => {
    const onPin = vi.fn();
    render(<With list={SIX}><AccountPicker pin={null} current="team-2" usage={usage} onPin={onPin} /></With>);
    expect(screen.getByTestId('account-picker').textContent).toContain('자동 · Team-2');
    fireEvent.click(screen.getByTestId('account-picker'));
    expect(names()).toEqual(['자동', 'Main', 'Work (Desktop)', 'D', 'Team-2', 'Personal']);
    const items = within(screen.getByTestId('account-menu')).getAllByRole('menuitemradio');
    expect(items[1]!.textContent).toContain('5h 10% · 주간 20%');
    expect(items[2]!.textContent).toContain('5h —% · 주간 —%');
    fireEvent.click(items[4]!);
    expect(onPin).toHaveBeenCalledWith('team-2');
  });

  it('one account: 자동 and that account', () => {
    render(<With list={ONE}><AccountPicker pin="solo" current="solo" usage={null} onPin={() => {}} /></With>);
    expect(screen.getByTestId('account-picker').getAttribute('aria-label')).toBe('계정: Solo (Desktop) 고정');
    fireEvent.click(screen.getByTestId('account-picker'));
    expect(names()).toEqual(['자동', 'Solo (Desktop)']);
  });

  it('a session on a retired account or on an id that is not configured: label dimmed / the id in grey, neither offered as a pin', () => {
    const { unmount } = render(<With list={SIX}><AccountPicker pin={null} current="old" usage={null} onPin={() => {}} /></With>);
    const btn = screen.getByTestId('account-picker');
    expect(btn.textContent).toContain('자동 · Old');
    expect(btn.querySelector('.acct-retired')).not.toBeNull();
    unmount();
    render(<With list={SIX}><AccountPicker pin={null} current="c" usage={null} onPin={() => {}} /></With>);
    const gone = screen.getByTestId('account-picker');
    expect(gone.textContent).toContain('자동 · c');
    expect(gone.textContent).not.toContain('undefined');
    expect(gone.querySelector('.acct-unknown')).not.toBeNull();
    fireEvent.click(gone);
    expect(names()).not.toContain('Old');
    expect(names()).not.toContain('c');
  });

  it('a pin on a retired account or on an id that is not configured: drawn as such and said in words (it works as 자동)', () => {
    const { unmount } = render(<With list={SIX}><AccountPicker pin="old" current="a" usage={null} onPin={() => {}} /></With>);
    const btn = screen.getByTestId('account-picker');
    expect(btn.textContent).toContain('Old');
    expect(btn.querySelector('.mp-acct.acct-retired')).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('계정: Old (뺀 계정 — 자동으로 동작) 고정');
    expect(btn.querySelector<HTMLElement>('.mp-acct')!.title).toBe('Old (뺀 계정 — 자동으로 동작)');
    unmount();
    render(<With list={SIX}><AccountPicker pin="zz" current={null} usage={null} onPin={() => {}} /></With>);
    const gone = screen.getByTestId('account-picker');
    expect(gone.textContent).toContain('zz');
    expect(gone.querySelector('.mp-acct.acct-unknown')).not.toBeNull();
    expect(gone.getAttribute('aria-label')).toBe('계정: zz (설정에 없는 계정 — 자동으로 동작) 고정');
  });

  it('an active pin and an automatic account read as before; a current retired / unknown one is said in the label', () => {
    const label = (pin: string | null, current: string | null) => {
      cleanup();
      render(<With list={SIX}><AccountPicker pin={pin} current={current} usage={null} onPin={() => {}} /></With>);
      return screen.getByTestId('account-picker');
    };
    expect(label('d', 'a').getAttribute('aria-label')).toBe('계정: D 고정');
    expect(label('d', 'a').querySelector('.acct-retired, .acct-unknown')).toBeNull();
    expect(label('b', null).getAttribute('aria-label')).toBe('계정: Work (Desktop) 고정');
    expect(label(null, 'team-2').getAttribute('aria-label')).toBe('계정: 자동 · Team-2');
    expect(label(null, null).getAttribute('aria-label')).toBe('계정: 자동');
    expect(label(null, 'old').getAttribute('aria-label')).toBe('계정: 자동 · Old (뺀 계정)');
    expect(label(null, 'c').getAttribute('aria-label')).toBe('계정: 자동 · c (설정에 없는 계정)');
    // The name is its own element (it is what gets cut when long); its title carries the whole of it.
    expect(label('p', null).querySelector<HTMLElement>('.mp-acct')!.textContent).toBe('Personal');
    expect(label('p', null).querySelector<HTMLElement>('.mp-acct')!.title).toBe('Personal');
  });
});

describe('a session whose account cannot run a turn', () => {
  const on = (account: string, sessionId: string | null = 's1'): PaneState => ({ ...newPane('p1'), session: { sessionId, cwd: '/w', account, title: 't', engine: 'claude', sandbox: null } });
  const note = (pane: PaneState, list: AccountInfo[] | null = SIX) => {
    cleanup();
    const el = <Pane pane={pane} app={{ pending: [], questions: [], codexAvailable: false }} active closable={false} dispatch={() => {}} send={() => {}} onClose={() => {}} />;
    render(list ? <With list={list}>{el}</With> : el);
    return screen.queryByTestId('composer-note');
  };

  it('a line above the input says it cannot be continued — retired and unconfigured apart; an active account has none', () => {
    setFeatures(['accounts']);
    expect(note(on('old'))!.textContent).toBe('뺀 계정의 세션이라 이어 쓸 수 없습니다 — 기록은 볼 수 있습니다');
    expect(note(on('c'))!.textContent).toBe('설정에 없는 계정의 세션이라 이어 쓸 수 없습니다');
    expect(note(on('d'))).toBeNull();
    expect(note(on('gpt'))).toBeNull();
    expect(note(on('g1'))).toBeNull();
    // The input stays usable (the server answers the send).
    note(on('old'));
    expect((screen.getByPlaceholderText(/메시지/) as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('not for a session without an id yet, and not on a server that does not list its accounts (its sessions resume as before)', () => {
    setFeatures(['accounts']);
    expect(note(on('old', null))).toBeNull();
    setFeatures(undefined);
    expect(note(on('d'), null)).toBeNull();
    expect(note(on('zz'), null)).toBeNull();
  });
});

describe('TurnBadge account tile', () => {
  const badge = (account: string) => ({ account, model: 'opus' as const, reason: 'r', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, modelNote: null });
  const tile = (account: string, list: AccountInfo[] | null = SIX) => {
    cleanup();
    render(list ? <With list={list}><TurnBadge badge={badge(account)} /></With> : <TurnBadge badge={badge(account)} />);
    return document.querySelector<HTMLElement>('.turn-badge .acct')!;
  };

  it('a configured account: its label, coloured by its position in the list', () => {
    const t = tile('team-2');
    expect(t.textContent).toBe('Team-2');
    expect(t.getAttribute('data-acct-idx')).toBe('4');
    expect(t.className).toBe('acct acct-active');
    expect(t.title).toBe('계정 Team-2');
    expect(tile('a').getAttribute('data-acct-idx')).toBe('0');
  });

  it('a retired account: its label, dimmed; an id that is not configured: the id itself in grey, no palette colour, never "undefined"', () => {
    const old = tile('old');
    expect(old.textContent).toBe('Old');
    expect(old.className).toContain('acct-retired');
    expect(old.getAttribute('data-acct-idx')).toBe('2');
    expect(old.title).toContain('뺀 계정');
    const gone = tile('zz-gone');
    expect(gone.textContent).toBe('zz-gone');
    expect(gone.className).toBe('acct acct-unknown');
    expect(gone.hasAttribute('data-acct-idx')).toBe(false);
    expect(gone.title).toBe('계정 zz-gone · 설정에 없는 계정');
    expect(document.body.textContent).not.toContain('undefined');
  });

  it('GPT and Gemini keep their own tiles; the default list draws a/b/c in slots 0/1/2', () => {
    expect(tile('gpt').className).toBe('acct acct-gpt');
    expect(tile('gpt').hasAttribute('data-acct-idx')).toBe(false);
    expect(tile('g1').className).toBe('acct acct-g1');
    expect(['a', 'b', 'c'].map((a) => [tile(a, null).textContent, tile(a, null).getAttribute('data-acct-idx')])).toEqual([['A', '0'], ['B', '1'], ['C', '2']]);
  });
});

describe('account palette (styles.css)', () => {
  const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
  const part = css.slice(css.indexOf('/* === accounts (any number) === */'));

  it('eight slots, the first three the accent a/b/c always had; the light theme has its own later hues (both selectors)', () => {
    expect(part).toMatch(/--acct-0: var\(--accent\); --acct-1: var\(--accent\); --acct-2: var\(--accent\);/);
    for (let i = 0; i < 8; i++) {
      expect(part).toContain(`--acct-${i}:`);
      expect(part).toContain(`[data-acct-idx="${i}"] { --acct: var(--acct-${i}); }`);
    }
    expect(part).not.toContain('--acct-8');
    expect(part).toMatch(/:root\[data-theme="light"\] \{[^}]*--acct-3:[^}]*--acct-7:/);
    expect(part).toMatch(/@media \(prefers-color-scheme: light\) \{ :root:not\(\[data-theme="dark"\]\) \{[^}]*--acct-3:[^}]*--acct-7:/);
    expect(css).not.toMatch(/\.acct-[abc]\b/);
  });

  it('the tile and the card label take a longer label: min-width and padding, not a fixed width', () => {
    const tile = [...css.matchAll(/\.turn-badge \.acct \{[^}]*\}/g)].map((m) => m[0]).find((r) => r.includes('height'))!;
    expect(tile).toMatch(/min-width: 20px/);
    expect(tile).toMatch(/padding: 0 4px/);
    expect(tile).not.toMatch(/[^-]width: 20px/);
    expect(css).toMatch(/\.usage-panel \{[^}]*grid-template-columns: repeat\(var\(--usage-cards, 4\), minmax\(0,/);
  });

  it('a long label is cut at 12 characters in the badge and in the picker (the whole of it is in the title)', () => {
    expect(part).toMatch(/\.turn-badge \.acct-name \{[^}]*max-width: 12ch;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/);
    expect(part).toMatch(/\.mp-acct \{[^}]*max-width: 12ch;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/);
    render(<With list={[acct('long', 'A-very-long-account-label-of-forty-chars')]}><TurnBadge badge={{ account: 'long', model: 'opus', reason: 'r', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, modelNote: null }} /></With>);
    const tile = document.querySelector<HTMLElement>('.turn-badge .acct')!;
    expect(tile.querySelector('.acct-name')!.textContent).toBe('A-very-long-account-label-of-forty-chars');
    expect(tile.title).toBe('계정 A-very-long-account-label-of-forty-chars');
  });

  it('retired / not configured: the muted text colour and a dashed line, never opacity (it would take the text under 4.5:1)', () => {
    const rules = [...part.matchAll(/[^{}]*\.acct-(?:retired|unknown)[^{}]*\{[^}]*\}/g)].map((m) => m[0]);
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r).not.toMatch(/opacity/);
    expect(rules.some((r) => /color: var\(--muted\)/.test(r))).toBe(true);
    expect(rules.some((r) => /dashed/.test(r))).toBe(true);
  });

  it('the compact card keeps its mark-then-number columns for up to four cards (as before); only five and more put the label first', () => {
    expect(css).toMatch(/@media \(max-width: 1100px\) \{\s*\.usage-card \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\);/);
    expect(part).not.toMatch(/@media \(max-width: 1100px\) \{\s*\.usage-card \{/);
    expect(css).toMatch(/@media \(max-width: 720px\) \{[^@]*\.usage-panel\[data-wrap\] \.usage-card \{ flex: 1 1 calc\(100% \/ var\(--usage-cols-wrap\) - 5px\);/);
  });
});

describe('usageTabs', () => {
  const row = (source: string): UsageRow => ({ day: '2026-10-02', source, family: 'opus', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, messages: 1 });
  const names = uiAccounts([acct('a'), acct('b', 'Work'), acct('old', 'Old', { retired: true }), acct('d')]);

  it('right after the server starts (sources: codex only, no rows) the account tabs are already there', () => {
    expect(usageTabs(names, { sources: ['codex'], rows: [] })).toEqual(['all', 'a', 'b', 'd', 'codex']);
    expect(usageTabs(names, null)).toEqual(['all', 'a', 'b', 'd', 'codex']);
    expect(usageTabs(LEGACY_UI_ACCOUNTS, { sources: ['codex'], rows: [] })).toEqual(['all', 'a', 'b', 'c', 'codex']);
  });

  it('an id that is not configured and only named in sources (no rows) has no tab; with rows it has one, after the configured ones', () => {
    expect(usageTabs(names, { sources: ['a', 'b', 'c', 'codex'], rows: [row('all'), row('a')] })).toEqual(['all', 'a', 'b', 'd', 'codex']);
    expect(usageTabs(names, { sources: ['a', 'b', 'c', 'codex'], rows: [row('all'), row('c'), row('a')] })).toEqual(['all', 'a', 'b', 'd', 'c', 'codex']);
  });

  it('a retired account has a tab only when it has rows, at its configured place; several unknown ids follow the order of sources', () => {
    expect(usageTabs(names, { sources: ['a', 'old', 'codex'], rows: [row('a')] })).toEqual(['all', 'a', 'b', 'd', 'codex']);
    expect(usageTabs(names, { sources: ['a', 'old', 'codex'], rows: [row('old')] })).toEqual(['all', 'a', 'b', 'old', 'd', 'codex']);
    expect(usageTabs(names, { sources: ['zz', 'c', 'codex'], rows: [row('c'), row('zz'), row('codex')] })).toEqual(['all', 'a', 'b', 'd', 'zz', 'c', 'codex']);
  });

  it('an older server (no sources field): the active accounts and whatever has rows', () => {
    expect(usageTabs(names, { rows: [] })).toEqual(['all', 'a', 'b', 'd', 'codex']);
    expect(usageTabs(names, { rows: [row('all'), row('c'), row('old'), row('codex')] })).toEqual(['all', 'a', 'b', 'old', 'd', 'c', 'codex']);
    expect(usageTabs(LEGACY_UI_ACCOUNTS, { rows: [row('all'), row('a')] })).toEqual(['all', 'a', 'b', 'c', 'codex']);
  });

  it('UsageView draws them with the common labels: retired = label (dimmed), unknown = the id (grey), GPT last', async () => {
    const body: UsageHistory = { generatedAt: 'x', days: 84, lastScanAt: null, scanning: false, sources: ['a', 'b', 'c', 'codex'], rows: [row('all'), row('c'), row('old')] };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    render(<AccountsContext value={names}><UsageView onClose={() => {}} fetchFn={fetchFn} now={new Date(2026, 9, 2, 12)} /></AccountsContext>);
    // Before the answer: the configured accounts.
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['합계', 'A', 'Work', 'D', 'GPT']);
    await waitFor(() => expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['합계', 'A', 'Work', 'Old', 'D', 'c', 'GPT']));
    // The state in words too (colour alone does not say it).
    const old = screen.getByRole('tab', { name: 'Old (뺀 계정)' });
    expect(old.className).toContain('acct-retired');
    expect(old.title).toBe('Old (뺀 계정)');
    const gone = screen.getByRole('tab', { name: 'c (설정에 없는 계정)' });
    expect(gone.className).toContain('acct-unknown');
    expect(gone.title).toBe('c (설정에 없는 계정)');
    expect(screen.getByRole('tab', { name: 'Work' }).hasAttribute('title')).toBe(false);
    expect(screen.getByRole('tab', { name: 'Work' }).className).not.toContain('acct-');
  });

  it('the picked tab leaves with its rows: 합계 is shown meanwhile, and the pick is back when the tab is', async () => {
    const body = (rows: UsageRow[]): UsageHistory => ({ generatedAt: 'x', days: 84, lastScanAt: null, scanning: false, sources: ['a', 'b', 'c', 'codex'], rows });
    const answers = [body([row('all'), row('c')]), body([row('all')]), body([row('all'), row('c')])];
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(answers.shift()), { status: 200 })) as unknown as typeof fetch;
    render(<AccountsContext value={names}><UsageView onClose={() => {}} fetchFn={fetchFn} now={new Date(2026, 9, 2, 12)} /></AccountsContext>);
    const on = () => screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent);
    const tabs = () => screen.getAllByRole('tab').map((t) => t.textContent);
    await waitFor(() => expect(tabs()).toContain('c'));
    fireEvent.click(screen.getByRole('tab', { name: 'c (설정에 없는 계정)' }));
    expect(on()).toEqual(['c']);
    expect(screen.queryByText(/합계는 여러 계정에 복사된/)).toBeNull();
    fireEvent.click(screen.getByText('새로고침'));
    await waitFor(() => expect(tabs()).not.toContain('c'));
    expect(on()).toEqual(['합계']);
    expect(screen.getByText(/합계는 여러 계정에 복사된/)).toBeTruthy();
    fireEvent.click(screen.getByText('새로고침'));
    await waitFor(() => expect(tabs()).toContain('c'));
    expect(on()).toEqual(['c']);
  });
});
