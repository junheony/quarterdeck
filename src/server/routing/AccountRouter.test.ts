import { describe, expect, it } from 'vitest';
import { buildRegistry, type Account } from '../../shared/accounts';
import type { AccountUsage, UsageSnapshot } from '../../shared/usage-types';
import { testRegistry } from '../../shared/accounts.testkit';
import { chooseAccount, rankCandidates, routeLogLine, type RouterInput } from './AccountRouter';
import { resolveModel } from './ModelPolicy';

const NOW = Date.parse('2026-09-30T12:30:00Z');
const H = 3_600_000;

type Spec = { s?: number | null; w?: number; f?: number | null; status?: AccountUsage['status']; age?: number; resetH?: number };

function acct(spec: Spec): AccountUsage {
  const status = spec.status ?? 'ok';
  const fetchedAt = new Date(NOW - (spec.age ?? 30_000)).toISOString();
  const resetsAt = new Date(NOW + (spec.resetH ?? 100) * H).toISOString();
  return {
    status,
    fetchedAt,
    fiveHour: spec.s === null ? null : spec.s === undefined ? { usedPct: 10, resetsAt } : { usedPct: spec.s, resetsAt },
    weekly: spec.w === undefined ? null : { usedPct: spec.w, resetsAt },
    fable: spec.f === null ? null : { usedPct: spec.f ?? 0, resetsAt },
  };
}

function snap(a: Spec, b: Spec, c: Spec, reachable = true): UsageSnapshot {
  return { generatedAt: new Date(NOW).toISOString(), deckReachable: reachable, accounts: { a: acct(a), b: acct(b), c: acct(c) } };
}

/** The production default: no policy given (= 'balance'), everything else as `input`. */
function dflt(over: Partial<RouterInput>): RouterInput {
  const { policy: _p, ...rest } = input(over);
  return rest;
}

function input(over: Partial<RouterInput>): RouterInput {
  return {
    current: null,
    usage: snap({ w: 7, resetH: 154 }, { w: 3, resetH: 84 }, { w: 91, resetH: 36 }),
    nowMs: NOW,
    lastTurnAtMs: null,
    justCompacted: false,
    cooldownUntilMs: {},
    protectedAccount: null,
    needFable: false,
    accounts: testRegistry(),
    // The tables below pin the old "리셋 임박 먼저 소진" policy: they are the proof it is unchanged.
    policy: 'drain',
    ...over,
  };
}

describe('rankCandidates', () => {
  it('scores (100-weekly)/hours and orders by score', () => {
    const { candidates } = rankCandidates(input({}));
    expect(candidates.map((c) => c.account)).toEqual(['b', 'a', 'c']);
    expect(candidates[0]?.score).toBeCloseTo(97 / 84, 5);
  });

  it('excludes ≥95, cooldown, stale >600s, missing weekly, and explicit exclude', () => {
    const { candidates, excluded } = rankCandidates(input({
      usage: snap({ w: 96 }, { w: 10, s: 95 }, { w: 10, status: 'stale', age: 601_000 }),
      cooldownUntilMs: {},
    }));
    expect(candidates).toEqual([]);
    expect(excluded.a).toMatch(/주간 96/);
    expect(excluded.b).toMatch(/5h 95/);
    expect(excluded.c).toMatch(/stale/);
    const r2 = rankCandidates(input({ usage: snap({ w: 10 }, {}, { w: 10 }), cooldownUntilMs: { c: NOW + 1000 }, exclude: ['a'] }));
    expect(r2.candidates).toEqual([]);
    expect(r2.excluded.b).toMatch(/주간 사용률 없음/);
    expect(r2.excluded.c).toMatch(/쿨다운/);
    expect(r2.excluded.a).toMatch(/제외/);
  });

  it('stale within 600s stays eligible but sorts after ok on ties; ties break c > b > a', () => {
    const { candidates } = rankCandidates(input({ usage: snap({ w: 10, resetH: 50 }, { w: 10, resetH: 50, status: 'stale', age: 100_000 }, { w: 10, resetH: 50 }) }));
    expect(candidates.map((c) => c.account)).toEqual(['c', 'a', 'b']);
  });

  it('needFable drops accounts with Fable ≥80 or unknown', () => {
    const { candidates, excluded } = rankCandidates(input({ needFable: true, usage: snap({ w: 10, f: 80 }, { w: 10, f: null }, { w: 10, f: 79 }) }));
    expect(candidates.map((c) => c.account)).toEqual(['c']);
    expect(excluded.a).toMatch(/Fable 80/);
    expect(excluded.b).toMatch(/Fable 값 없음/);
  });

  it('protected account sorts last even with the best score', () => {
    const { candidates } = rankCandidates(input({ protectedAccount: 'a', usage: snap({ w: 0, resetH: 10 }, { w: 50 }, { w: 60 }) }));
    expect(candidates.map((c) => c.account)).toEqual(['b', 'c', 'a']);
    expect(candidates[2]?.protected).toBe(true);
  });
});

