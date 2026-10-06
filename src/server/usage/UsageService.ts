import fs from 'node:fs';
import path from 'node:path';
import { type Account, type AccountNames, type UsageSeat } from '../../shared/accounts';
import { emptyAccountUsage, emptySnapshot, parseIsoUtc, usageOf, type AccountUsage, type GptCredits, type UsageSnapshot, type UsageWindow } from '../../shared/usage-types';
import { STALE_MAX_MS } from '../routing/AccountRouter';

export type TurnWindows = { fiveHour?: UsageWindow; weekly?: UsageWindow; /** GPT only (Codex rollout) */ credits?: GptCredits };

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export const GPT_CARD_ID = 'codex';
/** How long a successful deck turn on a Claude account outweighs a `down` (e.g. setup_needed) card for routing. */
export const TURN_OK_TRUST_MS = 30 * 60_000;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** Row labels start with "Session (5h)", "Weekly (7d)", "Fable (7d)"; the first matching row per kind wins even if its value is unusable (claude-pick rule). */
function rowsOf(card: Record<string, unknown>): Pick<AccountUsage, 'fiveHour' | 'weekly' | 'fable'> {
  const out: Pick<AccountUsage, 'fiveHour' | 'weekly' | 'fable'> = { fiveHour: null, weekly: null, fable: null };
  const rows = Array.isArray(card.rows) ? card.rows : [];
  const seen = new Set<keyof typeof out>();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    const label = String(row.label ?? '').toLowerCase();
    const kind = label.includes('fable') ? 'fable' : label.startsWith('session') ? 'fiveHour' : label.startsWith('weekly') ? 'weekly' : null;
    if (!kind || seen.has(kind)) continue;
    seen.add(kind);
    const used = num(row.used);
    if (used === null) continue;
    out[kind] = { usedPct: used, resetsAt: str(row.resetsAt) };
  }
  return out;
}

function cardsById(json: unknown): Map<string, Record<string, unknown>> {
  const cards = json && typeof json === 'object' && Array.isArray((json as { cards?: unknown }).cards)
    ? ((json as { cards: unknown[] }).cards as unknown[])
    : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const c of cards) if (c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string') byId.set((c as { id: string }).id, c as Record<string, unknown>);
  return byId;
}

/** One entry per account of `reg` (retired ones too: their usage stays visible). */
export function parseDeckCards(json: unknown, reg: AccountNames): { accounts: Record<Account, AccountUsage>; gpt: AccountUsage } {
  const byId = cardsById(json);
  const accounts: Record<Account, AccountUsage> = {};
  for (const account of reg.all()) {
    accounts[account] = emptyAccountUsage();
    const card = byId.get(reg.cardId(account));
    if (!card) continue;
    const status = card.status === 'ok' ? 'ok' : card.status === 'stale' ? 'stale' : 'down';
    accounts[account] = { status, fetchedAt: str(card.fetchedAt), ...rowsOf(card) };
  }
  // D5: the codex card's rows are only trusted when the card is ok/stale; setup_needed keeps stale numbers ("limit reached" at 100 % while the real value was 40 %).
  let gpt = emptyAccountUsage();
  const gc = byId.get(GPT_CARD_ID);
  if (gc) {
    const status = gc.status === 'ok' ? 'ok' : gc.status === 'stale' ? 'stale' : 'down';
    gpt = status === 'down' ? { ...emptyAccountUsage(), fetchedAt: str(gc.fetchedAt) } : { status, fetchedAt: str(gc.fetchedAt), ...rowsOf(gc), fable: null };
  }
  return { accounts, gpt };
}

export function parseDeckState(json: unknown, reg: AccountNames): Record<Account, AccountUsage> {
  return parseDeckCards(json, reg).accounts;
}

export class UsageService {
  private snap: UsageSnapshot;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(s: UsageSnapshot) => void>();
  /** Per-turn windows and when they were observed; kept until the deck has a newer reading. */
  /** `fiveAt`/`weekAt`: when that window itself was last observed (a partial observation keeps the other's time). */
  private turnObs = new Map<UsageSeat, { w: TurnWindows; atMs: number; fiveAt?: number; weekAt?: number }>();
  /** Newest GPT credits reading; the usage-deck card has none, so it outlives the window overlay. */
  private gptCredits: { c: GptCredits; atMs: number } | null = null;
  /** When deck last completed a turn on each Claude account (see noteTurnOk). */
  private turnOkAt = new Map<Account, number>();
  private readonly url: string;
  private readonly fetchFn: FetchLike;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly reg: AccountNames;
  private readonly sourceFile: string | null;
  private readonly strict: boolean | null;
  private readonly deckConfigured: boolean;
  private readonly log: (line: string) => void;
  /** usage-deck has answered at least once (this run, or an earlier one: `sourceFile`). */
  private deckSeen = false;
  /** `sourceFile` is there and unreadable: read as seen (the strict side), written again by the next answer. */
  private recordBroken = false;
  private firstAttemptDone = false;

