import { describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UsageService, parseDeckState, parseDeckCards, type FetchLike } from './UsageService';
import { buildRegistry } from '../../shared/accounts';
import { remainingPct, usageOf, emptySnapshot } from '../../shared/usage-types';
import { rankCandidates } from '../routing/AccountRouter';
import { testRegistry } from '../../shared/accounts.testkit';

const LIVE = {
  generatedAt: '2026-09-30T12:27:02.000Z',
  cards: [
    { id: 'claude:main', status: 'ok', fetchedAt: '2026-09-30T12:27:01.422Z', rows: [
      { label: 'Session (5h)', used: 13, cap: 100, unit: '%', resetsAt: '2026-09-30T15:09:59.684Z' },
      { label: 'Weekly (7d)', used: 7, cap: 100, unit: '%', resetsAt: '2026-10-06T22:59:59.684Z' },
      { label: 'Fable (7d)', used: 0, cap: 100, unit: '%', resetsAt: '2026-10-06T23:00:00.000Z' } ] },
    { id: 'claude:second', status: 'stale', fetchedAt: '2026-09-30T12:20:00.000Z', rows: [
      { label: 'Session (5h)', used: 2, cap: 100, unit: '%', resetsAt: '2026-09-30T15:30:00.148Z' },
      { label: 'Weekly (7d)', used: 3, cap: 100, unit: '%', resetsAt: '2026-10-04T09:00:00.148Z' } ] },
    { id: 'codex', status: 'setup_needed', rows: [] },
  ],
};

describe('parseDeckState', () => {
  it('maps cards to accounts, rows by label prefix, missing card → down', () => {
    const acc = parseDeckState(LIVE, testRegistry());
    expect(acc.a!.status).toBe('ok');
    expect(acc.a!.fiveHour).toEqual({ usedPct: 13, resetsAt: '2026-09-30T15:09:59.684Z' });
    expect(acc.a!.weekly?.usedPct).toBe(7);
    expect(acc.a!.fable?.usedPct).toBe(0);
    expect(acc.b!.status).toBe('stale');
    expect(acc.b!.fetchedAt).toBe('2026-09-30T12:20:00.000Z');
    expect(acc.b!.fable).toBeNull();
    expect(acc.c!.status).toBe('down');
    expect(acc.c!.weekly).toBeNull();
  });

  it('first label match wins even when its value is missing (claude-pick rows_of)', () => {
    const acc = parseDeckState({ cards: [{ id: 'claude:main', status: 'ok', rows: [
      { label: 'Weekly (7d)', used: null }, { label: 'Weekly (7d) · 2', used: 50 },
      { label: 'Session (5h)', used: 20 }, { label: 'Session (5h) old', used: 90 } ] }] }, testRegistry());
    expect(acc.a!.weekly).toBeNull();
    expect(acc.a!.fiveHour?.usedPct).toBe(20);
  });

  it('tolerates garbage', () => {
    expect(parseDeckState(null, testRegistry()).a!.status).toBe('down');
    expect(parseDeckState({ cards: [{ id: 'claude:main', status: 'ok', rows: [{ label: 'Weekly (7d)', used: 'x' }] }] }, testRegistry()).a!.weekly).toBeNull();
  });
});

describe('remainingPct', () => {
  it('is 100 - used, clamped', () => {
    expect(remainingPct({ usedPct: 13, resetsAt: null })).toBe(87);
    expect(remainingPct({ usedPct: 120, resetsAt: null })).toBe(0);
    expect(remainingPct(null)).toBeNull();
  });
});