describe('chooseAccount — table', () => {
  const cases: { name: string; in: Partial<RouterInput>; account: Account; switched: boolean; reason: RegExp }[] = [
    { name: 'new session → best score', in: {}, account: 'b', switched: false, reason: /새 세션/ },
    { name: 'new session, protected a is last', in: { protectedAccount: 'a', usage: snap({ w: 0, resetH: 10 }, { w: 50 }, { w: 60 }) }, account: 'b', switched: false, reason: /새 세션/ },
    { name: 'new session, protected is the only candidate', in: { protectedAccount: 'a', usage: snap({ w: 0 }, { w: 96 }, { w: 97 }) }, account: 'a', switched: false, reason: /새 세션/ },
    { name: 'no eligible at all → least weekly', in: { usage: snap({ w: 96 }, { w: 95 }, { w: 99 }) }, account: 'b', switched: false, reason: /자격 있는 계정 없음/ },
    { name: 'current over 5h 80 → switch', in: { current: 'b', lastTurnAtMs: NOW - 60_000, usage: snap({ w: 7 }, { w: 3, s: 80 }, { w: 91 }) }, account: 'a', switched: true, reason: /문턱/ },
    { name: 'current over weekly 85 → switch', in: { current: 'c', lastTurnAtMs: NOW - 60_000 }, account: 'b', switched: true, reason: /문턱/ },
    { name: 'current in cooldown → switch', in: { current: 'b', lastTurnAtMs: NOW - 60_000, cooldownUntilMs: { b: NOW + 60_000 } }, account: 'a', switched: true, reason: /쿨다운/ },
    { name: 'current over but no alternative → stay', in: { current: 'b', usage: snap({ w: 96 }, { w: 3, s: 85 }, { w: 97 }) }, account: 'b', switched: false, reason: /대안 없음/ },
    { name: 'warm cache with a better account → stay', in: { current: 'a', lastTurnAtMs: NOW - 10 * 60_000 }, account: 'a', switched: false, reason: /캐시 따뜻함/ },
    { name: 'cold cache (55 min) → better account', in: { current: 'a', lastTurnAtMs: NOW - 55 * 60_000 }, account: 'b', switched: true, reason: /캐시 식음/ },
    { name: 'just compacted → better account', in: { current: 'a', lastTurnAtMs: NOW - 60_000, justCompacted: true }, account: 'b', switched: true, reason: /압축/ },
    { name: 'imported session (no last turn) → better account', in: { current: 'a' }, account: 'b', switched: true, reason: /캐시 식음/ },
    { name: 'cold but current is best → stay', in: { current: 'b', lastTurnAtMs: NOW - 2 * H }, account: 'b', switched: false, reason: /현재 계정이 최적/ },
    { name: 'deck down → stay on current', in: { current: 'c', usage: snap({ status: 'down' }, { status: 'down' }, { status: 'down' }, false) }, account: 'c', switched: false, reason: /잔여량 정보 없음/ },
    { name: 'deck stale >600s everywhere → stay', in: { current: 'c', lastTurnAtMs: NOW - 2 * H, usage: snap({ w: 7, status: 'stale', age: 900_000 }, { w: 3, status: 'stale', age: 900_000 }, { w: 10, status: 'stale', age: 900_000 }) }, account: 'c', switched: false, reason: /대안 없음/ },
    { name: 'needFable and current Fable 85 → switch to one with room', in: { current: 'a', lastTurnAtMs: NOW - 60_000, needFable: true, usage: snap({ w: 7, f: 85 }, { w: 3, f: 10 }, { w: 91, f: 27 }) }, account: 'b', switched: true, reason: /Fable/ },
    { name: 'needFable and current Fable unknown → switch to one with room', in: { current: 'a', lastTurnAtMs: NOW - 60_000, needFable: true, usage: snap({ w: 7, f: null }, { w: 3, f: 10 }, { w: 91, f: 27 }) }, account: 'b', switched: true, reason: /Fable/ },
    { name: 'current card down, cold cache → move to a better account', in: { current: 'a', lastTurnAtMs: NOW - 2 * H, usage: snap({ status: 'down' }, { w: 3 }, { w: 10 }) }, account: 'b', switched: true, reason: /캐시 식음/ },
    { name: 'current card down, warm cache → stay', in: { current: 'a', lastTurnAtMs: NOW - 60_000, usage: snap({ status: 'down' }, { w: 3 }, { w: 10 }) }, account: 'a', switched: false, reason: /유지/ },
    { name: 'over threshold, only alt is also over its 5h threshold → stay', in: { current: 'a', lastTurnAtMs: NOW - 60_000, usage: snap({ s: 81, w: 10 }, { s: 90, w: 10 }, { s: 10, w: 96 }) }, account: 'a', switched: false, reason: /대안 없음/ },
    { name: 'over threshold, alt is over its weekly threshold → stay', in: { current: 'a', lastTurnAtMs: NOW - 60_000, usage: snap({ s: 81, w: 10 }, { s: 10, w: 88 }, { s: 10, w: 96 }) }, account: 'a', switched: false, reason: /대안 없음/ },
    { name: 'current ≥95 on 5h, alt merely over threshold → still switch', in: { current: 'a', lastTurnAtMs: NOW - 60_000, usage: snap({ s: 96, w: 10 }, { s: 90, w: 10 }, { s: 10, w: 96 }) }, account: 'b', switched: true, reason: /전환/ },
    { name: 'current in cooldown, alt merely over threshold → still switch', in: { current: 'a', lastTurnAtMs: NOW - 60_000, cooldownUntilMs: { a: NOW + 60_000 }, usage: snap({ s: 10, w: 10 }, { s: 90, w: 10 }, { s: 10, w: 96 }) }, account: 'b', switched: true, reason: /쿨다운/ },
    { name: 'over threshold → prefers an alt under both switch thresholds', in: { current: 'a', lastTurnAtMs: NOW - 60_000, usage: snap({ s: 81, w: 10 }, { s: 85, w: 1, resetH: 5 }, { s: 10, w: 50 }) }, account: 'c', switched: true, reason: /전환/ },
    { name: 'over threshold, only the protected account has room → stay', in: { current: 'a', protectedAccount: 'c', lastTurnAtMs: NOW - 60_000, usage: snap({ s: 81, w: 10 }, { s: 90, w: 10 }, { s: 10, w: 10 }) }, account: 'a', switched: false, reason: /대안 없음/ },
    { name: 'current ≥95, only the protected account has room → protected', in: { current: 'a', protectedAccount: 'c', lastTurnAtMs: NOW - 60_000, usage: snap({ s: 96, w: 10 }, { s: 10, w: 96 }, { s: 10, w: 10 }) }, account: 'c', switched: true, reason: /전환/ },
    { name: 'no eligible, protected has least weekly → skip it (claude-pick loose list)', in: { protectedAccount: 'b', usage: snap({ w: 96 }, { w: 95 }, { w: 99 }) }, account: 'a', switched: false, reason: /자격 있는 계정 없음/ },
    { name: 'no eligible, excluded has least weekly → skip it', in: { exclude: ['b'], usage: snap({ w: 97 }, { w: 95 }, { w: 96 }) }, account: 'c', switched: false, reason: /자격 있는 계정 없음/ },
    { name: 'no eligible and nothing in the loose list → b', in: { protectedAccount: 'c', exclude: ['a', 'b'], usage: snap({ w: 97 }, { w: 95 }, { w: 96 }) }, account: 'b', switched: false, reason: /자격 있는 계정 없음/ },
    { name: 'no eligible, weekly tie → alphabetical first (claude-pick sorts (w, t))', in: { usage: snap({ w: 96 }, { w: 96 }, { w: 99 }) }, account: 'a', switched: false, reason: /자격 있는 계정 없음/ },
    { name: 'needFable, new session, nobody has Fable room → a usable account for Opus (not the cooled-down least-weekly one)', in: { needFable: true, cooldownUntilMs: { b: NOW + 60_000 }, usage: snap({ w: 7, f: 85 }, { w: 3, f: 90 }, { w: 50, f: 80 }) }, account: 'a', switched: false, reason: /Fable 여유 계정 없음 → Opus/ },
    { name: 'needFable, new session, only the protected account has Fable room → not the protected one (Opus elsewhere)', in: { needFable: true, protectedAccount: 'a', usage: snap({ w: 7, f: 20 }, { w: 3, f: 85 }, { w: 10, f: null }) }, account: 'b', switched: false, reason: /Fable 여유 계정 없음 → Opus/ },
    { name: 'needFable, current on another account, only the protected one has Fable room → stays (caller downgrades)', in: { current: 'b', protectedAccount: 'a', lastTurnAtMs: NOW - 60_000, needFable: true, usage: snap({ w: 7, f: 20 }, { w: 3, f: 85 }, { w: 10, f: null }) }, account: 'b', switched: false, reason: /Fable 여유 계정 없음 → Opus/ },
    { name: 'needFable, session on the protected account in cooldown, no Fable room anywhere → moves (Opus routing)', in: { current: 'a', protectedAccount: 'a', lastTurnAtMs: NOW - 60_000, needFable: true, cooldownUntilMs: { a: NOW + 60_000 }, usage: snap({ w: 7, f: 85 }, { w: 3, f: 90 }, { w: 10, f: null }) }, account: 'b', switched: true, reason: /Fable 여유 계정 없음 → Opus/ },
    { name: 'needFable, session on the protected account at 5h 97%, no Fable room anywhere → moves (Opus routing)', in: { current: 'a', protectedAccount: 'a', lastTurnAtMs: NOW - 60_000, needFable: true, usage: snap({ s: 97, w: 7, f: 85 }, { w: 3, f: 90 }, { w: 10, f: null }) }, account: 'b', switched: true, reason: /Fable 여유 계정 없음 → Opus/ },
    { name: 'needFable, session on the protected account, usable and the only one with Fable room → stays on Fable', in: { current: 'a', protectedAccount: 'a', lastTurnAtMs: NOW - 60_000, needFable: true, usage: snap({ w: 7, f: 20 }, { w: 3, f: 85 }, { w: 10, f: null }) }, account: 'a', switched: false, reason: /^(?!.*Fable 여유 계정 없음)/ },
    { name: 'needFable, nobody has room → stay (caller downgrades model)', in: { current: 'a', lastTurnAtMs: NOW - 60_000, needFable: true, usage: snap({ w: 7, f: 85 }, { w: 3, f: 90 }, { w: 91, f: 80 }) }, account: 'a', switched: false, reason: /Fable 여유 계정 없음 → Opus/ },
  ];

  it('I1: no ping-pong when the only alternative is also over its switch threshold', () => {
    const usage = snap({ s: 81, w: 10, resetH: 50 }, { s: 90, w: 10, resetH: 50 }, { s: 10, w: 96, resetH: 50 });
    for (const start of ['a', 'b'] as const) {
      let cur: Account = start;
      const seen: Account[] = [];
      for (let i = 0; i < 6; i++) {
        const d = chooseAccount(input({ current: cur, usage, lastTurnAtMs: NOW - 60_000 }));
        seen.push(d.account);
        cur = d.account;
      }
      expect(seen).toEqual(Array(6).fill(start));
    }
  });

  for (const c of cases) {
    it(c.name, () => {
      const d = chooseAccount(input(c.in));
      expect(d.account).toBe(c.account);
      expect(d.switched).toBe(c.switched);
      expect(d.reason).toMatch(c.reason);
    });
  }
});

