// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { DeckMark } from './DeckMark';
import { Login } from './Login';

afterEach(cleanup);

describe('DeckMark', () => {
  it('is the app icon chip as SVG — a rounded terracotta square with the cream >_ — and no text', () => {
    const { container } = render(<DeckMark className="spark" />);
    const svg = container.querySelector('svg.deck-mark.spark');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    const rect = svg!.querySelector('rect');
    expect(rect?.getAttribute('rx')).toBe('6.3');
    expect(rect?.getAttribute('fill')).toMatch(/^url\(#/);
    expect(svg!.querySelector('linearGradient')).not.toBeNull();
    expect(svg!.querySelector('path')?.getAttribute('stroke')).toBe('#EDE3D5');
    expect(container.textContent).toBe('');
  });

  it('two marks on one page keep separate gradient ids', () => {
    const { container } = render(<><DeckMark className="a" /><DeckMark className="b" /></>);
    const ids = [...container.querySelectorAll('linearGradient')].map((g) => g.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(container.querySelector('svg.a rect')?.getAttribute('fill')).toBe(`url(#${ids[0]})`);
  });

  it('is the brand mark on the login (the Claude star stays with sessions)', () => {
    const { container } = render(<Login onLoggedIn={() => {}} />);
    expect(container.querySelector('h1 svg.deck-mark')).not.toBeNull();
    expect(container.querySelector('h1 svg.claude-mark')).toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe('deck');
  });
});
