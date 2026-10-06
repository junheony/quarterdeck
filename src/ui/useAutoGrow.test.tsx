// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { autoGrow, useAutoGrow } from './useAutoGrow';

/** jsdom has no layout: scrollHeight follows the line count (20px a line). */
function fakeLayout(ta: HTMLTextAreaElement) {
  Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => ta.value.split('\n').length * 20 });
}

describe('autoGrow', () => {
  it('fits the height to the text and shrinks back when emptied', () => {
    const ta = document.createElement('textarea');
    fakeLayout(ta);
    ta.value = 'a\nb\nc';
    autoGrow(ta);
    expect(ta.style.height).toBe('60px');
    ta.value = '';
    autoGrow(ta);
    expect(ta.style.height).toBe('20px');
  });

  it('leaves the height to CSS when there is no layout (scrollHeight 0)', () => {
    const ta = document.createElement('textarea');
    autoGrow(ta);
    expect(ta.style.height).toBe('auto');
    expect(ta.style.overflowY).toBe('');
  });

  it('is not a scroller while the text fits; scrolls only once the CSS max-height caps it (iPad caret offset)', () => {
    const ta = document.createElement('textarea');
    fakeLayout(ta);
    const MAX = 60; // the CSS max-height
    Object.defineProperty(ta, 'clientHeight', { configurable: true, get: () => Math.min(parseFloat(ta.style.height) || 0, MAX) });
    ta.value = 'a\nb';
    autoGrow(ta);
    expect(ta.style.overflowY).toBe('hidden');
    ta.value = 'a\nb\nc\nd\ne';
    autoGrow(ta);
    expect(ta.style.overflowY).toBe('');
    ta.value = 'a';
    autoGrow(ta);
    expect(ta.style.overflowY).toBe('hidden');
  });
});

describe('useAutoGrow', () => {
  afterEach(cleanup);
  function Box({ text }: { text: string }) {
    const ref = useRef<HTMLTextAreaElement>(null);
    useAutoGrow(ref, text);
    return <textarea ref={(el) => { if (el) fakeLayout(el); ref.current = el; }} value={text} readOnly />;
  }

  it('re-fits on every value change (a send clears the composer → it shrinks)', () => {
    const { container, rerender } = render(<Box text={'one\ntwo\nthree\nfour'} />);
    const ta = container.querySelector('textarea')!;
    expect(ta.style.height).toBe('80px');
    rerender(<Box text="" />);
    expect(ta.style.height).toBe('20px');
  });

  it('re-fits when the width changes (a narrower pane wraps onto more lines), not on its own height change', () => {
    let fire = () => {};
    const RO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { constructor(cb: () => void) { fire = cb; } observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
    const raf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 1; }) as typeof requestAnimationFrame; // the refit runs on the next frame
    try {
      const { container } = render(<Box text="one two three" />);
      const ta = container.querySelector('textarea')!;
      let width = 300;
      Object.defineProperty(ta, 'clientWidth', { configurable: true, get: () => width });
      Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => (width < 200 ? 40 : 20) });
      fire();
      expect(ta.style.height).toBe('20px'); // first observation: width recorded at mount was 0 → re-measured, still one line
      width = 150;
      fire();
      expect(ta.style.height).toBe('40px');
    } finally {
      globalThis.ResizeObserver = RO;
      globalThis.requestAnimationFrame = raf;
    }
  });
});

describe('autoGrow keeps the transcript scroll', () => {
  /**
   * A 1000px transcript over a textarea: measuring at height auto shrinks the textarea, the transcript's viewport grows
   * 400 → 500px and the browser clamps its scrollTop (to ≤ 500), as a real layout does.
   */
  function transcript(top: number) {
    const body = document.createElement('div');
    const ta = document.createElement('textarea');
    fakeLayout(ta);
    let scrollTop = top;
    let height = '';
    const client = () => (height === 'auto' ? 500 : 400);
    Object.defineProperty(ta.style, 'height', { configurable: true, get: () => height, set: (v: string) => { height = v; scrollTop = Math.min(scrollTop, 1000 - client()); } });
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: client });
    Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => scrollTop, set: (v: number) => { scrollTop = Math.max(0, Math.min(v, 1000 - client())); } });
    return { body, ta, top: () => scrollTop };
  }

  it('without it the clamp would move the transcript up (the bug)', () => {
    const t = transcript(600);
    autoGrow(t.ta);
    expect(t.top()).toBe(500);
  });

  it('stuck to the bottom stays at the bottom; scrolled up near the bottom stays where it was', () => {
    const t = transcript(600); // at the bottom: 1000 - 400
    t.ta.value = 'a\nb';
    autoGrow(t.ta, t.body);
    expect(t.top()).toBe(600);
    const u = transcript(550); // reading 50px up, also clamped while measuring
    autoGrow(u.ta, u.body);
    expect(u.top()).toBe(550);
  });
});
