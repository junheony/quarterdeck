/**
 * ⌘K palette matching. Every whitespace-separated query token must occur in `text`, either as a substring
 * (scored higher, more so at the start or a word boundary) or as an in-order subsequence (fewer gaps = higher).
 * Case-insensitive; Hangul matches by syllable. null = no match. An empty query matches everything with 0.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  const hay = text.toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    const at = hay.indexOf(tok);
    if (at >= 0) {
      const boundary = at === 0 || /[\s/\-_.·:()[\]]/.test(hay[at - 1]!);
      score += 100 + tok.length * 4 + (at === 0 ? 30 : boundary ? 20 : 0) - Math.min(at, 40);
      continue;
    }
    let pos = -1;
    let gaps = 0;
    for (const ch of tok) {
      const next = hay.indexOf(ch, pos + 1);
      if (next < 0) return null;
      if (pos >= 0 && next > pos + 1) gaps += 1;
      pos = next;
    }
    score += 40 + tok.length * 2 - gaps * 6;
  }
  return score;
}

/** Items matching `query`, best first; ties keep the input order (callers pass newest first). */
export function fuzzyFilter<T>(items: T[], query: string, textOf: (item: T) => string, limit = Infinity): T[] {
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const score = fuzzyScore(query, textOf(item));
    if (score !== null) scored.push({ item, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.item);
}