describe('chooseAccount · 고정 계정 (pinned)', () => {
  it('pinned and usable: always that account — no warm-cache stickiness, no threshold switching', () => {
    // Warm on B, but pinned to C (C at 91% weekly is past WEEKLY_SWITCH_PCT, still < 95).
    const d = chooseAccount(input({ current: 'b', lastTurnAtMs: NOW - 60_000, pinned: 'c' }));
    expect(d.account).toBe('c');
    expect(d.switched).toBe(true);
    expect(d.pinned).toBe(true);
    expect(d.pinBlocked).toBeUndefined();
    expect(d.reason).toMatch(/고정 C/);
    // Already there: stays, even above the 80/85 thresholds that would force a switch when unpinned.
    const stay = chooseAccount(input({ current: 'c', lastTurnAtMs: NOW - 60_000, pinned: 'c', usage: snap({ w: 7 }, { w: 3 }, { w: 90, s: 85 }) }));
    expect(stay).toMatchObject({ account: 'c', switched: false, pinned: true });
    expect(chooseAccount(input({ current: 'c', lastTurnAtMs: NOW - 60_000, usage: snap({ w: 7 }, { w: 3 }, { w: 90, s: 85 }) })).account).not.toBe('c');
  });

  it('pinned but unusable (≥95 / cooldown / failed this turn): the router picks for this turn and says why', () => {
    const limit = chooseAccount(input({ current: 'b', lastTurnAtMs: NOW - 60_000, pinned: 'b', usage: snap({ w: 7 }, { w: 96 }, { w: 20 }) }));
    expect(limit.account).toBe('a');
    expect(limit.pinned).toBeUndefined();
    expect(limit.pinBlocked).toBe('한도 도달');
    expect(limit.reason).toMatch(/고정 B 주간 96%/);
    const cool = chooseAccount(input({ current: 'b', pinned: 'b', cooldownUntilMs: { b: NOW + 60_000 }, usage: snap({ w: 7 }, { w: 10 }, { w: 20 }) }));
    expect(cool.account).not.toBe('b');
    expect(cool.pinBlocked).toBe('쿨다운 중');
    const failed = chooseAccount(input({ current: 'b', pinned: 'b', exclude: ['b'], usage: snap({ w: 7 }, { w: 10 }, { w: 20 }) }));
    expect(failed.account).not.toBe('b');
    expect(failed.pinBlocked).toBe('이번 턴 실패');
    // Nothing else usable either: stays on the pinned account, no fallback claimed.
    const none = chooseAccount(input({ current: 'b', pinned: 'b', usage: snap({ w: 99 }, { w: 96 }, { w: 98 }) }));
    expect(none.account).toBe('b');
    expect(none.pinBlocked).toBeUndefined();
  });

  it('pinning to the protected account (A, Desktop) is honoured — it is the user\'s explicit choice', () => {
    const d = chooseAccount(input({ current: 'b', lastTurnAtMs: NOW - 60_000, protectedAccount: 'a', pinned: 'a' }));
    expect(d).toMatchObject({ account: 'a', switched: true, pinned: true });
    expect(chooseAccount(input({ current: null, protectedAccount: 'a', pinned: 'a' })).account).toBe('a');
    // Unpinned, a new session never lands on the protected account while others are eligible.
    expect(chooseAccount(input({ current: null, protectedAccount: 'a' })).account).not.toBe('a');
  });
});

