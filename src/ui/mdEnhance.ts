import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';

/**
 * Syntax highlighting (highlight.js common languages) and math (KaTeX). Loaded on demand by MessageView
 * (dynamic import) so a chat without code or formulas never downloads them.
 */
// Single-$ math is off: prices and $TICKERs are common in chat. Only $$...$$ renders math.
export const REMARK_ENHANCE = [[remarkMath, { singleDollarTextMath: false }]] as never[];
/** No `maxExpand`: KaTeX's own limit (1000) is finite, and a lower one breaks ordinary blocks (a dozen `\implies`). */
export const KATEX_OPTIONS = { throwOnError: false, strict: 'ignore', maxSize: 20 } as const;
export const REHYPE_ENHANCE = [[rehypeHighlight, { detect: false }], [rehypeKatex, KATEX_OPTIONS]] as never[];