describe('UsageService', () => {
  function svc(fetchFn: any, now = () => new Date('2026-09-30T12:30:00Z')) {
    return new UsageService({ accounts: testRegistry(), deckUrl: 'http://deck.test:9310/', fetchFn, intervalMs: 60_000, now });
  }

  it('polls <deckUrl>/api/state and exposes a snapshot', async () => {
    const fetchFn = vi.fn(async (_url: string) => ({ ok: true, json: async () => LIVE }));
    const s = svc(fetchFn);
    await s.pollOnce();
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://deck.test:9310/api/state');
    const snap = s.snapshot();
    expect(snap.deckReachable).toBe(true);
    expect(snap.accounts.a!.weekly?.usedPct).toBe(7);
    expect(snap.generatedAt).toBe('2026-09-30T12:30:00.000Z');
  });

  it('keeps the last values but marks them stale when the deck is unreachable', async () => {
    let fail = false;
    const fetchFn = vi.fn(async () => { if (fail) throw new Error('ECONNREFUSED'); return { ok: true, json: async () => LIVE }; });
    const s = svc(fetchFn);
    await s.pollOnce();
    fail = true;
    await s.pollOnce();
    const snap = s.snapshot();
    expect(snap.deckReachable).toBe(false);
    expect(snap.accounts.a!.status).toBe('stale');
    expect(snap.accounts.a!.fetchedAt).toBe('2026-09-30T12:27:01.422Z');
    expect(snap.accounts.a!.weekly?.usedPct).toBe(7);
  });

  it('applyTurn overrides 5h/weekly from the SDK rate_limit_event and notifies', async () => {
    const s = svc(async () => ({ ok: true, json: async () => LIVE }));
    await s.pollOnce();
    const seen: number[] = [];
    s.onChange((snap) => seen.push(snap.accounts.a!.fiveHour?.usedPct ?? -1));
    s.applyTurn('a', { fiveHour: { usedPct: 20, resetsAt: '2026-09-30T15:09:59.000Z' }, weekly: { usedPct: 8, resetsAt: '2026-10-06T22:59:59.000Z' } });
    expect(s.snapshot().accounts.a!.fiveHour?.usedPct).toBe(20);
    expect(s.snapshot().accounts.a!.weekly?.usedPct).toBe(8);
    expect(s.snapshot().accounts.a!.fable?.usedPct).toBe(0);
    expect(seen).toEqual([20]);
  });

  it('a poll keeps per-turn windows observed after the card was fetched, and drops them once the deck is newer', async () => {
    let state: unknown = LIVE; // card a fetchedAt 12:27:01
    const s = svc(async () => ({ ok: true, json: async () => state }));
    await s.pollOnce();
    s.applyTurn('a', { fiveHour: { usedPct: 20, resetsAt: null } }); // observed 12:30
    await s.pollOnce();
    expect(s.snapshot().accounts.a!.fiveHour?.usedPct).toBe(20);
    expect(s.snapshot().accounts.a!.weekly?.usedPct).toBe(7);
    const newer = structuredClone(LIVE);
    newer.cards[0]!.fetchedAt = '2026-09-30T12:31:00.000Z';
    newer.cards[0]!.rows[0]!.used = 22;
    state = newer;
    await s.pollOnce();
    expect(s.snapshot().accounts.a!.fiveHour?.usedPct).toBe(22);
    state = LIVE; // an older card again must not resurrect the dropped turn values
    await s.pollOnce();
    expect(s.snapshot().accounts.a!.fiveHour?.usedPct).toBe(13);
  });

  it('a card that recovers (setup_needed → ok) gets fresh status and fetchedAt', async () => {
    const down = structuredClone(LIVE);
    down.cards[0] = { id: 'claude:main', status: 'setup_needed', rows: [] } as never;
    let state: unknown = down;
    const s = svc(async () => ({ ok: true, json: async () => state }));
    await s.pollOnce();
    expect(s.snapshot().accounts.a).toMatchObject({ status: 'down', fetchedAt: null });
    state = LIVE;
    await s.pollOnce();
    expect(s.snapshot().accounts.a).toMatchObject({ status: 'ok', fetchedAt: '2026-09-30T12:27:01.422Z' });
    expect(s.snapshot().accounts.a!.weekly?.usedPct).toBe(7);
  });

  it('a fresh successful deck turn lifts a setup_needed card (down) for routing only, for 30 min; the UI keeps the real status', async () => {
    let nowMs = Date.parse('2026-09-30T12:30:00Z'); // card fetchedAt 12:27:01 → fresh
    const expired = structuredClone(LIVE);
    // usage-deck's own token expired: setup_needed, last-known rows still on the card.
    expired.cards[0] = { ...expired.cards[0]!, status: 'setup_needed' };
    const s = svc(async () => ({ ok: true, json: async () => expired }), () => new Date(nowMs));
    await s.pollOnce();
    expect(s.snapshot().accounts.a!.status).toBe('down');
    expect(s.routingSnapshot()).toBe(s.snapshot()); // nothing to lift yet
    const seen: string[] = [];
    s.onChange((snap) => seen.push(snap.accounts.a!.status));
    s.noteTurnOk('a');
    expect(seen).toEqual([]); // nothing published: the re-login signal stays on screen
    expect(s.snapshot().accounts.a).toMatchObject({ status: 'down', weekly: { usedPct: 7 } });
    // Card fresh: lifted with all its rows, Fable included.
    expect(s.routingSnapshot().accounts.a).toMatchObject({ status: 'ok', weekly: { usedPct: 7 }, fable: { usedPct: 0 } });
    expect(s.routingSnapshot().accounts.b).toBe(s.snapshot().accounts.b); // other cards untouched
    nowMs += 20 * 60_000;
    await s.pollOnce();
    expect(s.snapshot().accounts.a!.status).toBe('down');
    // The back-filled rows are now 23 min old and no turn observed them: not lifted (the router keeps excluding it).
    expect(s.routingSnapshot().accounts.a!.status).toBe('down');
    // A fresh turn observation makes 5h/weekly current again; Fable is never refreshed by a turn → dropped.
    s.applyTurn('a', { fiveHour: { usedPct: 20, resetsAt: null }, weekly: { usedPct: 9, resetsAt: null } });
    expect(s.routingSnapshot().accounts.a).toMatchObject({ status: 'ok', fiveHour: { usedPct: 20 }, weekly: { usedPct: 9 }, fable: null });
    expect(s.snapshot().accounts.a!.status).toBe('down');
    expect(seen.every((x) => x === 'down')).toBe(true);
    nowMs += 9 * 60_000; // 29 min after the turn, observation 9 min old
    await s.pollOnce();
    expect(s.routingSnapshot().accounts.a!.status).toBe('ok');
    nowMs += 2 * 60_000; // 31 min after the turn
    await s.pollOnce();
    expect(s.routingSnapshot().accounts.a!.status).toBe('down');
  });

  it('noteTurnOk leaves ok/stale cards alone and does not invent numbers for an empty card', async () => {
    const empty = structuredClone(LIVE);
    empty.cards[0] = { id: 'claude:main', status: 'setup_needed', rows: [] } as never;
    const s = svc(async () => ({ ok: true, json: async () => empty }));
    await s.pollOnce();
    s.noteTurnOk('b');
    expect(s.routingSnapshot().accounts.b!.status).toBe('stale');
    s.noteTurnOk('a');
    // No fetchedAt and no observation: nothing fresh to route on, stays down.
    expect(s.routingSnapshot().accounts.a!.status).toBe('down');
    // An observation with only 5h: lifted, but with no weekly value the router still leaves it out ('주간 사용률 없음').
    s.applyTurn('a', { fiveHour: { usedPct: 5, resetsAt: null } });
    expect(s.snapshot().accounts.a!.status).toBe('down');
    expect(s.routingSnapshot().accounts.a).toMatchObject({ status: 'ok', weekly: null, fable: null });
  });

  it('routing on a lifted card: Fable only from a fresh card (needFable excludes otherwise); nothing fresh → excluded', async () => {
    const nowMs = Date.parse('2026-09-30T12:50:00Z'); // card fetchedAt 12:27:01 → 23 min old
    const expired = structuredClone(LIVE);
    expired.cards[0] = { ...expired.cards[0]!, status: 'setup_needed' };
    const s = svc(async () => ({ ok: true, json: async () => expired }), () => new Date(nowMs));
    await s.pollOnce();
    s.noteTurnOk('a');
    const rank = (needFable: boolean) => rankCandidates({ current: null, usage: s.routingSnapshot(), nowMs, lastTurnAtMs: null, justCompacted: false, cooldownUntilMs: {}, protectedAccount: null, needFable, accounts: testRegistry() });
    // No fresh observation: still down for routing.
    expect(rank(false).excluded.a).toBe('잔여량 정보 없음');
    s.applyTurn('a', { fiveHour: { usedPct: 20, resetsAt: null }, weekly: { usedPct: 9, resetsAt: null } });
    expect(rank(false).candidates.map((c) => c.account)).toContain('a');
    // The card's Fable 0% is 23 min old and frozen: not trusted for a Fable turn.
    expect(rank(true).excluded.a).toBe('Fable 값 없음');
      });

  it('a lift needs each window it would use to be fresh: a fresh 5h-only observation does not vouch for an old weekly', async () => {
    const setup = async (nowIso: string) => {
      const nowMs = Date.parse(nowIso);
      const expired = structuredClone(LIVE);
      expired.cards[0] = { ...expired.cards[0]!, status: 'setup_needed' }; // fetchedAt 12:27:01
      const s = svc(async () => ({ ok: true, json: async () => expired }), () => new Date(nowMs));
      await s.pollOnce();
      return { s, nowMs };
    };
    // (1) Card 3h old; weekly observed 3h ago, then a fresh 5h-only observation → not lifted.
    const one = await setup('2026-09-30T15:30:00Z');
    one.s.applyTurn('a', { weekly: { usedPct: 93, resetsAt: null } }, one.nowMs - 3 * 3_600_000);
    one.s.applyTurn('a', { fiveHour: { usedPct: 4, resetsAt: null } }, one.nowMs);
    one.s.noteTurnOk('a');
    expect(one.s.routingSnapshot().accounts.a!.status).toBe('down');
    // A card 5h value with only a fresh weekly observation is just as old → not lifted either.
    const half = await setup('2026-09-30T15:30:00Z');
    half.s.applyTurn('a', { weekly: { usedPct: 20, resetsAt: null } }, half.nowMs);
    half.s.noteTurnOk('a');
    expect(half.s.routingSnapshot().accounts.a!.status).toBe('down');
    // (2) Fresh weekly and fresh 5h observations (one event or two) → lifted, Fable dropped.
    const two = await setup('2026-09-30T15:30:00Z');
    two.s.applyTurn('a', { weekly: { usedPct: 20, resetsAt: null } }, two.nowMs - 60_000);
    two.s.applyTurn('a', { fiveHour: { usedPct: 4, resetsAt: null } }, two.nowMs);
    two.s.noteTurnOk('a');
    expect(two.s.routingSnapshot().accounts.a).toMatchObject({ status: 'ok', fiveHour: { usedPct: 4 }, weekly: { usedPct: 20 }, fable: null });
    // (3) Card itself fresh → lifted as before, even with an old observation on top.
    const three = await setup('2026-09-30T12:30:00Z');
    three.s.applyTurn('a', { weekly: { usedPct: 8, resetsAt: null } }, three.nowMs - 3 * 3_600_000);
    three.s.noteTurnOk('a');
    expect(three.s.routingSnapshot().accounts.a).toMatchObject({ status: 'ok', fable: { usedPct: 0 } });
  });

  it('start() polls on an interval and stop() halts it', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => LIVE }));
    const s = svc(fetchFn);
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    s.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('GPT usage (D5)', () => {
  const codexOk = { id: 'codex', status: 'ok', fetchedAt: '2026-09-30T12:00:00Z', rows: [{ label: 'Weekly (7d)', used: 40, resetsAt: '2026-10-03T18:10:34.000Z' }] };
  const codexSetup = { id: 'codex', status: 'setup_needed', fetchedAt: '2026-09-30T06:14:10.724Z', rows: [{ label: 'Weekly (7d)', used: 100, note: 'plan: pro · limit reached' }], error: 'HTTP 401', hint: 'codex login' };

  it('parses the codex card when ok; setup_needed is down with no rows (they are stale and wrong)', () => {
    expect(parseDeckCards({ cards: [codexOk] }, testRegistry()).gpt).toEqual({ status: 'ok', fetchedAt: '2026-09-30T12:00:00Z', fiveHour: null, weekly: { usedPct: 40, resetsAt: '2026-10-03T18:10:34.000Z' }, fable: null });
    expect(parseDeckCards({ cards: [codexSetup] }, testRegistry()).gpt).toEqual({ status: 'down', fetchedAt: '2026-09-30T06:14:10.724Z', fiveHour: null, weekly: null, fable: null });
    expect(parseDeckCards({ cards: [] }, testRegistry()).gpt.status).toBe('down');
  });

  it('applyTurn("gpt") corrects the snapshot until the deck card is newer', async () => {
    let state: unknown = { cards: [codexSetup] };
    const u = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => state }), now: () => new Date('2026-09-30T12:30:00Z') });
    await u.pollOnce();
    expect(u.snapshot().gpt?.weekly).toBeNull();
    expect(u.snapshot().gpt?.status).toBe('down');
    u.applyTurn('gpt', { weekly: { usedPct: 40, resetsAt: '2026-10-03T18:10:34.000Z' } });
    expect(u.snapshot().gpt?.weekly?.usedPct).toBe(40);
    // PF12: fresh rollout rate limits mean the seat is known even though the usage-deck card is setup_needed.
    expect(u.snapshot().gpt?.status).toBe('ok');
    await u.pollOnce(); // card still older than the observation → correction kept
    expect(u.snapshot().gpt?.weekly?.usedPct).toBe(40);
    expect(u.snapshot().gpt?.status).toBe('ok');
    state = { cards: [{ ...codexOk, fetchedAt: '2026-09-30T13:00:00Z', rows: [{ label: 'Weekly (7d)', used: 41 }] }] };
    await u.pollOnce();
    expect(u.snapshot().gpt?.weekly?.usedPct).toBe(41);
    expect(u.snapshot().accounts.b!.status).toBe('down'); // Claude cards untouched by the gpt card
  });

  it('down card with newer fetchedAt keeps the rollout observation', async () => {
    let state: unknown = { cards: [codexSetup] };
    const u = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => state }), now: () => new Date('2026-09-30T12:30:00Z') });
    await u.pollOnce();
    u.applyTurn('gpt', { weekly: { usedPct: 40, resetsAt: '2026-10-03T18:10:34.000Z' } });
    // A setup_needed card re-fetched after the observation carries no usable numbers → the observation stays.
    state = { cards: [{ ...codexSetup, fetchedAt: '2026-09-30T13:00:00Z' }] };
    await u.pollOnce();
    expect(u.snapshot().gpt).toMatchObject({ status: 'ok', weekly: { usedPct: 40 } });
    state = { cards: [{ ...codexOk, fetchedAt: '2026-09-30T13:05:00Z', rows: [{ label: 'Weekly (7d)', used: 41 }] }] };
    await u.pollOnce();
    expect(u.snapshot().gpt?.weekly?.usedPct).toBe(41);
  });

  it('an observation older than the one kept is ignored (F3: a rollout poll never undoes a newer turn reading)', () => {
    const u = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', now: () => new Date('2026-09-30T12:30:00Z') });
    u.applyTurn('gpt', { weekly: { usedPct: 50, resetsAt: '2026-10-03T18:10:34.000Z' } }, Date.parse('2026-09-30T12:20:00Z'));
    u.applyTurn('gpt', { weekly: { usedPct: 10, resetsAt: '2026-10-03T18:10:34.000Z' } }, Date.parse('2026-09-30T12:10:00Z'));
    expect(u.snapshot().gpt).toMatchObject({ status: 'ok', weekly: { usedPct: 50 }, fetchedAt: '2026-09-30T12:20:00.000Z' });
  });

  it('an observation whose windows have all reset since is shown stale, also after a poll (F3)', async () => {
    const u = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [codexSetup] }) }), now: () => new Date('2026-10-05T00:00:00Z') });
    u.applyTurn('gpt', { weekly: { usedPct: 100, resetsAt: '2026-10-03T18:10:34.000Z' } }, Date.parse('2026-10-01T02:16:46Z'));
    expect(u.snapshot().gpt).toMatchObject({ status: 'stale', weekly: { usedPct: 100 } });
    await u.pollOnce();
    expect(u.snapshot().gpt?.status).toBe('stale');
  });
});