describe('chooseAccount · 고르게 분산 (balance)', () => {
  // The reported case: B resets in ~18h with 78% left, C in ~138h with 100% left. Drain sends everything to B.
  const reported = () => snap({ s: 30, w: 40, resetH: 100 }, { s: 10, w: 22, resetH: 18 }, { s: 0, w: 0, resetH: 138 });
  const bal = (over: Partial<RouterInput>) => input({ policy: 'balance', ...over });

  it('is the default when no policy is given', () => {
    const { policy: _p, ...noPolicy } = input({ protectedAccount: 'a', usage: reported() });
    expect(chooseAccount(noPolicy).account).toBe('c');
  });

  it('new session → lowest 5h among safe candidates, and says why', () => {
    const d = chooseAccount(bal({ protectedAccount: 'a', usage: reported() }));
    expect(d.account).toBe('c');
    expect(d.reason).toBe('새 세션 · 분산: 5h C 0% < B 10%');
    // The same input under drain still drains B (resets soonest).
    expect(chooseAccount(input({ protectedAccount: 'a', usage: reported() })).account).toBe('b');
  });

  it('5h within 5 points → lower weekly wins, then the reset-urgency score', () => {
    const w = chooseAccount(bal({ usage: snap({ s: 50, w: 10 }, { s: 4, w: 30, resetH: 5 }, { s: 8, w: 20, resetH: 150 }) }));
    expect(w.account).toBe('c');
    expect(w.reason).toMatch(/주간 C 20% < B 30%/);
    // 5h and weekly both tied: the account whose weekly resets sooner (higher score) wins.
    const s = chooseAccount(bal({ usage: snap({ s: 50, w: 10 }, { s: 6, w: 20, resetH: 150 }, { s: 3, w: 20, resetH: 10 }) }));
    expect(s.account).toBe('c');
    const s2 = chooseAccount(bal({ usage: snap({ s: 50, w: 10 }, { s: 3, w: 20, resetH: 10 }, { s: 6, w: 20, resetH: 150 }) }));
    expect(s2.account).toBe('b');
    // More than 5 points apart: 5h decides even against a much lower weekly.
    expect(chooseAccount(bal({ usage: snap({ s: 50, w: 10 }, { s: 2, w: 60 }, { s: 8, w: 0 }) })).account).toBe('b');
  });

  it('skips candidates past the force thresholds', () => {
    // B has the lowest 5h but is past the weekly 85 threshold; C is past the 5h 80 threshold.
    const d = chooseAccount(bal({ usage: snap({ s: 40, w: 10 }, { s: 0, w: 90 }, { s: 85, w: 0 }) }));
    expect(d.account).toBe('a');
  });

  it('protected account stays last even with the lowest 5h', () => {
    const { candidates } = rankCandidates(bal({ protectedAccount: 'a', usage: snap({ s: 0, w: 0 }, { s: 40, w: 50 }, { s: 20, w: 60 }) }));
    expect(candidates.map((c) => c.account)).toEqual(['c', 'b', 'a']);
    expect(chooseAccount(bal({ protectedAccount: 'a', usage: snap({ s: 0, w: 0 }, { s: 40, w: 50 }, { s: 20, w: 60 }) })).account).toBe('c');
  });

  it('nothing safe → falls back to the drain ordering', () => {
    // A protected; B over 5h 80; C over weekly 85 → no safe candidate.
    const usage = snap({ s: 0, w: 0 }, { s: 82, w: 10, resetH: 150 }, { s: 0, w: 88, resetH: 10 });
    const b = chooseAccount(bal({ protectedAccount: 'a', usage }));
    const d = chooseAccount(input({ protectedAccount: 'a', usage }));
    expect(b.account).toBe(d.account);
    expect(rankCandidates(bal({ protectedAccount: 'a', usage })).candidates.map((c) => c.account))
      .toEqual(rankCandidates(input({ protectedAccount: 'a', usage })).candidates.map((c) => c.account));
    expect(b.reason).toMatch(/안전한 후보 없음/);
  });

  it('cold session re-routes by the balance policy; a warm one stays', () => {
    const usage = reported();
    const cold = chooseAccount(bal({ current: 'b', protectedAccount: 'a', lastTurnAtMs: NOW - 2 * H, usage }));
    expect(cold).toMatchObject({ account: 'c', switched: true });
    expect(cold.reason).toMatch(/캐시 식음\(120분 경과\) → C · 분산: 5h C 0% < B 10%/);
    const compacted = chooseAccount(bal({ current: 'b', protectedAccount: 'a', lastTurnAtMs: NOW - 60_000, justCompacted: true, usage }));
    expect(compacted.account).toBe('c');
    const first = chooseAccount(bal({ current: 'b', protectedAccount: 'a', lastTurnAtMs: null, usage }));
    expect(first.account).toBe('c');
    const warm = chooseAccount(bal({ current: 'b', protectedAccount: 'a', lastTurnAtMs: NOW - 10 * 60_000, usage }));
    expect(warm).toMatchObject({ account: 'b', switched: false });
    expect(warm.reason).toMatch(/캐시 따뜻함/);
  });

  it('forced switches pick the target by the balance order (drain keeps the drain order)', () => {
    // A over 5h 80 → forced off. B resets in 5h (drain's pick), C has the lower 5h (balance's pick).
    const usage = snap({ s: 81, w: 10 }, { s: 30, w: 1, resetH: 5 }, { s: 10, w: 50, resetH: 150 });
    const forced = { current: 'a' as const, lastTurnAtMs: NOW - 60_000, usage };
    expect(chooseAccount(bal(forced))).toMatchObject({ account: 'c', switched: true });
    expect(chooseAccount(bal(forced)).reason).toMatch(/문턱 초과.* → C 전환/);
    expect(chooseAccount(input(forced))).toMatchObject({ account: 'b', switched: true });
    // Weekly ≥85 forces the switch the same way.
    const weekly = { current: 'a' as const, lastTurnAtMs: NOW - 60_000, usage: snap({ s: 10, w: 86 }, { s: 30, w: 1, resetH: 5 }, { s: 10, w: 50, resetH: 150 }) };
    expect(chooseAccount(bal(weekly)).account).toBe('c');
    expect(chooseAccount(input(weekly)).account).toBe('b');
  });

  it('forced switches never take the protected account while another is safe; pins still override', () => {
    // B forced (5h 82); A protected with the lowest 5h; C safe → C.
    const usage = snap({ s: 0, w: 0 }, { s: 82, w: 10 }, { s: 40, w: 50 });
    expect(chooseAccount(bal({ current: 'b', protectedAccount: 'a', lastTurnAtMs: NOW - 60_000, usage }))).toMatchObject({ account: 'c', switched: true });
    // C not safe either (weekly 88) and B still usable → stay on B, not A.
    const noSafe = snap({ s: 0, w: 0 }, { s: 82, w: 10 }, { s: 0, w: 88 });
    expect(chooseAccount(bal({ current: 'b', protectedAccount: 'a', lastTurnAtMs: NOW - 60_000, usage: noSafe }))).toMatchObject({ account: 'b', switched: false });
    // B unusable (≥95) and C gone (cooldown): only the protected account is left → A.
    const onlyA = snap({ s: 0, w: 0 }, { s: 96, w: 10 }, { s: 0, w: 10 });
    expect(chooseAccount(bal({ current: 'b', protectedAccount: 'a', lastTurnAtMs: NOW - 60_000, cooldownUntilMs: { c: NOW + 60_000 }, usage: onlyA })).account).toBe('a');
    // A pin wins over the forced switch.
    expect(chooseAccount(bal({ current: 'b', protectedAccount: 'a', lastTurnAtMs: NOW - 60_000, pinned: 'b', usage }))).toMatchObject({ account: 'b', pinned: true });
    const pinned = { current: 'b' as const, lastTurnAtMs: NOW - 60_000, pinned: 'a' as const, usage: reported() };
    expect(chooseAccount(bal(pinned))).toMatchObject({ account: 'a', pinned: true });
  });

  it('warm sessions stay put under balance, even when C is far lower', () => {
    const warm = chooseAccount(bal({ current: 'a', protectedAccount: 'a', lastTurnAtMs: NOW - 54 * 60_000, usage: reported() }));
    expect(warm).toMatchObject({ account: 'a', switched: false });
    expect(chooseAccount(bal({ current: 'a', protectedAccount: 'a', lastTurnAtMs: NOW - 55 * 60_000, usage: reported() })).account).toBe('c');
  });
});