  /**
   * `accounts`: the registry.
   * `usageSourceFile` (`<configDir>/usage-source.json`) and `strict` (`DECK_USAGE_STRICT`: true → 'deck', false → 'none',
   * null → by the record) decide the snapshot's `usageSource`; with neither, the snapshot has none (= 'deck').
   * `deckConfigured`: the user set the usage-deck address (not the default), so with no record yet a failed first fetch
   * still reads as 'deck' (usage-deck is late or down, not absent). Order: `strict` > the record > this > the first fetch.
   */
  constructor(opts: { deckUrl: string; fetchFn?: FetchLike; intervalMs?: number; timeoutMs?: number; now?: () => Date; accounts: AccountNames; usageSourceFile?: string; strict?: boolean | null; deckConfigured?: boolean; log?: (line: string) => void }) {
    this.url = opts.deckUrl.replace(/\/+$/, '') + '/api/state';
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.timeoutMs = opts.timeoutMs ?? 6_000;
    this.now = opts.now ?? (() => new Date());
    this.reg = opts.accounts;
    this.sourceFile = opts.usageSourceFile ?? null;
    this.strict = opts.strict ?? null;
    this.deckConfigured = opts.deckConfigured ?? false;
    this.log = opts.log ?? (() => {});
    if (this.sourceFile) this.readRecord(this.sourceFile);
    this.snap = this.withSource(emptySnapshot(this.now(), this.reg.all()));
  }

