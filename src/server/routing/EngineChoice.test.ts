import { describe, expect, it } from 'vitest';
import type { UsageSnapshot } from '../../shared/usage-types';
import { GPT_MARGIN_PCT, chooseEngine, type EngineInput } from './EngineChoice';
import { testRegistry } from '../../shared/accounts.testkit';

const NOW = Date.parse('2026-09-30T12:30:00Z');
const win = (usedPct: number) => ({ usedPct, resetsAt: new Date(NOW + 84 * 3_600_000).toISOString() });
const acct = (fiveHour: number, weekly: number) => ({ status: 'ok' as const, fetchedAt: new Date(NOW - 10_000).toISOString(), fiveHour: win(fiveHour), weekly: win(weekly), fable: win(0) });

function usage(claudeWeekly: [number, number, number], gptWeekly: number | null, gptStatus: 'ok' | 'down' = 'ok'): UsageSnapshot {
  return {
    generatedAt: 'x', deckReachable: true,
    accounts: { a: acct(0, claudeWeekly[0]), b: acct(0, claudeWeekly[1]), c: acct(0, claudeWeekly[2]) },
    gpt: gptWeekly === null ? { status: 'down', fetchedAt: null, fiveHour: null, weekly: null, fable: null } : { ...acct(0, gptWeekly), status: gptStatus, fiveHour: null, fable: null },
  };
}

function input(over: Partial<EngineInput>): EngineInput {
  return { choice: 'auto', usage: usage([40, 50, 60], 20), nowMs: NOW, codexAvailable: true, gptCooldownUntilMs: null, cooldownUntilMs: {}, protectedAccount: null, accounts: testRegistry(), ...over };
}

describe('chooseEngine (D3)', () => {
  it('explicit choices win; codex without a binary falls back to claude and says so', () => {
    expect(chooseEngine(input({ choice: 'claude' }))).toEqual({ engine: 'claude', reason: 'Claude 지정' });
    expect(chooseEngine(input({ choice: 'codex' }))).toEqual({ engine: 'codex', reason: 'GPT 지정' });
    expect(chooseEngine(input({ choice: 'codex', codexAvailable: false }))).toEqual({ engine: 'claude', reason: 'codex CLI 없음 → Claude' });
  });

  it('auto: GPT needs a known weekly, no cooldown, < 85 %, and margin over the best Claude candidate', () => {
    expect(GPT_MARGIN_PCT).toBe(10);
    // best Claude = a at 40 % → 60 remaining; GPT 20 % → 80 remaining ≥ 70 → codex
    expect(chooseEngine(input({})).engine).toBe('codex');
    // GPT 35 % → 65 remaining < 70 → claude
    expect(chooseEngine(input({ usage: usage([40, 50, 60], 35) }))).toMatchObject({ engine: 'claude', reason: expect.stringContaining('A') });
    expect(chooseEngine(input({ usage: usage([40, 50, 60], null) }))).toEqual({ engine: 'claude', reason: '자동 · GPT 잔여량 불명 → Claude' });
    expect(chooseEngine(input({ usage: usage([40, 50, 60], 20, 'down') })).engine).toBe('claude');
    expect(chooseEngine(input({ usage: usage([40, 50, 60], 86) })).reason).toContain('GPT 주간 86%');
    expect(chooseEngine(input({ gptCooldownUntilMs: NOW + 60_000 })).reason).toContain('쿨다운');
    expect(chooseEngine(input({ gptCooldownUntilMs: NOW - 1 })).engine).toBe('codex');
    // every Claude account excluded (≥95 %) → any known GPT headroom wins
    expect(chooseEngine(input({ usage: usage([96, 97, 98], 80) })).engine).toBe('codex');
    // the protected account still counts as a candidate for the comparison
    expect(chooseEngine(input({ usage: usage([10, 90, 90], 30), protectedAccount: 'a' })).engine).toBe('claude');
  });

  it('credits: an exhausted weekly with credits still runs an explicit GPT choice; auto stays on the weekly rule', () => {
    const withCredits = (u: UsageSnapshot): UsageSnapshot => ({ ...u, gpt: { ...u.gpt!, credits: { hasCredits: true, unlimited: false, balance: 49563.32 } } });
    const u = withCredits(usage([40, 50, 60], 100));
    expect(chooseEngine(input({ choice: 'codex', usage: u }))).toEqual({ engine: 'codex', reason: 'GPT 지정' });
    // credits cost money: auto never opens on GPT because of them, even with every Claude account spent
    expect(chooseEngine(input({ usage: u }))).toEqual({ engine: 'claude', reason: '자동 · GPT 주간 100% → Claude' });
    expect(chooseEngine(input({ usage: withCredits(usage([96, 97, 98], 100)) })).engine).toBe('claude');
  });
});

describe("chooseEngine — usage-deck 을 본 적 없는 설치 (usageSource: 'none')", () => {
  const unknownClaude = (source?: 'deck' | 'none'): UsageSnapshot => {
    const u = usage([40, 50, 60], 20);
    const down = { status: 'down' as const, fetchedAt: null, fiveHour: null, weekly: null, fable: null };
    return { ...u, accounts: { a: down, b: down, c: down }, ...(source ? { usageSource: source } : {}) };
  };

  it('자동: Claude usage unknown is not 0% room — Claude, even with codex installed and GPT room known', () => {
    expect(chooseEngine(input({ usage: unknownClaude('none') }))).toEqual({ engine: 'claude', reason: '자동 · Claude 잔여량 불명 → Claude' });
    // Every unknown account cooling down: nothing to run on, GPT has room.
    expect(chooseEngine(input({ usage: unknownClaude('none'), cooldownUntilMs: { a: NOW + 60_000, b: NOW + 60_000, c: NOW + 60_000 } })).engine).toBe('codex');
  });

  it('자동: known Claude candidates are compared as before', () => {
    expect(chooseEngine(input({ usage: { ...usage([40, 50, 60], 20), usageSource: 'none' } }))).toEqual(chooseEngine(input({ usage: usage([40, 50, 60], 20) })));
    expect(chooseEngine(input({ usage: { ...usage([40, 50, 60], 20), usageSource: 'none' } })).engine).toBe('codex');
  });

  it('with usage-deck the unknown Claude side still loses to a known GPT', () => {
    expect(chooseEngine(input({ usage: unknownClaude() })).engine).toBe('codex');
    expect(chooseEngine(input({ usage: unknownClaude('deck') })).engine).toBe('codex');
  });
});
