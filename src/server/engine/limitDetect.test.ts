import { describe, expect, it } from 'vitest';
import { COOLDOWN_MS, classifyFailure } from './limitDetect';

describe('classifyFailure', () => {
  it('returns null for a successful turn even if a warning was seen', () => {
    expect(classifyFailure({ ok: true, errorText: null, errorKind: null, rateLimitStatus: 'allowed_warning' })).toBeNull();
  });

  it('detects limits by SDK error kind, by rejected rate-limit status, and by text patterns', () => {
    expect(classifyFailure({ ok: false, errorText: 'x', errorKind: 'rate_limit', rateLimitStatus: null })).toBe('limit');
    expect(classifyFailure({ ok: false, errorText: 'x', errorKind: null, rateLimitStatus: 'rejected' })).toBe('limit');
    expect(classifyFailure({ ok: false, errorText: "You've hit your usage limit. Resets at 3pm", errorKind: null, rateLimitStatus: null })).toBe('limit');
    expect(classifyFailure({ ok: false, errorText: 'API Error: 429 rate limit reached', errorKind: null, rateLimitStatus: null })).toBe('limit');
    expect(classifyFailure({ ok: false, errorText: 'Claude usage limit reached', errorKind: null, rateLimitStatus: null })).toBe('limit');
  });

  it('detects Codex turn.failed JSON-blob limits (429 status, usage_limit_reached, rate_limit_exceeded)', () => {
    const lim = (errorText: string) => classifyFailure({ ok: false, errorText, errorKind: null, rateLimitStatus: null });
    expect(lim('{"type":"error","status":429,"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"pro","resets_in_seconds":3600}}')).toBe('limit');
    expect(lim('unexpected status 429 Too Many Requests: {"type":"error","status": 429,"error":{"type":"server_overloaded"}}')).toBe('limit');
    expect(lim('{"error":{"type":"rate_limit_exceeded","message":"Rate limit reached for gpt-6-sol"}}')).toBe('limit');
    expect(lim('stream error: {"type":"error","error":{"code":"usage_limit_reached"}}')).toBe('limit');
    // A JSON blob with a different status is not a limit.
    expect(lim('{"type":"error","status":500,"error":{"type":"server_error"}}')).toBe('other');
  });

  it('detects auth failures (the real 401 text from account a)', () => {
    expect(classifyFailure({ ok: false, errorText: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.', errorKind: null, rateLimitStatus: null })).toBe('auth');
    expect(classifyFailure({ ok: false, errorText: 'x', errorKind: 'authentication_failed', rateLimitStatus: null })).toBe('auth');
  });

  it('does not match text that merely mentions 429, rate limit or authentication', () => {
    const other = (errorText: string) => classifyFailure({ ok: false, errorText, errorKind: null, rateLimitStatus: null });
    expect(other('error_max_turns: I checked the handler — it returns 429 when the rate limit is hit')).toBe('other');
    expect(other('error_during_execution: refactored the authentication middleware; resets at midnight')).toBe('other');
    expect(other('Tool failed: curl printed "HTTP 401"')).toBe('other');
    expect(other('error_during_execution: the rate_limit_exceeded_handler returned status 4290')).toBe('other');
  });

  it('errorKind wins over text', () => {
    expect(classifyFailure({ ok: false, errorText: 'API Error: 429 rate limit reached', errorKind: 'authentication_failed', rateLimitStatus: null })).toBe('auth');
  });

  it('everything else is other', () => {
    expect(classifyFailure({ ok: false, errorText: 'error_max_turns', errorKind: null, rateLimitStatus: 'allowed' })).toBe('other');
    expect(classifyFailure({ ok: false, errorText: null, errorKind: null, rateLimitStatus: null })).toBe('other');
  });

  it('cooldowns: limit 1h, auth 6h, other none', () => {
    expect(COOLDOWN_MS).toEqual({ limit: 3_600_000, auth: 21_600_000, other: 0 });
  });
});
