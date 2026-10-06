/** Whitespace collapsed, markdown emphasis/code markers dropped (they are in the transcript, not in the DOM). */
const norm = (s: string) => s.replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The rendered message (`.msg`) under `root` that best contains a search hit. The snippet is raw transcript text
 * while the DOM shows rendered markdown, so it tries the whole snippet, then a shorter window around the match,
 * then the match alone.
 */
export function findHitElement(root: ParentNode, snippet: string, match: string): HTMLElement | null {
  const msgs = [...root.querySelectorAll<HTMLElement>('.msg')].map((el) => ({ el, text: norm(el.textContent ?? '') }));
  if (msgs.length === 0) return null;
  const core = snippet.replace(/^…/, '').replace(/…$/, '');
  const at = core.toLowerCase().indexOf(match.toLowerCase());
  // Narrowing windows of k whole words either side of the match (the split's edge item is the partial word touching it).
  const before = at >= 0 ? core.slice(0, at).split(/\s+/) : [];
  const after = at >= 0 ? core.slice(at + match.length).split(/\s+/) : [];
  const windows = at >= 0 ? [3, 2, 1].map((k) => `${before.slice(-k - 1).join(' ')}${match}${after.slice(0, k + 1).join(' ')}`) : [];
  const needles = [core, ...windows, match].map(norm).filter((n) => n.length >= 2);
  for (const n of needles) {
    const hit = msgs.find((m) => m.text.includes(n));
    if (hit) return hit.el;
  }
  return null;
}
