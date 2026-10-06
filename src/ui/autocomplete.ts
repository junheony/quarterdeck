/** Composer autocomplete: `@path` file mentions and leading `/command`s. Pure functions; ComposerSuggest renders them. */

export type Trigger = {
  kind: 'file' | 'command';
  /** Text typed after the `@` / `/` up to the cursor. */
  query: string;
  /** `[start, end)` is the token being replaced, `@` / `/` included. */
  start: number;
  end: number;
};

/**
 * The token the cursor is in, if it is a trigger: `/name` only at the very start of the message (that is where the
 * CLI reads slash commands), `@path` at the start of a word anywhere. The token runs on past the cursor to the next
 * whitespace so picking a suggestion replaces the whole word.
 */
export function detectTrigger(text: string, cursor: number): Trigger | null {
  const before = text.slice(0, cursor);
  const restLen = /^\S*/.exec(text.slice(cursor))![0].length;
  const cmd = /^\/([^\s/]*)$/.exec(before);
  if (cmd) return { kind: 'command', query: cmd[1]!, start: 0, end: cursor + restLen };
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) {
    const start = before.length - at[2]!.length - 1;
    return { kind: 'file', query: at[2]!, start, end: cursor + restLen };
  }
  return null;
}

const BOUNDARY = /[/\\._\-\s]/;

/**
 * Fuzzy subsequence score (higher is better), null when `query` is not a subsequence of `candidate`.
 * Case-insensitive. Rewards consecutive runs, matches at word/path boundaries, a match inside the last path
 * segment, and shorter candidates.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const baseStart = c.lastIndexOf('/') + 1;
  let score = 0;
  let ci = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    const found = c.indexOf(ch, ci);
    if (found < 0) return null;
    if (found === prev + 1) score += 5;
    if (found === 0 || BOUNDARY.test(c[found - 1]!)) score += 4;
    if (found >= baseStart) score += 2;
    prev = found;
    ci = found + 1;
  }
  const sub = c.indexOf(q);
  if (sub >= 0) score += 10 + (sub === baseStart ? 10 : 0) + (sub === 0 ? 5 : 0);
  return score - candidate.length * 0.05;
}

export function rankFiles(query: string, files: readonly string[], limit = 50): string[] {
  const scored: { f: string; s: number }[] = [];
  for (const f of files) {
    const s = fuzzyScore(query, f);
    if (s !== null) scored.push({ f, s });
  }
  scored.sort((a, b) => b.s - a.s || a.f.localeCompare(b.f));
  return scored.slice(0, limit).map((x) => x.f);
}

export type CommandItem = { name: string; description: string; argumentHint: string };

/** Prefix matches first (in list order), then other fuzzy matches by score. */
export function rankCommands(query: string, commands: readonly CommandItem[], limit = 50): CommandItem[] {
  const q = query.toLowerCase();
  const prefix = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const rest = commands
    .filter((c) => !c.name.toLowerCase().startsWith(q))
    .map((c) => ({ c, s: fuzzyScore(q, c.name) }))
    .filter((x): x is { c: CommandItem; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
  return [...prefix, ...rest].slice(0, limit);
}

/** Replaces the trigger token with `insert` plus a trailing space; returns the new text and cursor. */
export function applySuggestion(text: string, t: Trigger, insert: string): { text: string; cursor: number } {
  const after = text.slice(t.end);
  const sep = after.startsWith(' ') ? '' : ' ';
  const head = text.slice(0, t.start) + insert + sep;
  return { text: head + after, cursor: head.length + (sep ? 0 : 1) };
}

/** `@path` as the CLI reads it; paths with spaces are quoted. */
export function mentionFor(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}
