// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UsagePanel, countdown, creditsText, resetStamp } from './UsagePanel';
import type { UsageSnapshot } from '../../shared/usage-types';

const NOW = Date.parse('2026-09-30T12:30:00Z');
const usage: UsageSnapshot = {
  generatedAt: 'x',
  deckReachable: false,
  accounts: {
    a: { status: 'stale', fetchedAt: null, fiveHour: { usedPct: 13, resetsAt: new Date(NOW + 2.5 * 3_600_000).toISOString() }, weekly: { usedPct: 7, resetsAt: null }, fable: { usedPct: 0, resetsAt: null } },
    b: { status: 'ok', fetchedAt: null, fiveHour: { usedPct: 82, resetsAt: null }, weekly: { usedPct: 3, resetsAt: null }, fable: null },
    c: { status: 'ok', fetchedAt: null, fiveHour: { usedPct: 0, resetsAt: null }, weekly: { usedPct: 96, resetsAt: null }, fable: { usedPct: 27, resetsAt: null } },
  },
};

describe('UsagePanel', () => {
  it('shows remaining % per window, warn/danger classes, current highlight, countdown, stale tag', () => {
    render(<UsagePanel usage={usage} current="b" now={NOW} />);
    expect(screen.getByTestId('a-fiveHour').textContent).toContain('87%');
    expect(screen.getByTestId('a-fiveHour').textContent).toContain('2시간 30분');
    expect(screen.getByTestId('b-fiveHour').className).toContain('warn');
    expect(screen.getByTestId('c-weekly').className).toContain('danger');
    expect(screen.getByTestId('b-fable').textContent).toContain('—');
    expect(screen.getByTestId('account-b').className).toContain('current');
    expect(screen.getByTestId('account-a').className).not.toContain('current');
    expect(screen.getByText('오래된 값')).toBeTruthy();
  });

  it('renders a placeholder without data', () => {
    render(<UsagePanel usage={null} current={null} />);
    expect(screen.getByText('잔여량 불러오는 중…')).toBeTruthy();
  });

  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('countdown reads a zone-less reset time as UTC', () => {
    expect(countdown('2026-09-30T14:30:00', NOW)).toBe('2시간 0분 후 리셋');
  });

  it('without a fixed now, the countdown ticks every 30 s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const u: UsageSnapshot = { ...usage, accounts: { ...usage.accounts, a: { ...usage.accounts.a!, fiveHour: { usedPct: 13, resetsAt: new Date(NOW + 2 * 3_600_000).toISOString() } } } };
    render(<UsagePanel usage={u} current={null} />);
    expect(screen.getByTestId('a-fiveHour').textContent).toContain('2시간 0분');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId('a-fiveHour').textContent).toContain('1시간 59분');
  });

  it('GPT column: weekly remaining when the card is ok, — with a hint when unknown, highlighted when current', () => {
    const withGpt: UsageSnapshot = { ...usage, gpt: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: { usedPct: 40, resetsAt: null }, fable: null } };
    render(<UsagePanel usage={withGpt} current="gpt" now={NOW} />);
    expect(screen.getByTestId('gpt-weekly').textContent).toContain('60%');
    expect(screen.getByTestId('gpt-weekly').title).toContain('60% 남음');
    expect(screen.getByTestId('account-gpt').className).toContain('current');
    expect(screen.getByTestId('account-gpt').querySelector('svg.usage-mark.gpt')).toBeTruthy();
    expect(screen.getByTestId('account-gpt').querySelector('.usage-dot')).toBeTruthy();
    expect(screen.getByTestId('gpt-fiveHour').textContent).toContain('—');
    expect(screen.queryByTestId('gpt-credits')).toBeNull();
    cleanup();
    render(<UsagePanel usage={usage} current={null} now={NOW} />);
    expect(screen.getByTestId('gpt-weekly').textContent).toContain('—');
    expect(screen.getByTestId('account-gpt').title).toContain('usage-deck');
  });
});