  private readRecord(file: string): void {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.recordBroken = true;
      this.log(`deck: ${file} 을 읽을 수 없어 usage-deck 이 있는 설치로 봅니다 — ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let at: unknown;
    try {
      at = (JSON.parse(text) as { deckSeenAt?: unknown } | null)?.deckSeenAt;
    } catch {
      at = undefined;
    }
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) { this.deckSeen = true; return; }
    this.recordBroken = true;
    this.log(`deck: ${file} 의 내용을 읽을 수 없어 usage-deck 이 있는 설치로 봅니다 (usage-deck 이 다음에 응답하면 다시 씁니다)`);
  }

  /** usage-deck answered: the first time ever, that is written down (atomically, 0600) and never again. */
  private noteDeckSeen(): void {
    if (this.deckSeen) return;
    this.deckSeen = true;
    if (!this.sourceFile) return;
    const tmp = `${this.sourceFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.sourceFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ deckSeenAt: this.now().toISOString() }), { mode: 0o600 });
      fs.renameSync(tmp, this.sourceFile);
      this.recordBroken = false;
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      this.log(`deck: ${this.sourceFile} 을 쓰지 못했습니다 — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** null = not judged here (no record file and no switch): the snapshot carries no `usageSource`. */
  private source(): 'deck' | 'none' | null {
    if (this.strict !== null) return this.strict ? 'deck' : 'none';
    if (!this.sourceFile) return null;
    // Before the first fetch attempt has ended nothing is known yet: the strict side.
    return this.deckSeen || this.recordBroken || this.deckConfigured || !this.firstAttemptDone ? 'deck' : 'none';
  }

  private withSource(s: UsageSnapshot): UsageSnapshot {
    const usageSource = this.source();
    if (usageSource === null) return s;
    return { ...s, usageSource };
  }

  /** What the UI shows: the real card status (a setup_needed card stays 'down', so the re-login signal is kept). */
  snapshot(): UsageSnapshot {
    return this.snap;
  }

  /**
   * What routing sees: `snapshot()` with `down` Claude cards lifted to 'ok' while deck completed a turn on that
   * account within TURN_OK_TRUST_MS (see `lift`). Never published — the UI keeps the real status.
   */
  routingSnapshot(): UsageSnapshot {
    let accounts: UsageSnapshot['accounts'] | null = null;
    for (const a of this.reg.all()) {
      const cur = usageOf(this.snap, a);
      const u = this.lift(a, cur);
      if (u !== cur) (accounts ??= { ...this.snap.accounts })[a] = u;
    }
    return accounts ? { ...this.snap, accounts } : this.snap;
  }

  onChange(cb: (s: UsageSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private publish(next: UsageSnapshot): void {
    this.snap = this.withSource(next);
    for (const cb of this.listeners) cb(this.snap);
  }

  private seatOf(s: UsageSnapshot, seat: UsageSeat): AccountUsage {
    return seat === 'gpt' ? (s.gpt ?? emptyAccountUsage()) : usageOf(s, seat);
  }

  /**
   * Keeps a turn observation on top of a fetched card until a non-down card's fetchedAt is newer.
   * PF12: for the `gpt` seat, a live rollout observation also means the seat is known —
   * `auto` (D3) must be able to pick GPT even while the usage-deck `codex` card is still
   * `setup_needed` (status 'down'); the observation carries `status: 'ok'` and its own
   * `fetchedAt` until a newer deck card wins.
   */
  private overlay(seat: UsageSeat, u: AccountUsage): AccountUsage {
    const obs = this.turnObs.get(seat);
    if (!obs) return u;
    const fetched = u.fetchedAt ? parseIsoUtc(u.fetchedAt) : Number.NaN;
    // A 'down' card (e.g. setup_needed) carries no usable numbers, so it never retires an observation.
    if (u.status === 'down' || Number.isNaN(fetched) || obs.atMs > fetched) {
      const overridden: AccountUsage = { ...u, fiveHour: obs.w.fiveHour ?? u.fiveHour, weekly: obs.w.weekly ?? u.weekly };
      if (seat === 'gpt') return { ...overridden, status: this.obsStatus(obs.w), fetchedAt: new Date(obs.atMs).toISOString() };
      return overridden;
    }
    this.turnObs.delete(seat);
    return u;
  }

  /**
   * A `down` Claude card (usage-deck's own token expired: setup_needed) while deck itself completed a turn on that
   * account within TURN_OK_TRUST_MS: the account works, so it is not 'down' for routing (routingSnapshot only).
   * Numbers are not invented, and old ones are not trusted: usage-deck back-fills setup_needed cards with the
   * last-good rows indefinitely, and 'ok' skips the router's stale gate. So the lift needs every 5h/weekly number
   * the lifted card would carry to be fresh — the card's own fetchedAt, or that window's own turn observation, within
   * STALE_MAX_MS (a fresh 5h-only observation does not vouch for a days-old weekly). A missing window is fine: no
   * weekly value still keeps it out of routing. Fable (never refreshed by a turn) is kept only when the card is fresh.
   * How often this fires: Claude's rate_limit_event arrives every turn and normally carries both unifiedWindows
   * (five_hour and seven_day; see the deck-core plan's live capture), so a successful turn usually lifts the card for
   * ~STALE_MAX_MS. An event with only five_hour would not lift it (conservative).
   */
  private lift(account: Account, u: AccountUsage): AccountUsage {
    const at = this.turnOkAt.get(account);
    if (u.status !== 'down' || at === undefined) return u;
    const nowMs = this.now().getTime();
    if (nowMs - at >= TURN_OK_TRUST_MS) { this.turnOkAt.delete(account); return u; }
    const fresh = (t: number) => !Number.isNaN(t) && nowMs - t <= STALE_MAX_MS;
    const cardFresh = fresh(u.fetchedAt ? parseIsoUtc(u.fetchedAt) : Number.NaN);
    if (!cardFresh) {
      const obs = this.turnObs.get(account);
      // `u` is already overlaid: a window present in the observation is the value the lifted card uses.
      const ok = (v: unknown, fromObs: boolean, at: number | undefined) => (fromObs ? at !== undefined && fresh(at) : v === null);
      const fiveObs = !!obs?.w.fiveHour, weekObs = !!obs?.w.weekly;
      if (!fiveObs && !weekObs) return u; // nothing fresh at all
      if (!ok(u.fiveHour, fiveObs, obs?.fiveAt) || !ok(u.weekly, weekObs, obs?.weekAt)) return u;
    }
    return { ...u, status: 'ok', fable: cardFresh ? u.fable : null };
  }

  private withCredits(u: AccountUsage): AccountUsage {
    return this.gptCredits ? { ...u, credits: this.gptCredits.c } : u;
  }

  /** F3: an observation is stale once every window it carries has reset since (its numbers no longer apply). */
  private obsStatus(w: TurnWindows): 'ok' | 'stale' {
    const wins = [w.fiveHour, w.weekly].filter((x): x is UsageWindow => !!x);
    const nowMs = this.now().getTime();
    const reset = (x: UsageWindow) => x.resetsAt !== null && parseIsoUtc(x.resetsAt) <= nowMs;
    return wins.length > 0 && wins.every(reset) ? 'stale' : 'ok';
  }

  async pollOnce(): Promise<void> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.url, { signal: ac.signal });
      if (!res.ok) throw new Error(`deck HTTP not ok`);
      const json = await res.json();
      const parsed = parseDeckCards(json, this.reg);
      // usage-deck's own answer (a `cards` list), not just anything listening on that port.
      if (json && typeof json === 'object' && Array.isArray((json as { cards?: unknown }).cards)) this.noteDeckSeen();
      this.firstAttemptDone = true;
      const accounts = { ...parsed.accounts };
      for (const a of this.reg.all()) accounts[a] = this.overlay(a, usageOf(parsed, a));
      this.publish({ generatedAt: this.now().toISOString(), deckReachable: true, accounts, gpt: this.withCredits(this.overlay('gpt', parsed.gpt)) });
    } catch {
      this.firstAttemptDone = true;
      // Spec §8: deck unreachable → keep last values, show them as stale.
      const stale = (u: AccountUsage): AccountUsage => ({ ...u, status: u.status === 'ok' ? 'stale' : u.status });
      const accounts = { ...this.snap.accounts };
      for (const a of this.reg.all()) accounts[a] = stale(usageOf(this.snap, a));
      this.publish({ generatedAt: this.now().toISOString(), deckReachable: false, accounts, gpt: stale(this.seatOf(this.snap, 'gpt')) });
    } finally {
      clearTimeout(t);
    }
  }

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Between polls, trust the engine's own numbers: Claude's rate_limit_event, or the Codex rollout's
   * token_count.rate_limits (D5). They survive later polls until the deck card's fetchedAt is newer
   * than `observedAtMs` (default: now). PF12: for `gpt`, a fresh observation also marks the seat
   * `status: 'ok'` with `fetchedAt` = the observed time, even if the usage-deck `codex` card is
   * currently `setup_needed` — a newer deck card still wins afterwards (see `overlay`).
   */
  applyTurn(seat: UsageSeat, w: TurnWindows, observedAtMs: number = this.now().getTime()): void {
    const prev = this.turnObs.get(seat);
    // F3: the rollout poller may report a reading older than one a turn already gave; never go back in time.
    if (prev && observedAtMs < prev.atMs) return;
    if (seat === 'gpt' && w.credits && (!this.gptCredits || observedAtMs >= this.gptCredits.atMs)) this.gptCredits = { c: w.credits, atMs: observedAtMs };
    const merged: TurnWindows = { ...prev?.w, ...(w.fiveHour ? { fiveHour: w.fiveHour } : {}), ...(w.weekly ? { weekly: w.weekly } : {}) };
    const atMs = Math.max(observedAtMs, prev?.atMs ?? 0);
    this.turnObs.set(seat, { w: merged, atMs, fiveAt: w.fiveHour ? observedAtMs : prev?.fiveAt, weekAt: w.weekly ? observedAtMs : prev?.weekAt });
    const cur = this.seatOf(this.snap, seat);
    let next: AccountUsage = { ...cur, fiveHour: w.fiveHour ?? cur.fiveHour, weekly: w.weekly ?? cur.weekly };
    if (seat === 'gpt') next = this.withCredits({ ...next, status: this.obsStatus(merged), fetchedAt: new Date(atMs).toISOString() });
    const generatedAt = this.now().toISOString();
    if (seat === 'gpt') this.publish({ ...this.snap, generatedAt, gpt: next });
    else this.publish({ ...this.snap, generatedAt, accounts: { ...this.snap.accounts, [seat]: next } });
  }

  /** deck just completed a turn on `account` (result ok): affects `routingSnapshot` only (see `lift`); nothing is published. */
  noteTurnOk(account: Account, atMs: number = this.now().getTime()): void {
    this.turnOkAt.set(account, Math.max(atMs, this.turnOkAt.get(account) ?? 0));
  }
}
