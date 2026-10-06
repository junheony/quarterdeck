import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { KATEX_OPTIONS } from './mdEnhance';

/** Rendered the way rehype-katex does for a `$$` block, with the options mdEnhance hands it. */
const render = (tex: string) => katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: true });

describe('mdEnhance: KaTeX options', () => {
  it('an ordinary long block renders: 30 lines of \\implies and \\neq stay under the expansion limit', () => {
    const tex = `\\begin{aligned}${Array.from({ length: 30 }, (_, n) => `a_{${n}} &\\implies b_{${n}} \\neq c_{${n}}`).join(' \\\\ ')}\\end{aligned}`;
    const html = render(tex);
    expect(html).not.toContain('katex-error');
    expect(html.match(/⟹/g)?.length).toBeGreaterThanOrEqual(30);
  });

  it('an oversized box is cut to maxSize', () => {
    const html = render('\\rule{500em}{500em}');
    expect(html).not.toContain('katex-error');
    // The source stays in the MathML annotation; the drawn box is what is cut.
    expect(html).not.toMatch(/(width|height)[:=]"?500em/);
    expect(html).toContain(`border-right-width:${KATEX_OPTIONS.maxSize}em;border-top-width:${KATEX_OPTIONS.maxSize}em`);
  });

  it('runaway macro expansion still ends in an error, not a hang', () => {
    expect(render('\\def\\x{\\x\\x}\\x')).toContain('katex-error');
  });
});