describe('chooseAccount · default policy (no policy given = balance)', () => {
  it('new session spreads to C when C has the lowest 5h; protected A last', () => {
    const usage = snap({ s: 0, w: 0 }, { s: 30, w: 20 }, { s: 5, w: 40 });
    expect(chooseAccount(dflt({ protectedAccount: 'a', usage }))).toMatchObject({ account: 'c', switched: false });
    expect(rankCandidates(dflt({ protectedAccount: 'a', usage })).candidates.map((c) => c.account)).toEqual(['c', 'b', 'a']);
  });

  it('warm session stays; forced switch goes by balance order', () => {
    const usage = snap({ s: 81, w: 10 }, { s: 30, w: 1, resetH: 5 }, { s: 10, w: 50, resetH: 150 });
    expect(chooseAccount(dflt({ current: 'b', lastTurnAtMs: NOW - 10 * 60_000, usage }))).toMatchObject({ account: 'b', switched: false });
    expect(chooseAccount(dflt({ current: 'a', lastTurnAtMs: NOW - 60_000, usage }))).toMatchObject({ account: 'c', switched: true });
  });

  it('cold session: hysteresis — a marginal 5h difference does not move it, a large one does', () => {
    // On B (safe), C lower by exactly 5 points → stays.
    const near = chooseAccount(dflt({ current: 'b', protectedAccount: 'a', lastTurnAtMs: NOW - 2 * H, usage: snap({ s: 0, w: 0 }, { s: 20, w: 30 }, { s: 15, w: 10 }) }));
    expect(near).toMatchObject({ account: 'b', switched: false });
    expect(near.reason).toMatch(/현재 계정이 최적/);
    // C lower by 6 points → moves.
    expect(chooseAccount(dflt({ current: 'b', protectedAccount: 'a', lastTurnAtMs: NOW - 2 * H, usage: snap({ s: 0, w: 0 }, { s: 21, w: 30 }, { s: 15, w: 10 }) })))
      .toMatchObject({ account: 'c', switched: true });
    // Current is the protected account (never "safe") → no hysteresis: a 2-point win still moves it off A.
    expect(chooseAccount(dflt({ current: 'a', protectedAccount: 'a', lastTurnAtMs: NOW - 2 * H, usage: snap({ s: 18, w: 0 }, { s: 20, w: 30 }, { s: 16, w: 10 }) })).account).toBe('c');
    // Drain keeps its old cold-cache rule (no hysteresis).
    expect(chooseAccount(input({ current: 'a', lastTurnAtMs: NOW - 2 * H })).account).toBe('b');
  });

  it('a missing 5h row is unknown, not 0%: ranked after known values, still a safe candidate', () => {
    const usage = snap({ s: 0, w: 0 }, { s: 40, w: 30 }, { s: null, w: 10 });
    const { candidates } = rankCandidates(dflt({ protectedAccount: 'a', usage }));
    expect(candidates.map((c) => c.account)).toEqual(['b', 'c', 'a']);
    expect(candidates.find((c) => c.account === 'c')?.fiveHourKnown).toBe(false);
    const d = chooseAccount(dflt({ protectedAccount: 'a', usage }));
    expect(d.account).toBe('b');
    expect(d.reason).toMatch(/C 5h 값 없음/);
    expect(routeLogLine(null, d, testRegistry())).toMatch(/C 5h \? · 주간 10%/);
    // Unknown 5h but the only safe account: picked over the protected one and over unsafe ones.
    expect(chooseAccount(dflt({ protectedAccount: 'a', usage: snap({ s: 0, w: 0 }, { s: 85, w: 30 }, { s: null, w: 10 }) })).account).toBe('c');
  });
});

describe('routeLogLine', () => {
  it('one line: short session id, account, reason, candidates and exclusions', () => {
    const d = chooseAccount(input({ policy: 'balance', protectedAccount: 'a', cooldownUntilMs: { a: NOW + 60_000 }, usage: snap({ s: 0, w: 0 }, { s: 10, w: 22, resetH: 18 }, { s: 0, w: 0, resetH: 138 }) }));
    const line = routeLogLine('0123456789abcdef', d, testRegistry());
    expect(line).toMatch(/^deck: route 01234567 → C \(새 세션 · 분산: 5h C 0% < B 10%\)/);
    expect(line).toMatch(/후보 C 5h 0% · 주간 0%, B 5h 10% · 주간 22%/);
    expect(line).toMatch(/제외 A 쿨다운/);
    expect(line).not.toMatch(/\n/);
    expect(routeLogLine(null, d, testRegistry())).toMatch(/^deck: route 새 세션 → C/);
  });
});

describe('chooseAccount — accounts from a registry (not a/b/c)', () => {
  const reg = buildRegistry({ version: 1, home: 'w', accounts: [{ id: 'w', label: 'Work' }, { id: 'p' }, { id: 'old', retired: true }] }, { homeDir: '/h' });
  const usage = (accounts: Record<string, AccountUsage>): UsageSnapshot => ({ generatedAt: new Date(NOW).toISOString(), deckReachable: true, accounts });

  it('ranks only the active accounts of the registry and labels them', () => {
    const d = chooseAccount(input({ accounts: reg, protectedAccount: null, usage: usage({ w: acct({ w: 50 }), p: acct({ w: 10 }), old: acct({ w: 1 }), a: acct({ w: 1 }) }) }));
    expect(['w', 'p']).toContain(d.account);
    expect(d.candidates.map((c) => c.account).sort()).toEqual(['p', 'w']);
    expect(routeLogLine('s', { ...d, account: 'w' }, reg)).toContain('→ Work');
  });

  it('an account with no usage entry is not eligible, and nothing throws', () => {
    const d = chooseAccount(input({ accounts: reg, protectedAccount: null, usage: usage({ p: acct({ w: 10 }) }) }));
    expect(d.account).toBe('p');
  });

  it('nothing ranks → the registry fallback (not protected, not home), never a hard-coded b', () => {
    const d = chooseAccount(input({ accounts: reg, protectedAccount: null, usage: usage({}) }));
    expect(d.account).toBe('p');
    expect(chooseAccount(input({ accounts: reg, protectedAccount: 'p', usage: usage({}) })).account).toBe('w');
  });

  it('a pin on an account that is not active in the registry is ignored', () => {
    const d = chooseAccount(input({ accounts: reg, protectedAccount: null, pinned: 'old', usage: usage({ w: acct({ w: 50 }), p: acct({ w: 10 }), old: acct({ w: 1 }) }) }));
    expect(['w', 'p']).toContain(d.account);
    expect(d.pinned).toBeFalsy();
  });
});