describe('usage with a registry (not a/b/c)', () => {
  const reg = buildRegistry({ version: 1, accounts: [{ id: 'a' }, { id: 'work', card: 'claude:team' }, { id: 'x', retired: true }] }, { homeDir: '/h' });

  it('parseDeckCards reads each configured account from its card id, retired ones included', () => {
    const s = parseDeckCards({ cards: [{ id: 'claude:team', status: 'ok', rows: [] }, { id: 'claude:second', status: 'ok', rows: [] }] }, reg);
    expect(Object.keys(s.accounts)).toEqual(['a', 'work', 'x']);
    expect(s.accounts.work!.status).toBe('ok');
    expect(s.accounts.a!.status).toBe('down');
  });

  it('usageOf: a snapshot without the key reads as an empty (down) account, never undefined', () => {
    const s = emptySnapshot(new Date(0), ['a']);
    expect(Object.keys(s.accounts)).toEqual(['a']);
    expect(usageOf(s, 'work')).toMatchObject({ status: 'down', weekly: null, fiveHour: null });
    expect(usageOf(s, 'constructor').status).toBe('down');
  });
});

describe('UsageService · usageSource (usage-deck 을 본 적이 있는가)', () => {
  const NOW_ISO = '2026-10-06T12:00:00.000Z';
  const okFetch = async () => ({ ok: true, json: async () => ({ cards: [] }) });
  const failFetch = async () => { throw new Error('ECONNREFUSED'); };
  async function tmp() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'deck-usage-source-'));
    return path.join(dir, 'usage-source.json');
  }
  const make = (o: { file?: string; strict?: boolean | null; configured?: boolean; fetchFn?: FetchLike; log?: (l: string) => void }) =>
    new UsageService({ deckUrl: 'http://x', fetchFn: o.fetchFn ?? failFetch, now: () => new Date(NOW_ISO), accounts: testRegistry(), ...(o.file ? { usageSourceFile: o.file } : {}), ...(o.strict === undefined ? {} : { strict: o.strict }), ...(o.configured === undefined ? {} : { deckConfigured: o.configured }), ...(o.log ? { log: o.log } : {}) });

  it('neither a record file nor the switch given: the snapshot carries no usageSource (read as deck)', async () => {
    const s = make({});
    expect(s.snapshot()).not.toHaveProperty('usageSource');
    await s.pollOnce();
    expect(s.snapshot()).not.toHaveProperty('usageSource');
    expect(s.routingSnapshot()).not.toHaveProperty('usageSource');
  });

  it('DECK_USAGE_STRICT wins over everything: 1 → deck, 0 → none', async () => {
    const seen = await tmp();
    await fsp.writeFile(seen, JSON.stringify({ deckSeenAt: NOW_ISO }));
    const lax = make({ file: seen, strict: false, fetchFn: okFetch });
    expect(lax.snapshot().usageSource).toBe('none');
    await lax.pollOnce();
    expect(lax.snapshot().usageSource).toBe('none');
    const strict = make({ file: await tmp(), strict: true });
    await strict.pollOnce();
    expect(strict.snapshot().usageSource).toBe('deck');
  });

  it('no record, usage-deck address not set by the user: deck until the first fetch attempt ends; then none if it failed', async () => {
    const file = await tmp();
    const s = make({ file });
    expect(s.snapshot().usageSource).toBe('deck');
    await s.pollOnce();
    expect(s.snapshot()).toMatchObject({ deckReachable: false, usageSource: 'none' });
    expect(s.routingSnapshot().usageSource).toBe('none');
    await expect(fsp.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    // A turn's own numbers do not make it a usage-deck install.
    s.applyTurn('a', { fiveHour: { usedPct: 20, resetsAt: null }, weekly: { usedPct: 9, resetsAt: null } });
    expect(s.snapshot().usageSource).toBe('none');
  });

  it('no record, usage-deck address set by the user: deck also after a failed first fetch (late or down, not absent)', async () => {
    const file = await tmp();
    const s = make({ file, configured: true });
    expect(s.snapshot().usageSource).toBe('deck');
    await s.pollOnce();
    expect(s.snapshot()).toMatchObject({ deckReachable: false, usageSource: 'deck' });
    expect(s.routingSnapshot().usageSource).toBe('deck');
    // Nothing is written until usage-deck itself answers.
    await expect(fsp.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    // The same without the option (false): the first fetch decides.
    const unset = make({ file, configured: false });
    await unset.pollOnce();
    expect(unset.snapshot().usageSource).toBe('none');
  });

  it('DECK_USAGE_STRICT=0 wins over a usage-deck address set by the user', async () => {
    const s = make({ file: await tmp(), strict: false, configured: true });
    expect(s.snapshot().usageSource).toBe('none');
    await s.pollOnce();
    expect(s.snapshot().usageSource).toBe('none');
  });

  it('the first answer from usage-deck is recorded once (0600) and survives a restart and later outages', async () => {
    const file = await tmp();
    let up = false;
    const s = make({ file, fetchFn: async () => (up ? okFetch() : failFetch()) });
    await s.pollOnce();
    expect(s.snapshot().usageSource).toBe('none');
    up = true;
    await s.pollOnce();
    expect(s.snapshot().usageSource).toBe('deck');
    expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toEqual({ deckSeenAt: NOW_ISO });
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fsp.readdir(path.dirname(file)))).toEqual(['usage-source.json']);
    // Not written again.
    await fsp.writeFile(file, JSON.stringify({ deckSeenAt: '2026-01-01T00:00:00.000Z' }));
    await s.pollOnce();
    expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toEqual({ deckSeenAt: '2026-01-01T00:00:00.000Z' });
    up = false;
    await s.pollOnce();
    expect(s.snapshot().usageSource).toBe('deck');
    // After a restart with usage-deck down: still a usage-deck install, before and after the first attempt.
    const again = make({ file });
    expect(again.snapshot().usageSource).toBe('deck');
    await again.pollOnce();
    expect(again.snapshot().usageSource).toBe('deck');
  });

  it('an answer that is not usage-deck\'s (HTTP error, no cards list) is not a sighting', async () => {
    const file = await tmp();
    const s = make({ file, fetchFn: async () => ({ ok: true, json: async () => ({ hello: 'world' }) }) });
    await s.pollOnce();
    expect(s.snapshot().usageSource).toBe('none');
    const e = make({ file, fetchFn: async () => ({ ok: false, json: async () => ({ cards: [] }) }) });
    await e.pollOnce();
    expect(e.snapshot().usageSource).toBe('none');
    await expect(fsp.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([['not JSON', '{'], ['no deckSeenAt', '{}'], ['not a time', '{"deckSeenAt":"soon"}'], ['not an object', '[]']])('a broken record (%s) reads as deck, with one log line', async (_n, body) => {
    const file = await tmp();
    await fsp.writeFile(file, body);
    const logs: string[] = [];
    const s = make({ file, log: (l) => logs.push(l) });
    expect(s.snapshot().usageSource).toBe('deck');
    await s.pollOnce();
    await s.pollOnce();
    expect(s.snapshot().usageSource).toBe('deck');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(file);
    expect(await fsp.readFile(file, 'utf8')).toBe(body);
  });
});
