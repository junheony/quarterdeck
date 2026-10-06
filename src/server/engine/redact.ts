/** Review M5: what the UI sees of an engine failure — stderr capped, token-shaped strings removed. */
export const STDERR_MAX = 2048;
const DISPLAY_MAX = 2600;

const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]+/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b((?:api[_-]?key|token|secret|password|passwd|authorization|cookie|deck_session)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b[0-9a-f]{40,}\b/gi,
  // long mixed-alphanumeric runs (keys); UUIDs are 36 chars with dashes and stay visible
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g,
];

export function redactSecrets(s: string): string {
  let out = s;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, (m, g1: unknown) => (typeof g1 === 'string' && /[:=]\s*["']?$/.test(g1) ? `${g1}[redacted]` : /^(Bearer|Basic)\s/i.test(m) ? `${m.split(/\s+/)[0]} [redacted]` : '[redacted]'));
  }
  return out;
}

// Chars a token-shaped match can run through without a break (union of the patterns' word classes).
const RUN_CHAR = /[A-Za-z0-9._~+/=-]/;
const TRAILING_RUN = /[A-Za-z0-9._~+/=-]+$/;
const LEADING_RUN = /^[A-Za-z0-9._~+/=-]+/;
// Most text StreamRedactor holds back; every pattern's value is long caught well before this.
const HELD_MAX = 4096;
// A text ending in one of these may still become a match once more text arrives: a key/auth word, its
// separator, or a value shorter than the pattern's minimum.
const OPENERS: RegExp[] = [
  /\b(?:Bearer|Basic)\s*[A-Za-z0-9._~+/=-]{0,7}$/i,
  /\b(?:api[_-]?key|token|secret|password|passwd|authorization|cookie|deck_session)["']?\s*(?:[:=]\s*["']?[^\s"',;]{0,5})?$/i,
];

/**
 * Redacts a stream of chunks as if it were one text: a secret split across chunks is still caught.
 * push() returns the part that can no longer change (redacted); the rest — an unfinished word, a key
 * word awaiting its value, a match still growing at the end — is held for the next chunk. flush() at
 * the block's end returns the remainder. Joined output === redactSecrets(whole text).
 */
export class StreamRedactor {
  private pending = '';
  // after a collapsed over-cap run: the rest of that run is already covered by its marker
  private swallow = false;

  push(chunk: string): string {
    if (this.swallow) {
      chunk = chunk.replace(LEADING_RUN, '');
      if (!chunk) return '';
      this.swallow = false;
    }
    const buf = this.pending + chunk;
    const cut = safeCut(buf);
    this.pending = buf.slice(cut);
    const out = cut ? redactSecrets(buf.slice(0, cut)) : '';
    return this.pending.length > HELD_MAX ? out + this.collapse() : out;
  }

  flush(): string {
    const rest = this.pending;
    this.pending = '';
    this.swallow = false;
    return rest ? redactSecrets(rest) : '';
  }

  /**
   * The held text outgrew HELD_MAX (an unbroken run, or a match still growing): stop holding it. A trailing
   * run that long is token-shaped, so it becomes one marker and the rest of it is dropped as it arrives;
   * otherwise the held text goes out redacted as it stands.
   */
  private collapse(): string {
    const held = this.pending;
    this.pending = '';
    const run = TRAILING_RUN.exec(held)?.[0] ?? '';
    if (!run) return redactSecrets(held);
    this.swallow = true;
    return redactSecrets(held.slice(0, held.length - run.length)) + '[redacted]';
  }
}

/** The largest i such that buf[0:i] redacts the same whatever follows. */
function safeCut(buf: string): number {
  let spans: [number, number][] | null = null;
  for (let i = buf.length; i > 0; i--) {
    // never inside a run (a word may grow into a key / hex / long-run match); the end counts as "may continue"
    if (RUN_CHAR.test(buf[i - 1]!) && (i === buf.length || RUN_CHAR.test(buf[i]!))) continue;
    // matches are only needed once there is a candidate cut (a pure run has none: no regex rescan per delta)
    spans ??= TOKEN_PATTERNS.flatMap((re) => [...buf.matchAll(new RegExp(re.source, re.flags))].map((m): [number, number] => [m.index, m.index + m[0].length]));
    if (spans.some(([s, e]) => s < i && (e > i || e === buf.length))) continue;
    const head = buf.slice(0, i);
    if (OPENERS.some((re) => re.test(head))) continue;
    return i;
  }
  return 0;
}

export function tailOf(s: string, max = STDERR_MAX): string {
  return s.length > max ? s.slice(-max) : s;
}

export function displayError(errorText: string | null, stderr: string | null): string | null {
  const parts = [errorText, stderr ? tailOf(stderr.trim()) : null].filter((x): x is string => !!x && x.length > 0);
  if (parts.length === 0) return null;
  const joined = redactSecrets(parts.join('\n'));
  return joined.length > DISPLAY_MAX ? joined.slice(0, DISPLAY_MAX) + '…' : joined;
}