describe('chooseAccount — 잔여량을 모르는 계정 (usage-deck 없음 · 일부 카드만 있음)', () => {
  const DOWN: Spec = { status: 'down' };
  const noDeck = snap(DOWN, DOWN, DOWN, false);
  const one = buildRegistry({ version: 1, accounts: [{ id: 'a' }] }, { homeDir: '/h' });
  const none: UsageSnapshot = { generatedAt: new Date(NOW).toISOString(), deckReachable: false, accounts: {} };

  it('no usage-deck: a new session goes in the fallback order (not protected, not home first; the protected one last)', () => {
    const d = chooseAccount(dflt({ protectedAccount: 'a', usage: noDeck }));
    expect(d).toMatchObject({ account: 'b', switched: false, unknown: ['b', 'c', 'a'], candidates: [] });
    expect(d.reason).toMatch(/자격 있는 계정 없음 → 잔여량 모름 · B/);
    expect(chooseAccount(dflt({ protectedAccount: 'b', usage: noDeck })).unknown).toEqual(['c', 'a', 'b']);
    expect(chooseAccount(dflt({ protectedAccount: null, usage: noDeck })).unknown).toEqual(['b', 'c', 'a']);
  });

  it('no usage-deck: an account in cooldown or ruled out this turn is not a candidate', () => {
    expect(chooseAccount(dflt({ protectedAccount: 'a', usage: noDeck, cooldownUntilMs: { b: NOW + 60_000 } }))).toMatchObject({ account: 'c', unknown: ['c', 'a'] });
    expect(chooseAccount(dflt({ protectedAccount: 'a', usage: noDeck, exclude: ['b', 'c'] }))).toMatchObject({ account: 'a', unknown: ['a'] });
  });

  it('no usage-deck: a session whose account hit its limit moves to the next account instead of failing there again', () => {
    const d = chooseAccount(dflt({ protectedAccount: 'a', current: 'b', lastTurnAtMs: NOW - 60_000, usage: noDeck, cooldownUntilMs: { b: NOW + 60_000 }, exclude: ['b'] }));
    expect(d).toMatchObject({ account: 'c', switched: true });
    expect(d.reason).toMatch(/쿨다운.*잔여량 모름 · C 전환/);
    // Nothing else left: stays.
    expect(chooseAccount(dflt({ accounts: one, protectedAccount: null, current: 'a', lastTurnAtMs: NOW - 60_000, usage: none, cooldownUntilMs: { a: NOW + 60_000 } }))).toMatchObject({ account: 'a', switched: false });
  });

  it('no usage-deck: a session stays on its account (warm or cold)', () => {
    expect(chooseAccount(dflt({ protectedAccount: 'a', current: 'c', lastTurnAtMs: NOW - 60_000, usage: noDeck }))).toMatchObject({ account: 'c', switched: false });
    expect(chooseAccount(dflt({ protectedAccount: 'a', current: 'c', lastTurnAtMs: NOW - 3 * H, usage: noDeck }))).toMatchObject({ account: 'c', switched: false });
  });

  it('one account only: it gets the turn — also when it is the protected one, and with Fable asked', () => {
    for (const protectedAccount of [null, 'a'] as const) {
      expect(chooseAccount(dflt({ accounts: one, protectedAccount, usage: none }))).toMatchObject({ account: 'a', switched: false, unknown: ['a'] });
      expect(chooseAccount(dflt({ accounts: one, protectedAccount, usage: none, needFable: true })).account).toBe('a');
      expect(chooseAccount(dflt({ accounts: one, protectedAccount, usage: none, current: 'a', lastTurnAtMs: NOW - 60_000 }))).toMatchObject({ account: 'a', switched: false });
      expect(chooseAccount(dflt({ accounts: one, protectedAccount, usage: none, pinned: 'a' }))).toMatchObject({ account: 'a', pinned: true });
    }
  });

  it('some cards only: an account with known room comes before every unknown one — the unknown ones stay listed', () => {
    const d = chooseAccount(dflt({ protectedAccount: 'a', usage: snap(DOWN, { s: 10, w: 20 }, {}) }));
    expect(d).toMatchObject({ account: 'b', unknown: ['c', 'a'] });
    expect(d.candidates.map((c) => c.account)).toEqual(['b']);
    // A stale card past the limit of trust is unknown too; one whose last numbers were at the limit is not.
    expect(chooseAccount(dflt({ usage: snap({ w: 10 }, { w: 10, status: 'stale', age: 601_000 }, { w: 97, status: 'stale', age: 601_000 }) })).unknown).toEqual(['b']);
  });

  it('some cards only: an unknown account beats one known to be at its limit', () => {
    const d = chooseAccount(dflt({ protectedAccount: null, usage: snap({ w: 96 }, { w: 99 }, DOWN) }));
    expect(d).toMatchObject({ account: 'c', switched: false });
    // A session on an account at its limit moves there.
    const m = chooseAccount(dflt({ protectedAccount: null, current: 'a', lastTurnAtMs: NOW - 60_000, usage: snap({ w: 96 }, { w: 99 }, DOWN) }));
    expect(m).toMatchObject({ account: 'c', switched: true });
    // Over the switch threshold only (not unusable): an unknown account is not worth a cache rewrite.
    expect(chooseAccount(dflt({ protectedAccount: null, current: 'a', lastTurnAtMs: NOW - 60_000, usage: snap({ w: 90 }, { w: 99 }, DOWN) }))).toMatchObject({ account: 'a', switched: false });
  });

  it('a known account, even the protected one, is taken before an unknown one', () => {
    expect(chooseAccount(dflt({ protectedAccount: 'a', usage: snap({ w: 10 }, DOWN, DOWN) })).account).toBe('a');
    const m = chooseAccount(dflt({ protectedAccount: 'a', current: 'b', lastTurnAtMs: NOW - 60_000, cooldownUntilMs: { b: NOW + 60_000 }, usage: snap({ w: 10 }, { w: 10 }, DOWN) }));
    expect(m).toMatchObject({ account: 'a', switched: true });
  });

  it('routeLogLine names the unknown accounts apart from the excluded ones', () => {
    const d = chooseAccount(dflt({ protectedAccount: 'a', cooldownUntilMs: { a: NOW + 60_000 }, usage: snap({ w: 10 }, { s: 10, w: 20 }, DOWN) }));
    const line = routeLogLine(null, d, testRegistry());
    expect(line).toMatch(/후보 B 5h 10% · 주간 20% · 잔여량 모름 C · 제외 A 쿨다운/);
    expect(line).not.toMatch(/제외[^·]*C/);
    expect(routeLogLine(null, chooseAccount(dflt({ protectedAccount: 'a', usage: noDeck })), testRegistry())).toMatch(/\(자격 있는 계정 없음 → 잔여량 모름 · B\) · 잔여량 모름 B, C, A$/);
  });
});

