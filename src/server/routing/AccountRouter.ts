import type { Account, AccountNames } from '../../shared/accounts';
import { FABLE_MAX_PCT } from '../../shared/models';
import type { RoutingPolicy } from '../../shared/protocol';
import { parseIsoUtc, usageOf, type UsageSnapshot } from '../../shared/usage-types';

export { FABLE_MAX_PCT };

export const FIVE_HOUR_SWITCH_PCT = 80;
export const WEEKLY_SWITCH_PCT = 85;
export const EXCLUDE_PCT = 95;
export const STALE_MAX_MS = 600_000;
export const WARM_MS = 55 * 60_000;
/** 고르게 분산: 5h usage within this many points counts as a tie (weekly, then the reset-urgency score decide). */
export const BALANCE_TIE_PCT = 5;
const DEFAULT_RESET_HOURS = 168;

export type RouterInput = {
  current: Account | null;
  usage: UsageSnapshot;
  nowMs: number;
  /** Last turn of this session on `current` (ms); null = never / imported. */
  lastTurnAtMs: number | null;
  justCompacted: boolean;
  cooldownUntilMs: Partial<Record<Account, number>>;
  protectedAccount: Account | null;
  needFable: boolean;
  exclude?: Account[];
  /** 이 세션은 B 써: the session's pinned account (null/absent = 자동). Used unless unusable — even the protected one. */
  pinned?: Account | null;
  /** How 자동 picks among eligible accounts (new sessions, cold caches); default 'balance'. */
  policy?: RoutingPolicy;
  /** Which accounts exist, their order (ties) and labels. */
  accounts: AccountNames;
};

export type Candidate = {
  account: Account;
  score: number;
  /** 0 when the card has no 5h row (see fiveHourKnown). */
  fiveHourPct: number;
  /** False when the card has no 5h row: 고르게 분산 ranks it after every account with a known 5h. */
  fiveHourKnown: boolean;
  weeklyPct: number;
  hoursToReset: number;
  stale: boolean;
  protected: boolean;
};

export type RouterDecision = {
  account: Account;
  reason: string;
  switched: boolean;
  candidates: Candidate[];
  excluded: Partial<Record<Account, string>>;
  /**
   * 잔여량 모름: accounts whose usage is not known (no usage-deck, no card, a card too old to trust) and that nothing
   * else rules out, in the order they are tried — after every candidate. They also keep their entry in `excluded`.
   */
  unknown?: Account[];
  /** The account is the session's pinned one, chosen because of the pin. */
  pinned?: boolean;
  /** The pinned account was unusable this turn (e.g. '한도 도달'); `account` is the router's own choice. */
  pinBlocked?: string;
  /**
   * This Fable turn was routed as an Opus turn, and why: set exactly when `reason` says "→ Opus". The runner runs Opus
   * then, so the reason and the model come from this one decision. Without it the model follows the account's own
   * Fable value (`resolveModel`).
   */
  asOpus?: string;
};