describe('UsagePanel exhausted window', () => {
  afterEach(cleanup);
  it('a window at 0% collapses into a muted 소진 pill with the absolute reset time instead of 0%', () => {
    const resetsAt = new Date(NOW + 3 * 86_400_000).toISOString();
    const withGpt: UsageSnapshot = { ...usage, gpt: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: { usedPct: 100, resetsAt }, fable: null } };
    render(<UsagePanel usage={withGpt} current={null} now={NOW} />);
    const w = screen.getByTestId('gpt-weekly');
    expect(w.className).toContain('danger');
    expect(w.textContent).not.toContain('0%');
    expect(w.querySelector('.usage-bar')).toBeNull();
    expect(w.querySelector('.usage-pill')!.textContent).toBe(`소진 · ${resetStamp(resetsAt)}`);
    expect(w.textContent).toContain('주간');
    expect(resetStamp(resetsAt)).toMatch(/^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
    fireEvent.click(screen.getByTestId('account-gpt'));
    expect(screen.getByRole('tooltip').textContent).toContain('주간 한도 소진');
    expect(screen.getByRole('tooltip').textContent).toContain(`${resetStamp(resetsAt)} 리셋`);
  });

  it('spent weekly with credits shows a 크레딧 line with the whole balance; unlimited and no-credits cases', () => {
    const resetsAt = new Date(NOW + 3 * 86_400_000).toISOString();
    const withCredits: UsageSnapshot = { ...usage, gpt: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: { usedPct: 100, resetsAt }, fable: null, credits: { hasCredits: true, unlimited: false, balance: 49563.32 } } };
    render(<UsagePanel usage={withCredits} current={null} now={NOW} />);
    expect(screen.getByTestId('gpt-credits').textContent).toBe('크레딧49,563');
    expect(screen.getByTestId('gpt-weekly').querySelector('.usage-pill')).toBeTruthy();
    expect(screen.getByTestId('gpt-fiveHour').textContent).toContain('—');
    expect(creditsText({ hasCredits: true, unlimited: true, balance: null })).toBe('무제한');
    expect(creditsText({ hasCredits: false, unlimited: false, balance: 12 })).toBeNull();
    expect(creditsText({ hasCredits: true, unlimited: false, balance: null })).toBeNull();
    expect(creditsText(undefined)).toBeNull();
  });
});

describe('UsagePanel chips', () => {
  afterEach(cleanup);
  it('each window has a bar sized to the remaining %, and a tap opens a popover with the reset times', () => {
    render(<UsagePanel usage={usage} current="b" now={NOW} />);
    const bar = screen.getByTestId('a-fiveHour').querySelector('.usage-bar > i') as HTMLElement;
    expect(bar.style.width).toBe('87%');
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(screen.getByTestId('account-a'));
    const pop = screen.getByRole('tooltip');
    expect(pop.textContent).toContain('2시간 30분 후 리셋');
    expect(pop.textContent).toContain('리셋 시각 없음');
    expect(screen.getByTestId('account-a').querySelector('svg.usage-mark.claude.claude-mark')).not.toBeNull();
    expect(screen.getByTestId('account-a').textContent).not.toContain('✳');
    expect(screen.getByTestId('account-b').querySelector('.usage-dot')).toBeTruthy();
    expect(screen.getByTestId('account-a').querySelector('.usage-dot')).toBeNull();
    fireEvent.click(screen.getByTestId('account-a'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('UsagePanel header layout (styles.css)', () => {
  // Layout itself was checked by hand in a real browser (320–1600px wide);
  // these guard the rules that keep all four cards on screen without sideways scrolling.
  const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
  const usage = css.slice(css.indexOf('/* === usage header === */'), css.indexOf('/* === chat polish === */'));
  it('never scrolls the cards sideways; below 1280px the cards drop to their own row in four equal columns', () => {
    expect(usage).not.toMatch(/overflow-x:\s*auto/);
    expect(usage).toMatch(/\.usage-panel \{[^}]*grid-template-columns: repeat\(var\(--usage-cards, 4\), minmax\(0,/);
    const two = usage.slice(usage.indexOf('@media (max-width: 1279.98px)'));
    expect(two).toMatch(/\.topbar \{[^}]*flex-wrap: wrap/);
    expect(two).toMatch(/\.usage-card \{[^}]*flex: 1 1 0/);
    expect(usage).toMatch(/container: usage-card \/ inline-size/);
  });
  it('every @media block in styles.css is closed (an unclosed one swallowed the rules after it)', () => {
    let depth = 0;
    for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) { if (ch === '{') depth++; if (ch === '}') depth--; expect(depth).toBeGreaterThanOrEqual(0); }
    expect(depth).toBe(0);
  });
});
