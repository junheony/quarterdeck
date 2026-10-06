import type { Account, AccountNames } from '../../shared/accounts';
import type { EngineChoice, EngineKind } from '../../shared/models';
import type { UsageSnapshot } from '../../shared/usage-types';
import { WEEKLY_SWITCH_PCT, isLax, rankCandidates } from './AccountRouter';

/** D3: GPT must have this many more remaining weekly points than the best Claude candidate before 'auto' opens on GPT. */
export const GPT_MARGIN_PCT = 10;

export type EngineInput = {
  choice: EngineChoice;
  usage: UsageSnapshot;
  nowMs: number;
  codexAvailable: boolean;
  /** In-memory cooldown set by TurnRunner after a Codex limit failure (no cross-tool file: claude-pick has no GPT account). */
  gptCooldownUntilMs: number | null;
  cooldownUntilMs: Partial<Record<Account, number>>;
  protectedAccount: Account | null;
  accounts: AccountNames;
};

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Spec §4.3: decided once, when the session is created; the reason lands in the first turn badge. */
export function chooseEngine(i: EngineInput): { engine: EngineKind; reason: string } {
  if (i.choice === 'claude') return { engine: 'claude', reason: 'Claude 지정' };
  if (!i.codexAvailable) return { engine: 'claude', reason: i.choice === 'codex' ? 'codex CLI 없음 → Claude' : '자동 · codex CLI 없음 → Claude' };
  if (i.choice === 'codex') return { engine: 'codex', reason: 'GPT 지정' };
  if (i.gptCooldownUntilMs !== null && i.gptCooldownUntilMs > i.nowMs) return { engine: 'claude', reason: `자동 · GPT 쿨다운(~${hhmm(i.gptCooldownUntilMs)}) → Claude` };
  const gpt = i.usage.gpt;
  const gw = gpt && gpt.status !== 'down' ? (gpt.weekly?.usedPct ?? null) : null;
  if (gw === null) return { engine: 'claude', reason: '자동 · GPT 잔여량 불명 → Claude' };
  if (gw >= WEEKLY_SWITCH_PCT) return { engine: 'claude', reason: `자동 · GPT 주간 ${gw}% → Claude` };
  const { candidates, unknown } = rankCandidates({ current: null, usage: i.usage, nowMs: i.nowMs, lastTurnAtMs: null, justCompacted: false, cooldownUntilMs: i.cooldownUntilMs, protectedAccount: i.protectedAccount, needFable: false, accounts: i.accounts });
  // Best by weekly remaining, protected included: this is a capacity comparison, not the routing order.
  const best = candidates.length ? candidates.reduce((x, y) => (y.weeklyPct < x.weeklyPct ? y : x)) : null;
  // Never had usage-deck: an account nothing is known about is not one with 0% left.
  if (!best && unknown.length > 0 && isLax(i.usage)) return { engine: 'claude', reason: '자동 · Claude 잔여량 불명 → Claude' };
  const claudeRem = best ? 100 - best.weeklyPct : 0;
  const gptRem = 100 - gw;
  if (gptRem >= claudeRem + GPT_MARGIN_PCT) return { engine: 'codex', reason: `자동 · GPT 여유 ${gptRem}% ≥ Claude 최선 ${claudeRem}%+${GPT_MARGIN_PCT} → GPT` };
  return { engine: 'claude', reason: best ? `자동 · Claude ${i.accounts.label(best.account)} 여유 ${claudeRem}% → Claude` : '자동 · Claude' };
}