function hoursUntil(iso: string | null, nowMs: number): number {
  if (!iso) return DEFAULT_RESET_HOURS;
  const t = parseIsoUtc(iso);
  return Number.isNaN(t) ? DEFAULT_RESET_HOURS : (t - nowMs) / 3_600_000;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** An install that has never had an answer from usage-deck: an unknown value alone does not change the model or engine. */
export function isLax(usage: UsageSnapshot): boolean {
  return usage.usageSource === 'none';
}

/**
 * Why a Fable turn with no Fable-eligible account runs on Opus: a Fable value at the limit is known, or (with usage-deck)
 * none is known. null = no reason: an install without usage-deck leaves Fable only for a known value at the limit —
 * not for unknown values, cooldowns or 5h/weekly limits.
 */
export function noFableWhy(input: Pick<RouterInput, 'usage' | 'accounts'>): string | null {
  if (input.accounts.list().some((a) => (usageOf(input.usage, a).fable?.usedPct ?? -1) >= FABLE_MAX_PCT)) return 'Fable 여유 계정 없음';
  return isLax(input.usage) ? null : 'Fable 잔여량 모름(usage-deck 값 없음)';
}

export function rankCandidates(input: RouterInput): { candidates: Candidate[]; excluded: Partial<Record<Account, string>>; unknown: Account[] } {
  const candidates: Candidate[] = [];
  const excluded: Partial<Record<Account, string>> = {};
  const unknown: Account[] = [];
  const reg = input.accounts;
  const lax = isLax(input.usage);
  for (const account of reg.list()) {
    if (input.exclude?.includes(account)) { excluded[account] = '제외 지정'; continue; }
    const u = usageOf(input.usage, account);
    const cd = input.cooldownUntilMs[account];
    const cooling = cd !== undefined && cd > input.nowMs;
    if (u.status === 'down') { excluded[account] = '잔여량 정보 없음'; if (!cooling) unknown.push(account); continue; }
    if (u.status === 'stale') {
      const age = u.fetchedAt ? input.nowMs - parseIsoUtc(u.fetchedAt) : Number.NaN;
      if (Number.isNaN(age) || age > STALE_MAX_MS) {
        excluded[account] = `stale 자료 ${Number.isNaN(age) ? '?' : Math.round(age / 1000)}초 경과`;
        // Its last numbers at the limit: old, but no reason to try it before anything else.
        const atLimit = (u.fiveHour?.usedPct ?? 0) >= EXCLUDE_PCT || (u.weekly?.usedPct ?? 0) >= EXCLUDE_PCT;
        if (!cooling && !atLimit) unknown.push(account);
        continue;
      }
    }
    if (cooling) { excluded[account] = `쿨다운(~${hhmm(cd)})`; continue; }
    const weekly = u.weekly?.usedPct;
    if (weekly === undefined || weekly === null) { excluded[account] = '주간 사용률 없음'; unknown.push(account); continue; }
    const fiveHour = u.fiveHour?.usedPct ?? 0;
    if (fiveHour >= EXCLUDE_PCT) { excluded[account] = `5h ${fiveHour}%`; continue; }
    if (weekly >= EXCLUDE_PCT) { excluded[account] = `주간 ${weekly}%`; continue; }
    if (input.needFable) {
      const f = u.fable?.usedPct;
      if (f === undefined || f === null) {
        if (!lax) { excluded[account] = 'Fable 값 없음'; continue; }
      } else if (f >= FABLE_MAX_PCT) { excluded[account] = `Fable ${f}%`; continue; }
    }
    const hoursToReset = hoursUntil(u.weekly?.resetsAt ?? null, input.nowMs);
    candidates.push({
      account,
      score: (100 - weekly) / Math.max(hoursToReset, 1),
      fiveHourPct: fiveHour,
      fiveHourKnown: typeof u.fiveHour?.usedPct === 'number',
      weeklyPct: weekly,
      hoursToReset,
      stale: u.status === 'stale',
      protected: account === input.protectedAccount,
    });
  }
  candidates.sort(drainOrder(reg));
  // The registry's fallback order: not protected and not home first, then home, the protected account last. Within
  // one rank the lowest last-known weekly first (old numbers still tell a nearly full account from an empty one);
  // accounts with no weekly value at all follow.
  const rank = (a: Account) => (a === input.protectedAccount ? 2 : reg.isHome(a) ? 1 : 0);
  const lastWeekly = (a: Account) => usageOf(input.usage, a).weekly?.usedPct ?? Infinity;
  unknown.sort((x, y) => rank(x) - rank(y) || (lastWeekly(x) === lastWeekly(y) ? 0 : lastWeekly(x) - lastWeekly(y)));
  return { candidates: (input.policy ?? 'balance') === 'balance' ? balanceOrder(candidates) : candidates, excluded, unknown };
}

/** 리셋 임박 먼저 소진: protected last, then the highest (100 - weekly) / hours-to-reset; full ties: the later account in the registry's order first. */
function drainOrder(reg: AccountNames): (x: Candidate, y: Candidate) => number {
  const order = reg.list();
  return (x, y) => Number(x.protected) - Number(y.protected) ||
    y.score - x.score ||
    x.weeklyPct - y.weeklyPct ||
    Number(x.stale) - Number(y.stale) ||
    order.indexOf(y.account) - order.indexOf(x.account);
}

/** Not protected and under both force-switch thresholds (down/cooldown/stale/≥95 never become candidates). */
function isSafe(c: Candidate): boolean {
  return !c.protected && c.fiveHourPct < FIVE_HOUR_SWITCH_PCT && c.weeklyPct < WEEKLY_SWITCH_PCT;
}

/**
 * 고르게 분산: safe candidates first, lowest 5h first; 5h within BALANCE_TIE_PCT of the lowest is a tie, broken by
 * the lower weekly, then the drain order (score). Safe candidates with no 5h row follow (unknown is not 0%, so it
 * never wins over a known value), in drain order. The rest follow in drain order, so with no safe candidate this
 * is exactly the drain ranking (and the protected account stays last).
 */
function balanceOrder(drainSorted: Candidate[]): Candidate[] {
  const pool = drainSorted.filter((c) => isSafe(c) && c.fiveHourKnown);
  const out: Candidate[] = [];
  while (pool.length > 0) {
    const low = Math.min(...pool.map((c) => c.fiveHourPct));
    // `pool` is in drain order and the sort is stable: equal weekly keeps the score order.
    const pick = pool.filter((c) => c.fiveHourPct <= low + BALANCE_TIE_PCT).sort((x, y) => x.weeklyPct - y.weeklyPct)[0] as Candidate;
    out.push(pick);
    pool.splice(pool.indexOf(pick), 1);
  }
  return [...out, ...drainSorted.filter((c) => isSafe(c) && !c.fiveHourKnown), ...drainSorted.filter((c) => !isSafe(c))];
}

/** A candidate's 5h for reasons and logs: '?' when the card has no 5h row. */
function pct5(c: Candidate): string {
  return c.fiveHourKnown ? `${c.fiveHourPct}%` : '?';
}

/** Why `cands[0]` (safe) won under 고르게 분산, against the runner-up. */
function balanceWhy(reg: AccountNames, cands: Candidate[]): string {
  const [b, n] = cands as [Candidate, Candidate | undefined];
  const B = reg.label(b.account);
  if (!n) return `분산: 5h ${B} ${pct5(b)} · 유일한 후보`;
  const N = reg.label(n.account);
  if (!isSafe(n)) return `분산: 5h ${B} ${pct5(b)} · ${N} ${n.protected ? '보호 계정' : '문턱 근접'}`;
  if (b.fiveHourKnown && !n.fiveHourKnown) return `분산: 5h ${B} ${pct5(b)} · ${N} 5h 값 없음`;
  if (n.fiveHourPct - b.fiveHourPct > BALANCE_TIE_PCT) return `분산: 5h ${B} ${pct5(b)} < ${N} ${pct5(n)}`;
  if (b.weeklyPct < n.weeklyPct) return `분산: 5h 비슷(${B} ${pct5(b)} · ${N} ${pct5(n)}) · 주간 ${B} ${b.weeklyPct}% < ${N} ${n.weeklyPct}%`;
  return `분산: 5h·주간 비슷 · 리셋 임박 ${B}`;
}

/** The policy's reason for picking `cands[0]`. */
function bestWhy(input: RouterInput, cands: Candidate[]): string {
  const b = cands[0] as Candidate;
  const reg = input.accounts;
  const drain = `리셋 임박 ${reg.label(b.account)}(주간 ${b.weeklyPct}% · ${Math.round(b.hoursToReset)}시간 뒤 리셋)`;
  if ((input.policy ?? 'balance') === 'drain') return drain;
  return isSafe(b) ? balanceWhy(reg, cands) : `안전한 후보 없음 → ${drain}`;
}

/** The server log line for a routed turn: decision, candidates and exclusions (usage numbers only, no secrets). */
export function routeLogLine(sessionId: string | null, d: RouterDecision, accounts: AccountNames): string {
  const LABEL = (a: Account) => accounts.label(a);
  const cands = d.candidates.map((c) => `${LABEL(c.account)}${c.protected ? '(보호)' : ''} 5h ${pct5(c)} · 주간 ${c.weeklyPct}%`).join(', ');
  const unknown = (d.unknown ?? []).map(LABEL).join(', ');
  const ex = accounts.list().filter((a) => d.excluded[a] && !d.unknown?.includes(a)).map((a) => `${LABEL(a)} ${d.excluded[a]}`).join(', ');
  return `deck: route ${sessionId ? sessionId.slice(0, 8) : '새 세션'} → ${LABEL(d.account)} (${d.reason})${cands ? ` · 후보 ${cands}` : ''}${unknown ? ` · 잔여량 모름 ${unknown}` : ''}${ex ? ` · 제외 ${ex}` : ''}`;
}

/** claude-pick exit 3: least weekly among non-excluded, non-protected accounts with a weekly value, ties in the registry's order; else the registry's fallback (not protected, not home: `b` in the a/b/c set). */
function leastWeekly(input: RouterInput): Account {
  const reg = input.accounts;
  let best: { account: Account; w: number } | null = null;
  for (const account of reg.list()) {
    if (input.exclude?.includes(account) || account === input.protectedAccount) continue;
    const w = usageOf(input.usage, account).weekly?.usedPct;
    if (w === undefined || w === null) continue;
    if (!best || w < best.w) best = { account, w };
  }
  return best?.account ?? reg.fallback(input.protectedAccount);
}

/** Why the pinned account cannot take this turn (≥95%, cooldown, already failed this turn); null = usable. */
function pinBlock(input: RouterInput, pin: Account): { why: string; detail: string } | null {
  if (input.exclude?.includes(pin)) return { why: '이번 턴 실패', detail: '이번 턴 실패' };
  const cd = input.cooldownUntilMs[pin];
  if (cd !== undefined && cd > input.nowMs) return { why: '쿨다운 중', detail: `쿨다운(~${hhmm(cd)})` };
  const u = usageOf(input.usage, pin);
  const fiveHour = u.fiveHour?.usedPct ?? 0;
  const weekly = u.weekly?.usedPct ?? 0;
  if (fiveHour >= EXCLUDE_PCT) return { why: '한도 도달', detail: `5h ${fiveHour}%` };
  if (weekly >= EXCLUDE_PCT) return { why: '한도 도달', detail: `주간 ${weekly}%` };
  return null;
}

export function chooseAccount(input: RouterInput): RouterDecision {
  const reg = input.accounts;
  const LABEL = (a: Account) => reg.label(a);
  // A pin on an account that is not active (removed or retired since) is no pin.
  const pin = input.pinned && reg.list().includes(input.pinned) ? input.pinned : null;
  if (pin) {
    // A pin skips warm-cache and threshold switching (and the protected-account rule: it is the user's explicit choice).
    const block = pinBlock(input, pin);
    if (!block) {
      const ranked = rankCandidates(input);
      const switched = input.current !== null && input.current !== pin;
      return { ...ranked, account: pin, switched, pinned: true, reason: `고정 ${LABEL(pin)}${switched ? ' 전환' : ''}` };
    }
    // Unusable: the router's own choice for this turn only (the pin stays).
    const d = chooseAccount({ ...input, pinned: null, exclude: [...(input.exclude ?? []), pin] });
    if (d.account === pin) return { ...d, reason: `고정 ${LABEL(pin)} ${block.detail} · 대안 없음 · ${d.reason}` };
    return { ...d, pinBlocked: block.why, reason: `고정 ${LABEL(pin)} ${block.detail} → ${d.reason}` };
  }
  const { candidates, excluded, unknown } = rankCandidates(input);
  // No Fable-eligible account at all: the turn is routed like an Opus turn — not to the "least weekly" fallback, which
  // ignores 5h limits and cooldowns. The same when only the protected account has Fable room: Fable alone does not move
  // a session onto it (one already there, and usable — it is a candidate — stays; a blocked one has no candidates left).
  // Whether it then runs on Opus follows the account it lands on (below).
  const onProtected = !!input.protectedAccount && input.current === input.protectedAccount;
  const lax = isLax(input.usage);
  // Without usage-deck ever: accounts nothing is known about take the Fable turn as it is (the unknown tier below).
  const blindFable = lax && candidates.length === 0 && unknown.length > 0;
  if (input.needFable && !blindFable && (candidates.length === 0 || (!onProtected && candidates.every((c) => c.account === input.protectedAccount)))) {
    const d = chooseAccount({ ...input, needFable: false });
    // Landed on an account with Fable room anyway (the protected one, taken for its own sake): the Fable turn runs there.
    if (candidates.some((c) => c.account === d.account)) return d;
    // The model follows that account's own Fable value, as `resolveModel` reads it: at the limit → Opus; unknown → Opus
    // with usage-deck, Fable without; known room (the account is out for a 5h/weekly limit, a cooldown or an old card,
    // none of which is a reason to change the model) → Fable. "→ Opus" is said only with `asOpus`, and the other way round.
    const f = usageOf(input.usage, d.account).fable?.usedPct ?? null;
    const why = f === null ? (lax ? null : noFableWhy(input)) : f < FABLE_MAX_PCT ? null : lax && candidates.length > 0 ? 'Fable 여유는 보호 계정뿐' : 'Fable 여유 계정 없음';
    if (why === null) return d;
    return { ...d, asOpus: why, reason: `${why} → Opus · ${d.reason}` };
  }
  const best = candidates[0] ?? null;
  const cur = input.current;
  const base = { candidates, excluded, unknown };

  if (cur === null) {
    if (best) return { ...base, account: best.account, switched: false, reason: `새 세션 · ${bestWhy(input, candidates)}` };
    // Nobody is known to have room: an account nothing is known about comes before one known to be at its limit.
    const blind = unknown[0];
    if (blind !== undefined) return { ...base, account: blind, switched: false, reason: `자격 있는 계정 없음 → 잔여량 모름 · ${LABEL(blind)}` };
    const fb = leastWeekly(input);
    return { ...base, account: fb, switched: false, reason: `자격 있는 계정 없음 → 최소 사용 ${LABEL(fb)}` };
  }

  const cu = usageOf(input.usage, cur);
  const fiveHour = cu.fiveHour?.usedPct ?? 0;
  const weekly = cu.weekly?.usedPct ?? 0;
  const fable = cu.fable?.usedPct ?? null;
  const cd = input.cooldownUntilMs[cur];
  const inCooldown = cd !== undefined && cd > input.nowMs;

  let force: string | null = null;
  if (inCooldown) force = `쿨다운(~${hhmm(cd)})`;
  else if (fiveHour >= FIVE_HOUR_SWITCH_PCT || weekly >= WEEKLY_SWITCH_PCT) force = `문턱 초과(5h ${fiveHour}% · 주간 ${weekly}%)`;
  // Unknown Fable counts as not Fable-eligible, same as rankCandidates.
  else if (input.needFable && fable === null && !lax) force = 'Fable 값 없음';
  else if (input.needFable && fable !== null && fable >= FABLE_MAX_PCT) force = `Fable ${fable}% 이상`;

  if (force) {
    // Only move to an account that would not itself be forced off next turn (no ping-pong, no wasted cache rewrite).
    // The protected account (spec §4.1: last candidate) is only taken when the current one is unusable.
    // The target follows the policy: 고르게 분산 → the balance order (safe, lowest 5h first); drain → the drain order.
    const ordered = (input.policy ?? 'balance') === 'drain' ? [...candidates].sort(drainOrder(reg)) : candidates;
    const roomy = ordered.find((c) => {
      if (c.account === cur || c.protected) return false;
      const u = usageOf(input.usage, c.account);
      return (u.fiveHour?.usedPct ?? 0) < FIVE_HOUR_SWITCH_PCT && c.weeklyPct < WEEKLY_SWITCH_PCT;
    });
    if (roomy) return { ...base, account: roomy.account, switched: true, reason: `${force} → ${LABEL(roomy.account)} 전환` };
    // Current is unusable (≥95 or cooling down): any eligible alternative beats staying (protected sorts last).
    const hard = inCooldown || fiveHour >= EXCLUDE_PCT || weekly >= EXCLUDE_PCT;
    const alt = hard ? ordered.find((c) => c.account !== cur) : undefined;
    if (alt) return { ...base, account: alt.account, switched: true, reason: `${force} → ${LABEL(alt.account)} 전환(여유 있는 대안 없음)` };
    const blind = hard ? unknown.find((a) => a !== cur) : undefined;
    if (blind !== undefined) return { ...base, account: blind, switched: true, reason: `${force} → 잔여량 모름 · ${LABEL(blind)} 전환` };
    return { ...base, account: cur, switched: false, reason: `${force} · 여유 있는 대안 없음 · ${LABEL(cur)} 유지` };
  }

  const sinceLast = input.lastTurnAtMs === null ? null : input.nowMs - input.lastTurnAtMs;
  const coldWhy = input.justCompacted ? '방금 압축' : sinceLast === null ? '첫 턴' : sinceLast >= WARM_MS ? `${Math.round(sinceLast / 60_000)}분 경과` : null;
  // A `down` current card does not block the cold-cache move: nothing is lost by moving when the cache is cold.
  // 고르게 분산 hysteresis: 5h moves a lot, so a cold session on a safe account only moves for a clear win
  // (more than BALANCE_TIE_PCT lower, both known) — not B→C→B on every idle hour, each one a relocate().
  const curCand = candidates.find((c) => c.account === cur);
  const marginal = (input.policy ?? 'balance') === 'balance' && !!best && !!curCand && isSafe(curCand) &&
    !(best.fiveHourKnown && curCand.fiveHourKnown && best.fiveHourPct + BALANCE_TIE_PCT < curCand.fiveHourPct);
  if (coldWhy && best && best.account !== cur && !marginal) {
    return { ...base, account: best.account, switched: true, reason: `캐시 식음(${coldWhy}) → ${LABEL(best.account)} · ${bestWhy(input, candidates)}` };
  }
  if (cu.status === 'down') return { ...base, account: cur, switched: false, reason: `잔여량 정보 없음 · ${LABEL(cur)} 유지` };
  if (coldWhy) {
    const why = best ? (best.account !== cur ? `현재 계정이 최적(5h 차이 ${BALANCE_TIE_PCT}%p 이내)` : '현재 계정이 최적') : '자격 있는 대안 없음';
    return { ...base, account: cur, switched: false, reason: `캐시 식음(${coldWhy}) · ${why} · ${LABEL(cur)} 유지` };
  }
  // Deliberate for now (review M1): a warm session stays put even on the protected account; it only
  // leaves on a forced switch or when the cache goes cold.
  return { ...base, account: cur, switched: false, reason: `${LABEL(cur)} 유지 · 캐시 따뜻함(${Math.round((sinceLast ?? 0) / 60_000)}분 전)` };
}
