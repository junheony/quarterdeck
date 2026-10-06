import type { Account } from './accounts';

export type UsageWindow = { usedPct: number; resetsAt: string | null };

/** ChatGPT pay-as-you-go credits from the Codex rollout's `rate_limits.credits`: usable after the plan's weekly is spent (they cost money). */
export type GptCredits = { hasCredits: boolean; unlimited: boolean; balance: number | null };

export type AccountUsage = {
  status: 'ok' | 'stale' | 'down';
  fetchedAt: string | null;
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  fable: UsageWindow | null;
  /** GPT seat only: credits, when the rollout reported them. */
  credits?: GptCredits | null;
};

export type UsageSnapshot = {
  generatedAt: string;
  deckReachable: boolean;
  /** By account id. An account may be missing (snapshot from before it was configured): read with `usageOf`. */
  accounts: Record<Account, AccountUsage>;
  /** ChatGPT Pro (usage-deck card `codex`); status 'down' = unknown (D5). Optional only for Plan 1 test literals. */
  gpt?: AccountUsage;
  /** 'none' = this install has never had an answer from usage-deck: unknown usage alone does not change the model or engine. Absent = 'deck'. */ usageSource?: 'deck' | 'none';
};

export function remainingPct(w: UsageWindow | null): number | null {
  if (!w) return null;
  return Math.max(0, Math.min(100, 100 - w.usedPct));
}

export function emptyAccountUsage(): AccountUsage {
  return { status: 'down', fetchedAt: null, fiveHour: null, weekly: null, fable: null };
}

/** An account's usage; one the snapshot does not carry is unknown ('down'). */
export function usageOf(s: Pick<UsageSnapshot, 'accounts'>, account: Account): AccountUsage {
  return (Object.hasOwn(s.accounts, account) ? s.accounts[account] : undefined) ?? emptyAccountUsage();
}

/** `accounts`: the ids to carry (the server passes its registry's). */
export function emptySnapshot(now: Date, accounts: readonly Account[]): UsageSnapshot {
  return {
    generatedAt: now.toISOString(),
    deckReachable: false,
    accounts: Object.fromEntries(accounts.map((a) => [a, emptyAccountUsage()])),
    gpt: emptyAccountUsage(),
  };
}

/**
 * Epoch ms of an ISO timestamp; a date-time without a zone is UTC (claude-pick / Python
 * `fromisoformat` + `replace(tzinfo=utc)`), unlike `Date.parse`, which uses local time. NaN if unparsable.
 */
export function parseIsoUtc(iso: string): number {
  let t = iso.trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) {
    t = t.slice(0, 10) + 'T' + t.slice(11);
    if (!/(Z|[+-]\d{2}(:?\d{2})?)$/i.test(t)) t += 'Z';
  }
  return Date.parse(t);
}
