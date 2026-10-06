import type { Seat } from '../shared/accounts';
import type { ContextUsage, TurnUsage } from '../shared/turn-types';

/**
 * Context gauge and cost hints. The context is the prompt of the session's latest main-model API call
 * (input + cache read + cache write), never a sum across turns.
 */
export type ContextInfo = {
  usage: ContextUsage;
  window: number;
  /** When that call ran (client clock for live turns, transcript timestamp for reopened sessions); null = unknown. */
  at: number | null;
  /** Deck id (opus) or wire id (claude-opus-5-5); null = unknown. */
  model: string | null;
  account: Seat | null;
};

/** Mirrors routing/AccountRouter WARM_MS: past this the 1h prompt cache has likely expired. */
export const WARM_MS = 55 * 60_000;
/** The prompt cache TTL: a gap longer than this means the next turn rewrote the whole context. */
export const CACHE_TTL_MS = 60 * 60_000;
export const LONG_CONTEXT_PCT = 60;
export const LONG_CONTEXT_TOKENS = 300_000;
/** A turn "rewrote the cache" when it wrote at least this much while reading under COLD_READ_RATIO of it. */
export const COLD_WRITE_MIN = 10_000;
export const COLD_READ_RATIO = 0.05;

export function contextTokens(u: ContextUsage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

/** Share of the context served from cache, 0–100; null for an empty context. */
export function cacheHitPct(u: ContextUsage): number | null {
  const total = contextTokens(u);
  return total > 0 ? Math.round((u.cacheReadTokens / total) * 100) : null;
}

/** Context fill, 0–100 (capped). */
export function contextPct(tokens: number, window: number): number {
  return window > 0 ? Math.min(100, Math.round((tokens / window) * 100)) : 0;
}

export function isLongContext(tokens: number, window: number): boolean {
  return tokens >= LONG_CONTEXT_TOKENS || (window > 0 && tokens / window >= LONG_CONTEXT_PCT / 100);
}

/** The session sat idle long enough that the next turn likely reads the whole context uncached. */
export function isCacheCold(at: number | null, now: number): boolean {
  return at !== null && now - at > WARM_MS;
}

/** The session's current context: the latest assistant item that carries one. */
export function latestContext(items: readonly { kind: string; ctx?: ContextInfo }[]): ContextInfo | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const c = items[i]!.ctx;
    if (c) return c;
  }
  return null;
}

/** 850 · 12k · 312k · 1M · 1.2M */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function contextLabel(info: ContextInfo): string {
  const hit = cacheHitPct(info.usage);
  return `컨텍스트 ${fmtTokens(contextTokens(info.usage))} / ${fmtTokens(info.window)}${hit === null ? '' : ` · 캐시 적중 ${hit}%`}`;
}

export const LONG_HINT = '대화가 길어요 · 새 세션으로 넘기면 매 턴 비용이 크게 줄어요';
export const COLD_HINT = '캐시 만료 · 이번 턴은 전체 다시 읽기';

/** The one hint line under the gauge (cache expiry first: it is about the very next send). */
export function contextHint(info: ContextInfo | null, now: number): string | null {
  if (!info) return null;
  if (isCacheCold(info.at, now)) return COLD_HINT;
  return isLongContext(contextTokens(info.usage), info.window) ? LONG_HINT : null;
}

function family(model: string | null): string | null {
  if (!model) return null;
  return /opus|sonnet|fable|haiku|mythos/i.exec(model)?.[0].toLowerCase() ?? model;
}

/**
 * A turn that wrote a large cache while reading almost none: "캐시 새로 씀" plus the likely reason —
 * account switch (the routing reason says 전환, or the account changed), model switch, idle past the cache TTL,
 * or the session's first turn. Null for a normal (warm) turn.
 */
export function coldWriteNote(u: TurnUsage, prev: ContextInfo | null, cur: { account: Seat; model: string; reason: string; startedAt: number }): string | null {
  if (u.cacheCreationTokens < COLD_WRITE_MIN || u.cacheReadTokens >= u.cacheCreationTokens * COLD_READ_RATIO) return null;
  let why: string | null = null;
  if (/전환/.test(cur.reason) || (prev?.account && prev.account !== cur.account)) why = '계정 전환';
  else if (prev && family(prev.model) && family(prev.model) !== family(cur.model)) why = '모델 전환';
  else if (prev?.at != null && cur.startedAt - prev.at > CACHE_TTL_MS) why = '1시간 넘게 쉼';
  else if (!prev) why = '첫 턴';
  return why ? `캐시 새로 씀 · ${why}` : '캐시 새로 씀';
}
