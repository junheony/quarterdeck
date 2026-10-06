// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncSoftKeyboardAttr } from './Chat';

function setViewport({ layout, height, scale = 1, coarse = true }: { layout: number; height: number; scale?: number; coarse?: boolean }): void {
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: layout });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: { width: 1408, height, scale, addEventListener: () => {} } });
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: coarse, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
}

const attr = () => document.documentElement.hasAttribute('data-soft-kb');

describe('data-soft-kb (composer drops its home-indicator inset while the keyboard is up)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
    document.documentElement.removeAttribute('data-soft-kb');
  });

  it('turns on when the keyboard shrinks the visual viewport, and off again when it closes', () => {
    setViewport({ layout: 970, height: 600 });
    syncSoftKeyboardAttr();
    expect(attr()).toBe(true);
    setViewport({ layout: 970, height: 970 });
    syncSoftKeyboardAttr();
    expect(attr()).toBe(false);
  });

  it('stays off on a pinch-zoom (height × scale is still the full layout height)', () => {
    setViewport({ layout: 970, height: 485, scale: 2 });
    syncSoftKeyboardAttr();
    expect(attr()).toBe(false);
  });

  it('stays off on a Stage Manager / split resize (the layout viewport shrinks too) and never latches', () => {
    setViewport({ layout: 970, height: 600 });
    syncSoftKeyboardAttr();
    expect(attr()).toBe(true);
    setViewport({ layout: 600, height: 600 });
    syncSoftKeyboardAttr();
    expect(attr()).toBe(false);
  });

  it('stays off with a fine pointer or no visualViewport', () => {
    setViewport({ layout: 970, height: 600, coarse: false });
    syncSoftKeyboardAttr();
    expect(attr()).toBe(false);
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    syncSoftKeyboardAttr();
    expect(attr()).toBe(false);
  });
});
