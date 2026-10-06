import type { Account, AccountNames } from './accounts';

/** Token usage history (사용량 view): where the tokens were spent, per day × source × model family. */

/** The ChatGPT account's Codex rollouts. */
export const CODEX_SOURCE = 'codex';
/**
 * A Claude account id (which ones exist is configuration — `AccountRegistry` — plus accounts the index still holds
 * usage for) or `CODEX_SOURCE`. `'all'` (the global total) and `'codex'` are reserved account ids, so they never collide.
 */
export type UsageSource = Account | typeof CODEX_SOURCE;

/** The sources to show for these Claude accounts, Codex last. */
export function usageSources(accounts: readonly Account[]): UsageSource[] {
  return [...accounts, CODEX_SOURCE];
}

/** Tab / legend label: the account's label (how an id that is not configured shows is up to `names`), `GPT` for Codex, `합계` for the total. */
export function usageSourceLabel(source: UsageSource | 'all', names: Pick<AccountNames, 'label'>): string {
  return source === 'all' ? '합계' : source === CODEX_SOURCE ? 'GPT' : names.label(source);
}

export type ModelFamily = 'opus' | 'sonnet' | 'fable' | 'haiku' | 'gpt' | 'other';
export const MODEL_FAMILIES: readonly ModelFamily[] = ['opus', 'sonnet', 'fable', 'haiku', 'gpt', 'other'];
export const FAMILY_LABEL: Record<ModelFamily, string> = { opus: 'Opus', sonnet: 'Sonnet', fable: 'Fable', haiku: 'Haiku', gpt: 'GPT', other: '기타' };

/** `input` is uncached input only (Codex's cached share is moved to cacheRead), like Anthropic usage. */
export type TokenCounts = { input: number; output: number; cacheRead: number; cacheWrite: number; messages: number };

/**
 * One aggregate. `source: 'all'` is the global total: a message copied into several accounts' transcripts
 * (session copies share a prefix) counts once there, while each account's own rows count it in that account.
 */
export type UsageRow = TokenCounts & { day: string; source: UsageSource | 'all'; family: ModelFamily };

export type UsageHistory = {
  generatedAt: string;
  days: number;
  lastScanAt: string | null;
  scanning: boolean;
  /** Every source the index has a place for, in index order (accounts that left the configuration included), Codex last. Absent from a server that only knows a/b/c. */
  sources?: UsageSource[];
  rows: UsageRow[];
};

/**
 * 추정 단가 (USD per million tokens), the one place prices live. Claude: claude-api skill model table
 * (2026-09-25) — Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Fable 5.1 $10/$50, Haiku 4.5 $1/$5; older versions in a
 * family are priced as the current one. GPT: no published per-token price for the ChatGPT-plan models — a
 * rough placeholder (the UI labels GPT as 구독 포함 · 추정 환산, never as a bill). Cache read = input × CACHE_READ_MULT, cache write = input × CACHE_WRITE_MULT.
 */
export const PRICES_PER_MTOK: Record<ModelFamily, { input: number; output: number }> = {
  opus: { input: 4, output: 20 },
  sonnet: { input: 2, output: 10 },
  fable: { input: 10, output: 50 },
  haiku: { input: 1, output: 5 },
  gpt: { input: 2.5, output: 15 },
  other: { input: 4, output: 20 },
};
export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_MULT = 1.25;

export function familyOf(model: string | null | undefined): ModelFamily {
  const m = (model ?? '').toLowerCase();
  if (m.includes('fable') || m.includes('mythos')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.startsWith('gpt') || m.includes('codex')) return 'gpt';
  return 'other';
}

/** Estimated USD for these counts at `family`'s price. */
export function costOf(c: TokenCounts, family: ModelFamily): number {
  const p = PRICES_PER_MTOK[family];
  return (c.input * p.input + c.output * p.output + c.cacheRead * p.input * CACHE_READ_MULT + c.cacheWrite * p.input * CACHE_WRITE_MULT) / 1_000_000;
}

export function emptyCounts(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
}

export function addCounts(into: TokenCounts, c: TokenCounts): TokenCounts {
  into.input += c.input;
  into.output += c.output;
  into.cacheRead += c.cacheRead;
  into.cacheWrite += c.cacheWrite;
  into.messages += c.messages;
  return into;
}

export function totalTokens(c: TokenCounts): number {
  return c.input + c.output + c.cacheRead + c.cacheWrite;
}

/** Share of input-side tokens served from cache, 0–100; null without any input. */
export function cacheHitPct(c: TokenCounts): number | null {
  const denom = c.input + c.cacheRead + c.cacheWrite;
  return denom > 0 ? (c.cacheRead / denom) * 100 : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar day `YYYY-MM-DD`. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `day` shifted by `delta` days (local calendar). */
export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return localDay(new Date(y, m - 1, d + delta));
}

/** The Monday that starts `day`'s week. */
export function weekStart(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const dow = new Date(y, m - 1, d).getDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}