describe("chooseAccount — usage-deck 을 본 적 없는 설치 (usageSource: 'none')", () => {
  const DOWN: Spec = { status: 'down' };
  const lax = (u: UsageSnapshot): UsageSnapshot => ({ ...u, usageSource: 'none' });
  const noDeck = lax(snap(DOWN, DOWN, DOWN, false));
  const one = buildRegistry({ version: 1, accounts: [{ id: 'a' }] }, { homeDir: '/h' });
  const none: UsageSnapshot = { generatedAt: new Date(NOW).toISOString(), deckReachable: false, accounts: {}, usageSource: 'none' };

  it('a Fable turn goes to an account nothing is known about, as a Fable turn (no "→ Opus")', () => {
    const d = chooseAccount(dflt({ protectedAccount: 'a', needFable: true, usage: noDeck }));
    expect(d).toMatchObject({ account: 'b', switched: false, unknown: ['b', 'c', 'a'] });
    expect(d.reason).toBe('자격 있는 계정 없음 → 잔여량 모름 · B');
    for (const protectedAccount of [null, 'a'] as const) {
      const solo = chooseAccount(dflt({ accounts: one, protectedAccount, needFable: true, usage: none }));
      expect(solo).toMatchObject({ account: 'a', reason: '자격 있는 계정 없음 → 잔여량 모름 · A' });
      expect(chooseAccount(dflt({ accounts: one, protectedAccount, needFable: true, usage: none, current: 'a', lastTurnAtMs: NOW - 60_000 })).reason).not.toMatch(/Opus|Fable/);
    }
  });

  it('after a limit failure the next account takes the Fable turn; the cooled-down one is not an unknown candidate', () => {
    const d = chooseAccount(dflt({ protectedAccount: 'a', needFable: true, current: 'b', lastTurnAtMs: null, usage: noDeck, cooldownUntilMs: { b: NOW + 60_000 }, exclude: ['b'] }));
    expect(d).toMatchObject({ account: 'c', switched: true, unknown: ['c', 'a'] });
    expect(d.reason).toMatch(/^쿨다운\(~\d\d:\d\d\) → 잔여량 모름 · C 전환$/);
    expect(chooseAccount(dflt({ protectedAccount: 'a', needFable: true, usage: noDeck, cooldownUntilMs: { b: NOW + 60_000 } }))).toMatchObject({ account: 'c', unknown: ['c', 'a'] });
  });

  it('an account whose Fable value is not known stays eligible; a known Fable ≥ 80% is still out', () => {
    // What a no-deck install looks like after a turn: 5h and weekly from the turn itself, never a Fable row.
    const seen = lax(snap({ w: 10, f: null }, { w: 20, f: null }, DOWN));
    const r = rankCandidates(dflt({ needFable: true, usage: seen }));
    expect(r.candidates.map((c) => c.account).sort()).toEqual(['a', 'b']);
    expect(chooseAccount(dflt({ needFable: true, current: 'a', lastTurnAtMs: NOW - 60_000, usage: seen }))).toMatchObject({ account: 'a', switched: false, reason: expect.not.stringMatching(/Fable/) });

    const full = lax(snap({ w: 10, f: 85 }, { w: 20, f: null }, DOWN));
    expect(rankCandidates(dflt({ needFable: true, usage: full })).excluded.a).toBe('Fable 85%');
    expect(chooseAccount(dflt({ needFable: true, usage: full })).account).toBe('b');
    expect(chooseAccount(dflt({ needFable: true, current: 'a', lastTurnAtMs: NOW - 60_000, usage: full }))).toMatchObject({ account: 'b', switched: true });
    // Fable known to be full everywhere: an Opus turn, as with usage-deck.
    const d = chooseAccount(dflt({ needFable: true, usage: lax(snap({ w: 10, f: 85 }, { w: 20, f: 90 }, { w: 30, f: 80 })) }));
    expect(d.reason).toMatch(/^Fable 여유 계정 없음 → Opus · /);
  });

  it('only the protected account has Fable room: landing on it anyway keeps Fable; landing elsewhere is an Opus turn, and the decision carries it', () => {
    // Nothing else is known: the new session lands on the protected account whatever the model, so Fable runs there.
    const alone = lax(snap({ w: 10, f: 10 }, DOWN, DOWN));
    const stay = chooseAccount(dflt({ protectedAccount: 'a', needFable: true, usage: alone }));
    expect(stay.account).toBe('a');
    expect(stay.reason).not.toMatch(/Opus/);
    expect(stay.asOpus).toBeUndefined();
    // Another account is usable for Opus: Fable alone does not move the turn onto the protected one.
    const other = lax(snap({ w: 10, f: 10 }, { w: 20, f: 85 }, DOWN));
    const moved = chooseAccount(dflt({ protectedAccount: 'a', needFable: true, usage: other }));
    expect(moved.account).toBe('b');
    expect(moved.reason).toMatch(/^Fable 여유는 보호 계정뿐 → Opus · /);
    expect(moved.asOpus).toBe('Fable 여유는 보호 계정뿐');
    // With usage-deck: the same accounts, and where the turn lands on the protected account no false "→ Opus".
    expect(chooseAccount(dflt({ protectedAccount: 'a', needFable: true, usage: snap({ w: 10, f: 10 }, DOWN, DOWN) }))).toMatchObject({ account: 'a', reason: expect.not.stringMatching(/Opus/) });
    const strict = chooseAccount(dflt({ protectedAccount: 'a', needFable: true, usage: snap({ w: 10, f: 10 }, { w: 20, f: 85 }, DOWN) }));
    expect(strict).toMatchObject({ account: 'b', reason: expect.stringMatching(/^Fable 여유 계정 없음 → Opus · /) });
    expect(strict.asOpus).toBe('Fable 여유 계정 없음');
  });

  it('only the protected account is known and the session is on an unknown one (warm): it stays there as a Fable turn', () => {
    const NOFABLE: Spec = { status: 'down', f: null };
    const usage = lax(snap({ w: 10, f: 10 }, NOFABLE, NOFABLE));
    const d = chooseAccount(dflt({ protectedAccount: 'a', needFable: true, current: 'b', lastTurnAtMs: NOW - 60_000, usage }));
    expect(d).toMatchObject({ account: 'b', switched: false });
    expect(d.reason).not.toMatch(/Opus/);
    expect(d.asOpus).toBeUndefined();
    expect(modelOf(d, usage)).toBe('fable');
    // With usage-deck the same input is an Opus turn on B, as before.
    const strict = chooseAccount(dflt({ protectedAccount: 'a', needFable: true, current: 'b', lastTurnAtMs: NOW - 60_000, usage: { ...usage, usageSource: 'deck' } }));
    expect(strict).toMatchObject({ account: 'b', asOpus: 'Fable 잔여량 모름(usage-deck 값 없음)', reason: expect.stringMatching(/^Fable 잔여량 모름\(usage-deck 값 없음\) → Opus · /) });
  });

  it('every account cooling down, or at a known 5h/weekly limit: still a Fable turn — only a known Fable value at the limit means Opus', () => {
    const cooldownUntilMs = { a: NOW + 60_000, b: NOW + 60_000, c: NOW + 60_000 };
    const NOFABLE: Spec = { status: 'down', f: null };
    const cooling = lax(snap(NOFABLE, NOFABLE, NOFABLE, false));
    const d = chooseAccount(dflt({ protectedAccount: 'a', needFable: true, usage: cooling, cooldownUntilMs }));
    expect(d).toMatchObject({ account: 'b', reason: '자격 있는 계정 없음 → 최소 사용 B' });
    expect(d.asOpus).toBeUndefined();
    expect(modelOf(d, cooling)).toBe('fable');
    const limits = lax(snap({ w: 99, f: null }, { w: 98, f: null }, { w: 97, f: null }));
    const full = chooseAccount(dflt({ needFable: true, usage: limits }));
    expect(full.reason).toBe('자격 있는 계정 없음 → 최소 사용 C');
    expect(full.asOpus).toBeUndefined();
    expect(modelOf(full, limits)).toBe('fable');
    // The account it falls back to has a known Fable value at the limit: Opus, and the reason says why.
    const known = lax(snap({ w: 99, f: null }, { w: 98, f: null }, { w: 97, f: 85 }));
    expect(chooseAccount(dflt({ needFable: true, usage: known }))).toMatchObject({ account: 'c', asOpus: 'Fable 여유 계정 없음', reason: 'Fable 여유 계정 없음 → Opus · 자격 있는 계정 없음 → 최소 사용 C' });
  });

  it("with usage-deck ('deck', or no field) an unknown Fable value still means Opus — and the reason says it is unknown", () => {
    const DOWN: Spec = { status: 'down', f: null };
    for (const usage of [snap(DOWN, DOWN, DOWN, false), { ...snap(DOWN, DOWN, DOWN, false), usageSource: 'deck' as const }]) {
      const d = chooseAccount(dflt({ protectedAccount: 'a', needFable: true, usage }));
      expect(d.account).toBe('b');
      expect(d.reason).toBe('Fable 잔여량 모름(usage-deck 값 없음) → Opus · 자격 있는 계정 없음 → 잔여량 모름 · B');
      expect(d.asOpus).toBe('Fable 잔여량 모름(usage-deck 값 없음)');
    }
    expect(rankCandidates(dflt({ needFable: true, usage: snap({ w: 10, f: null }, { w: 20, f: null }, DOWN) })).excluded.a).toBe('Fable 값 없음');
  });
});

