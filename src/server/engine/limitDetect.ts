import type { RateLimitSignal } from './Engine';

export type FailureKind = 'limit' | 'auth' | 'other';

/**
 * Spec §8: the exact text at a hard limit is unmeasured (claude-limit-probe
 * pending). Edit these arrays when a real capture arrives.
 *
 * Review M4: these run only on the SDK's own error text (result `errors[]`,
 * an is_error result, or the thrown SDK error message) — never on CLI stderr
 * or on model output — and are anchored on the phrasing the CLI/API use, so a
 * sentence that merely mentions "429" or "rate limit" does not match.
 */
export const LIMIT_PATTERNS: RegExp[] = [
  /\bAPI Error: 429\b/,
  /\brate_limit_error\b/,
  /\busage limit reached\b/i,
  /\bhit your (usage )?limit\b/i,
  /\bout of (extra )?usage\b/i,
  // Codex turn.failed / error events carry the API error as a JSON blob.
  /"status"\s*:\s*429\b/,
  /\busage_limit_reached\b/,
  /\brate_limit_exceeded\b/,
];

export const AUTH_PATTERNS: RegExp[] = [
  /\bAPI Error: 401\b/,
  /^Failed to authenticate\b/i,
  /\bOAuth (access )?token has (been )?(revoked|expired)\b/i,
  /\bnot logged in\b.*\/login/i,
  /\bplease run \/login\b/i,
];

export const COOLDOWN_MS: Record<FailureKind, number> = { limit: 60 * 60_000, auth: 6 * 60 * 60_000, other: 0 };

export function classifyFailure(r: {
  ok: boolean;
  errorText: string | null;
  errorKind: string | null;
  rateLimitStatus: RateLimitSignal['status'] | null;
}): FailureKind | null {
  if (r.ok) return null;
  if (r.errorKind === 'authentication_failed') return 'auth';
  if (r.errorKind === 'rate_limit' || r.rateLimitStatus === 'rejected') return 'limit';
  const text = r.errorText ?? '';
  if (LIMIT_PATTERNS.some((p) => p.test(text))) return 'limit';
  if (AUTH_PATTERNS.some((p) => p.test(text))) return 'auth';
  return 'other';
}
