// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UsagePanel } from './UsagePanel';
import { UsageView, dailyStacks, fmtCost, fmtTokens, sumRows, weeklyRows } from './UsageView';
import type { UsageHistory, UsageRow } from '../../shared/token-usage';
import { emptyAccountUsage } from '../../shared/usage-types';

const row = (day: string, source: UsageRow['source'], family: UsageRow['family'], input: number, output: number, cacheRead = 0, cacheWrite = 0): UsageRow =>
  ({ day, source, family, input, output, cacheRead, cacheWrite, messages: 1 });

// 2026-10-02 is a Friday; its week starts Monday 2026-09-28.
const NOW = new Date(2026, 9, 2, 12);
const rows: UsageRow[] = [
  row('2026-10-02', 'all', 'opus', 1_000_000, 100_000, 9_000_000, 0),
  row('2026-10-02', 'a', 'opus', 1_000_000, 100_000, 9_000_000, 0),
  row('2026-09-29', 'all', 'gpt', 500_000, 0),
  row('2026-09-29', 'codex', 'gpt', 500_000, 0),
  row('2026-09-20', 'all', 'sonnet', 2_000_000, 0),
  row('2026-09-20', 'b', 'sonnet', 2_000_000, 0),
];

afterEach(cleanup);

describe('UsageView helpers', () => {
  it('formats and sums with family prices', () => {
    expect(fmtTokens(1_234_567_890)).toBe('1.23B');
    expect(fmtTokens(45_600)).toBe('45.6K');
    expect(fmtCost(1234.4)).toBe('$1,234');
    const today = sumRows(rows, 'all', (d) => d === '2026-10-02');
    // opus: 1M×$4 + 0.1M×$20 + 9M×$4×0.1 = 4 + 2 + 3.6
    expect(today.cost).toBeCloseTo(9.6);
    expect(weeklyRows(rows, 'all').map((w) => w.week)).toEqual(['2026-09-28', '2026-09-14']);
    const stacks = dailyStacks(rows, 'all', '2026-10-02', 30);
    expect(stacks).toHaveLength(30);
    expect(stacks.at(-1)).toMatchObject({ day: '2026-10-02', total: 10_100_000 });
  });
});

describe('UsageView', () => {
  it('renders totals, weekly table and chart; switches account; closes on Escape', async () => {
    const body: UsageHistory = { generatedAt: 'x', days: 84, lastScanAt: '2026-10-02T03:00:00Z', scanning: false, rows };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const onClose = vi.fn();
    render(<UsageView onClose={onClose} fetchFn={fetchFn} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('usage-weekly').textContent).toContain('2026-09-28 (이번 주)'));
    expect(screen.getByText('오늘').parentElement!.textContent).toContain('10.1M');
    expect(screen.getByText('이번 주').parentElement!.textContent).toContain('10.6M');
    expect(screen.getByText('30일').parentElement!.textContent).toContain('12.6M');
    expect(screen.getByTestId('usage-chart').querySelectorAll('rect.fam-opus')).toHaveLength(1);
    expect(screen.getByText('캐시 적중 90.0%')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'B' }));
    expect(screen.getByTestId('usage-weekly').textContent).toContain('2026-09-14');
    expect(screen.getByTestId('usage-weekly').textContent).not.toContain('이번 주');

    fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(fetchFn).toHaveBeenLastCalledWith('/api/usage/history?days=84&refresh=1'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the error when the API fails', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    render(<UsageView onClose={() => {}} fetchFn={fetchFn} now={NOW} />);
    await waitFor(() => expect(screen.getByText('사용량을 불러오지 못했습니다 (500)')).toBeTruthy());
  });
});

describe('UsagePanel → 사용량', () => {
  it('a clicked (pinned) usage card offers the history view', () => {
    const onOpenHistory = vi.fn();
    const usage = { generatedAt: 'x', deckReachable: true, accounts: { a: emptyAccountUsage(), b: emptyAccountUsage(), c: emptyAccountUsage() } };
    render(<UsagePanel usage={usage} current={null} now={NOW.getTime()} onOpenHistory={onOpenHistory} />);
    fireEvent.click(screen.getByTestId('account-a'));
    fireEvent.click(screen.getByRole('button', { name: '토큰 사용량 기록 보기 ›' }));
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