/** The model the runner runs a Fable turn on, given the decision (TurnRunner: `asOpus` first, else `resolveModel` on the account's Fable value). */
function modelOf(d: { account: Account; asOpus?: string }, usage: UsageSnapshot): string {
  return d.asOpus ? 'opus' : resolveModel('fable', 'fable', usage.accounts[d.account]?.fable?.usedPct ?? null, usage.usageSource).model;
}

describe('chooseAccount — 최종 리뷰: 이유 문구와 실행 모델', () => {
  const DOWN: Spec = { status: 'down', f: null };
  const sources = [undefined, 'deck', 'none'] as const;
  const withSource = (u: UsageSnapshot, s: (typeof sources)[number]): UsageSnapshot => (s ? { ...u, usageSource: s } : u);

  it('no candidate for a 5h limit while Fable has room (with usage-deck): the turn runs on Fable and the reason does not say "→ Opus" or "값 없음"', () => {
    for (const s of sources) {
      const usage = withSource(snap({ s: 96, w: 10, f: 10 }, { s: 96, w: 20, f: 10 }, { s: 96, w: 30, f: 10 }), s);
      const d = chooseAccount(dflt({ needFable: true, usage }));
      expect(d.candidates).toEqual([]);
      expect(d).toMatchObject({ account: 'a', reason: '자격 있는 계정 없음 → 최소 사용 A' });
      expect(d.asOpus).toBeUndefined();
      expect(modelOf(d, usage)).toBe('fable');
    }
  });

  it('no candidate and the account it falls back to has Fable at the limit, or (with usage-deck) no Fable value: Opus, with the true cause', () => {
    const at = snap({ s: 96, w: 10, f: 85 }, { s: 96, w: 20, f: 10 }, { s: 96, w: 30, f: 10 });
    for (const s of sources) {
      expect(chooseAccount(dflt({ needFable: true, usage: withSource(at, s) }))).toMatchObject({ account: 'a', asOpus: 'Fable 여유 계정 없음', reason: 'Fable 여유 계정 없음 → Opus · 자격 있는 계정 없음 → 최소 사용 A' });
    }
    const missing = snap({ s: 96, w: 10, f: null }, { s: 96, w: 20, f: 10 }, { s: 96, w: 30, f: 10 });
    expect(chooseAccount(dflt({ needFable: true, usage: missing }))).toMatchObject({ account: 'a', asOpus: 'Fable 잔여량 모름(usage-deck 값 없음)' });
    const laxD = chooseAccount(dflt({ needFable: true, usage: withSource(missing, 'none') }));
    expect(laxD.asOpus).toBeUndefined();
    expect(laxD.reason).not.toMatch(/Opus/);
  });

  it('whatever the usage: the reason says "→ Opus" exactly when the decision carries asOpus, and the cause it names is true of the account', () => {
    const specs: Spec[] = [{ w: 10, f: 10 }, { w: 10, f: 85 }, { w: 10, f: null }, { s: 96, w: 10, f: 10 }, { s: 96, w: 10, f: 85 }, { w: 99, f: null }, DOWN, { status: 'down', w: 10, f: 10 }, { status: 'stale', age: 1_200_000, w: 10, f: 10 }];
    const cools: Partial<Record<Account, number>>[] = [{}, { b: NOW + 60_000 }, { a: NOW + 60_000, b: NOW + 60_000, c: NOW + 60_000 }];
    let n = 0;
    for (const a of specs) for (const b of specs) for (const c of specs) for (const s of sources) for (const cooldownUntilMs of cools) for (const current of [null, 'b'] as const) for (const protectedAccount of [null, 'a'] as const) {
      const usage = withSource(snap(a, b, c), s);
      const d = chooseAccount(dflt({ needFable: true, usage, cooldownUntilMs, current, lastTurnAtMs: current ? NOW - 60_000 : null, protectedAccount }));
      const says = /→ Opus/.test(d.reason);
      expect(says, d.reason).toBe(d.asOpus !== undefined);
      const f = usage.accounts[d.account]?.fable?.usedPct ?? null;
      // "→ Opus" is never said of an account whose Fable value is known to have room …
      if (says) expect(f === null || f >= 80, `${d.reason} · Fable ${f}`).toBe(true);
      // … and its stated cause is true: "값 없음" only when that account has no Fable value.
      if (/값 없음\) → Opus/.test(d.reason)) expect(f, d.reason).toBeNull();
      // Without usage-deck, Opus needs a known value at the limit.
      if (says && s === 'none') expect(f, d.reason).not.toBeNull();
      n++;
    }
    expect(n).toBe(9 ** 3 * 3 * 3 * 2 * 2);
  });
});

describe('chooseAccount — 최종 리뷰: 잔여량 모름 계정의 순서', () => {
  const OLD = 1_200_000;

  it('usage-deck out for 20 minutes: among accounts of one rank the lowest last-known weekly goes first', () => {
    const usage = snap({ status: 'stale', age: OLD, w: 50 }, { status: 'stale', age: OLD, w: 90 }, { status: 'stale', age: OLD, w: 10 }, false);
    const d = chooseAccount(dflt({ usage }));
    expect(d.candidates).toEqual([]);
    expect(d).toMatchObject({ account: 'c', unknown: ['c', 'b', 'a'], reason: '자격 있는 계정 없음 → 잔여량 모름 · C' });
    // The rank still comes first: home after the others, the protected account last, whatever their weekly.
    const low = snap({ status: 'stale', age: OLD, w: 1 }, { status: 'stale', age: OLD, w: 90 }, { status: 'stale', age: OLD, w: 10 }, false);
    expect(chooseAccount(dflt({ usage: low })).unknown).toEqual(['c', 'b', 'a']);
    expect(chooseAccount(dflt({ usage: low, protectedAccount: 'c' })).unknown).toEqual(['b', 'a', 'c']);
  });

  it('an account with no weekly value at all follows those with one; equal values keep the registry order', () => {
    const usage = snap({ status: 'stale', age: OLD, w: 50 }, { status: 'down' }, { status: 'stale', age: OLD, w: 60 }, false);
    expect(rankCandidates(dflt({ usage })).unknown).toEqual(['c', 'b', 'a']);
    const same = snap({ status: 'down' }, { status: 'stale', age: OLD, w: 40 }, { status: 'stale', age: OLD, w: 40 }, false);
    expect(rankCandidates(dflt({ usage: same })).unknown).toEqual(['b', 'c', 'a']);
  });

  it('the current account cooling down, another at its 5h limit, the third with a down card: the turn moves to the unknown one (not "stay")', () => {
    const d = chooseAccount(dflt({ current: 'b', lastTurnAtMs: NOW - 60_000, cooldownUntilMs: { b: NOW + 60_000 }, usage: snap({ s: 96, w: 10 }, { w: 20 }, { status: 'down' }) }));
    expect(d).toMatchObject({ account: 'c', switched: true, candidates: [], unknown: ['c'] });
    expect(d.reason).toMatch(/^쿨다운\(~\d\d:\d\d\) → 잔여량 모름 · C 전환$/);
  });
});
