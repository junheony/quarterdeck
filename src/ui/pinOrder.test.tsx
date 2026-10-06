// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sidebar } from './components/Sidebar';
import { dropIndex, movePin, reorderVisible } from './pinOrder';

describe('pin order (pure)', () => {
  it('movePin: before / after a target; unknown ids or self leave the list alone', () => {
    expect(movePin(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'a', 'c', 'd']);
    expect(movePin(['a', 'b', 'c', 'd'], 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
    expect(movePin(['a', 'b', 'c', 'd'], 'd', 'a')).toEqual(['d', 'a', 'b', 'c']);
    const pins = ['a', 'b'];
    expect(movePin(pins, 'x', 'a')).toBe(pins);
    expect(movePin(pins, 'a', 'x')).toBe(pins);
    expect(movePin(pins, 'a', 'a')).toBe(pins);
  });

  it('dropIndex: counts the other rows whose midpoint is above the dragged centre', () => {
    const mids = [16, 48, 80, 112];
    expect(dropIndex(mids, 0, 16)).toBe(0);
    expect(dropIndex(mids, 0, 50)).toBe(1);
    expect(dropIndex(mids, 0, 200)).toBe(3);
    expect(dropIndex(mids, 3, 0)).toBe(0);
    expect(dropIndex(mids, 3, 60)).toBe(2);
  });

  it('reorderVisible: moves within the full list; hidden pins keep their place; no-op when unchanged', () => {
    const pins = ['a', 'b', 'c', 'd'];
    expect(reorderVisible(pins, pins, 0, 3)).toEqual(['b', 'c', 'd', 'a']);
    expect(reorderVisible(pins, pins, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(reorderVisible(pins, pins, 1, 2)).toEqual(['a', 'c', 'b', 'd']);
    expect(reorderVisible(pins, pins, 2, 2)).toBe(pins);
    // 'b' is filtered out (search): shown a, c, d — drag d to the top.
    expect(reorderVisible(pins, ['a', 'c', 'd'], 2, 0)).toEqual(['d', 'a', 'b', 'c']);
    // a below c: lands right after c, b stays put.
    expect(reorderVisible(pins, ['a', 'c', 'd'], 0, 1)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderVisible(pins, ['a'], 0, 0)).toBe(pins);
  });
});

describe('Sidebar 고정됨 reorder', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
  const s = (id: string, title: string) => ({ sessionId: id, account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title, lastModified: Date.now(), sizeBytes: 1 });
  const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [s('s1', 'one'), s('s2', 'two'), s('s3', 'three'), s('s4', 'four')] }];
  const ROW = 32;

  /** jsdom has no layout: each pinned row is ROW px tall, stacked from y=0. */
  function layout() {
    const ul = screen.getByTestId('pinned-group').querySelector('ul')!;
    vi.spyOn(ul, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: ROW * 4, left: 0, right: 200, height: ROW * 4, width: 200, x: 0, y: 0, toJSON: () => ({}) });
    [...ul.children].forEach((li, i) => {
      vi.spyOn(li, 'getBoundingClientRect').mockReturnValue({ top: i * ROW, bottom: (i + 1) * ROW, left: 0, right: 200, height: ROW, width: 200, x: 0, y: i * ROW, toJSON: () => ({}) });
    });
    return [...ul.children] as HTMLElement[];
  }
  function pointer(target: EventTarget, type: string, clientY: number, pointerType = 'mouse') {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY, button: 0 });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    Object.defineProperty(ev, 'pointerType', { value: pointerType });
    act(() => { target.dispatchEvent(ev); });
  }
  const setup = (pins = ['s1', 's2', 's3', 's4']) => {
    const onReorderPins = vi.fn();
    const onOpen = vi.fn();
    const ui = (p: string[]) => <Sidebar projects={projects} currentSessionId={null} onOpen={onOpen} onNew={() => {}} onRefresh={() => {}} pins={p} onTogglePin={() => {}} onReorderPins={onReorderPins} />;
    const { rerender } = render(ui(pins));
    return { onReorderPins, onOpen, rerender: (p: string[]) => rerender(ui(p)) };
  };

  it('mouse: dragging the first row below the third reorders, the row follows the pointer, and the drop does not open it', () => {
    const { onReorderPins, onOpen } = setup();
    const rows = layout();
    const title = rows[0]!.querySelector('.session-title')!;
    pointer(title, 'pointerdown', 16);
    pointer(window, 'pointermove', 18); // within the slop: not a drag yet
    expect(rows[0]!.classList.contains('pin-dragging')).toBe(false);
    pointer(window, 'pointermove', 90);
    expect(rows[0]!.classList.contains('pin-dragging')).toBe(true);
    expect(rows[0]!.style.transform).toBe('translateY(74px)');
    expect(rows[1]!.style.transform).toBe(`translateY(${-ROW}px)`);
    expect(rows[2]!.style.transform).toBe(`translateY(${-ROW}px)`);
    expect(rows[3]!.style.transform).toBe('');
    pointer(window, 'pointerup', 90);
    fireEvent.click(title);
    expect(onReorderPins).toHaveBeenCalledWith(['s2', 's3', 's1', 's4']);
    expect(onOpen).not.toHaveBeenCalled();
    expect(rows[0]!.style.transform).toBe('');
    expect(rows[0]!.classList.contains('pin-dragging')).toBe(false);
    // A plain click still opens.
    fireEvent.click(title);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('Escape cancels a drag; a press on a row button never starts one', () => {
    const { onReorderPins } = setup();
    const rows = layout();
    pointer(rows[3]!, 'pointerdown', 112);
    pointer(window, 'pointermove', 10);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    pointer(window, 'pointerup', 10);
    expect(onReorderPins).not.toHaveBeenCalled();
    expect(rows[3]!.style.transform).toBe('');
    pointer(rows[0]!.querySelector('button')!, 'pointerdown', 16);
    pointer(window, 'pointermove', 100);
    pointer(window, 'pointerup', 100);
    expect(onReorderPins).not.toHaveBeenCalled();
  });

  it('touch: a long press picks the row up; a swipe before it scrolls instead', () => {
    vi.useFakeTimers();
    const { onReorderPins } = setup();
    const rows = layout();
    pointer(rows[0]!, 'pointerdown', 16, 'touch');
    pointer(window, 'pointermove', 40, 'touch'); // moved before the long press: a scroll
    act(() => { vi.advanceTimersByTime(500); });
    pointer(window, 'pointerup', 40, 'touch');
    expect(onReorderPins).not.toHaveBeenCalled();
    expect(rows[0]!.classList.contains('pin-dragging')).toBe(false);

    pointer(rows[3]!, 'pointerdown', 112, 'touch');
    act(() => { vi.advanceTimersByTime(400); });
    expect(rows[3]!.classList.contains('pin-dragging')).toBe(true);
    const tm = new Event('touchmove', { bubbles: true, cancelable: true });
    rows[3]!.dispatchEvent(tm);
    expect(tm.defaultPrevented).toBe(true); // the sidebar does not scroll under the drag
    pointer(window, 'pointermove', 0, 'touch'); // to the top (clamped to the first slot)
    pointer(window, 'pointerup', 0, 'touch');
    expect(onReorderPins).toHaveBeenCalledWith(['s4', 's1', 's2', 's3']);
  });

  it('touch: a late click after the drop is swallowed for a while; a click after that opens', () => {
    vi.useFakeTimers();
    const { onOpen } = setup();
    const rows = layout();
    pointer(rows[3]!, 'pointerdown', 112, 'touch');
    act(() => { vi.advanceTimersByTime(400); });
    pointer(window, 'pointermove', 0, 'touch');
    pointer(window, 'pointerup', 0, 'touch');
    act(() => { vi.advanceTimersByTime(300); });
    fireEvent.click(rows[3]!);
    expect(onOpen).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(700); });
    fireEvent.click(rows[3]!);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('a list change mid-drag (broadcast) drops nothing rather than moving the wrong pin', () => {
    const { onReorderPins, rerender } = setup();
    const rows = layout();
    pointer(rows[0]!, 'pointerdown', 16);
    pointer(window, 'pointermove', 90);
    act(() => { rerender(['s3', 's1', 's2', 's4']); }); // another device reordered meanwhile
    pointer(window, 'pointerup', 90);
    expect(onReorderPins).not.toHaveBeenCalled();
    for (const r of rows) expect(r.style.transform).toBe('');
  });

  it('Escape during a drag cancels only the drag: other Escape handlers (drawer, panel, menu) do not see it', () => {
    const { onReorderPins } = setup();
    const rows = layout();
    const other = vi.fn();
    window.addEventListener('keydown', other);
    try {
      pointer(rows[0]!, 'pointerdown', 16);
      pointer(window, 'pointermove', 90);
      act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
      expect(other).not.toHaveBeenCalled();
      pointer(window, 'pointerup', 90);
      expect(onReorderPins).not.toHaveBeenCalled();
      // No drag: Escape reaches everyone as before.
      act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      expect(other).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', other);
    }
  });

  it('Alt+↑/↓ on a focused row control moves it one place', () => {
    const { onReorderPins } = setup();
    const btn = screen.getByTestId('pinned-group').querySelectorAll('li')[1]!.querySelector('button')!;
    expect(btn.getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown');
    fireEvent.keyDown(btn, { key: 'ArrowUp', altKey: true });
    expect(onReorderPins).toHaveBeenLastCalledWith(['s2', 's1', 's3', 's4']);
    expect(screen.getByTestId('pinned-group').querySelector('[aria-live="polite"]')!.textContent).toBe('two — 고정됨 1/4번째로 옮김');
    fireEvent.keyDown(btn, { key: 'ArrowDown', altKey: true });
    expect(onReorderPins).toHaveBeenLastCalledWith(['s1', 's3', 's2', 's4']);
    fireEvent.keyDown(btn, { key: 'ArrowDown' });
    expect(onReorderPins).toHaveBeenCalledTimes(2);
  });

  it('a filtered 고정됨 list reorders within the full pin list', () => {
    const { onReorderPins } = setup();
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'o' } }); // one, two, four (three has no o)
    const btn = screen.getByTestId('pinned-group').querySelectorAll('li')[2]!.querySelector('button')!; // four
    fireEvent.keyDown(btn, { key: 'ArrowUp', altKey: true });
    expect(onReorderPins).toHaveBeenCalledWith(['s1', 's4', 's2', 's3']);
  });
});
