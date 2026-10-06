// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { findHitElement } from './scrollToHit';

function dom(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

describe('findHitElement', () => {
  it('prefers the message containing the whole snippet, falls back to a window, then the match', () => {
    const root = dom('<div class="msg user">the token is fine</div><div class="msg assistant"><p>rotate   the <b>token</b> weekly please</p></div>');
    expect(findHitElement(root, '…rotate the token weekly…', 'token')!.className).toContain('assistant');
    // Markdown markers in the raw snippet are not in the DOM: the window around the match still finds it.
    expect(findHitElement(root, 'You should **rotate the token weekly** and log it', 'token')!.className).toContain('assistant');
    expect(findHitElement(root, 'xx token yy zz qq ww ee', 'token')!.className).toContain('user');
    expect(findHitElement(root, 'nothing', 'absent')).toBeNull();
    expect(findHitElement(dom(''), 'a', 'a')).toBeNull();
  });
});
