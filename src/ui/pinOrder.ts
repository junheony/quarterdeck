import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';

/** `id` moved next to `target` — before it, or right after it with `after`. Unknown ids leave the list as is. */
export function movePin(pins: string[], id: string, target: string, after = false): string[] {
  if (id === target || !pins.includes(id) || !pins.includes(target)) return pins;
  const rest = pins.filter((p) => p !== id);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Where a dragged row lands: its index among the other rows, from their vertical midpoints and the dragged row's centre. */
export function dropIndex(mids: number[], from: number, center: number): number {
  let to = 0;
  mids.forEach((m, i) => { if (i !== from && m < center) to++; });
  return to;
}

/**
 * The full pin order after the shown row `from` moves to index `to` among the other shown rows. `visible` may be a
 * subset of `pins` (세션 검색 / 보관됨 filter): hidden pins keep their place.
 */
export function reorderVisible(pins: string[], visible: string[], from: number, to: number): string[] {
  const id = visible[from];
  const others = visible.filter((_, i) => i !== from);
  if (id === undefined || others.length === 0 || to === from) return pins;
  return to < others.length ? movePin(pins, id, others[to]!) : movePin(pins, id, others[others.length - 1]!, true);
}

/** Touch: hold this long (without moving) to pick a row up, so a swipe still scrolls the sidebar. */
const LONG_PRESS_MS = 350;
const TOUCH_SLOP = 8;
const MOUSE_SLOP = 4;
/** After a drop, the click the browser may still send (late on iOS) is swallowed for this long, or until the next press. */
const SUPPRESS_CLICK_MS = 600;

type Drag = {
  pointerId: number;
  touch: boolean;
  from: number;
  to: number;
  /** The grabbed row and the shown ids at the press: the drop resolves by id, and is dropped if the list changed meanwhile. */
  id: string;
  ids: string[];
  startX: number;
  startY: number;
  rows: HTMLElement[];
  /** Row midpoints relative to the list's top (scroll-safe). */
  mids: number[];
  /** How far the other rows slide to make room: the dragged row's height plus the gap between rows. */
  step: number;
  active: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  stop: () => void;
};

/**
 * 고정됨 drag-to-reorder, spread on the pinned `<ul>` (its `<li>` children are the `visible` rows, in order).
 * Mouse: press and move. Touch: long-press, then move. The dragged row follows the pointer and the others slide
 * aside; drop commits `onReorder(full order)`. Alt+↑/↓ on a focused control in a row moves it one place.
 * The drag runs on the DOM directly (no re-render per move); the row elements stay owned by React.
 * `listProps` go on the `<ul>`; `live` is the screen-reader announcement of the last move (render it in a polite live region).
 */
export function usePinReorder(visible: string[], pins: string[], onReorder?: (order: string[]) => void) {
  const latest = useRef({ visible, pins, onReorder });
  latest.current = { visible, pins, onReorder };
  const list = useRef<HTMLUListElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClickUntil = useRef(0);
  const [live, setLive] = useState('');
  const announce = (li: Element | undefined, index: number, total: number) => {
    const title = li?.querySelector('.session-title')?.textContent ?? '';
    setLive(`${title} — 고정됨 ${index + 1}/${total}번째로 옮김`);
  };

  // A touch drag must not scroll the sidebar: a non-passive touchmove listener present from the touch's start.
  const blockScroll = useCallback((e: TouchEvent) => { if (drag.current?.active) e.preventDefault(); }, []);
  const ref = useCallback((el: HTMLUListElement | null) => {
    list.current?.removeEventListener('touchmove', blockScroll);
    list.current = el;
    el?.addEventListener('touchmove', blockScroll, { passive: false });
  }, [blockScroll]);
  useEffect(() => () => drag.current?.stop(), []);

  const clearStyles = (d: Drag) => {
    list.current?.classList.remove('pin-reordering');
    for (const r of d.rows) { r.style.transform = ''; r.classList.remove('pin-dragging'); }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLUListElement>) => {
    const ul = list.current;
    const { visible: ids, onReorder: commit } = latest.current;
    suppressClickUntil.current = 0; // a real press: its click is the user's
    if (!ul || !commit || ids.length < 2 || drag.current || e.button !== 0 || !(e.target instanceof Element)) return;
    if (e.target.closest('button, input, textarea, a, [role="menu"]')) return;
    const li = e.target.closest('li');
    const rows = Array.from(ul.children) as HTMLElement[];
    const from = li ? rows.indexOf(li) : -1;
    if (from < 0 || rows.length !== ids.length) return;
    const top = ul.getBoundingClientRect().top;
    const rects = rows.map((r) => r.getBoundingClientRect());
    const gap = rects.length > 1 ? Math.max(0, rects[1]!.top - rects[0]!.bottom) : 0;

    const start = () => {
      const d = drag.current;
      if (!d || d.active) return;
      d.active = true;
      d.timer = null;
      ul.classList.add('pin-reordering');
      d.rows[d.from]!.classList.add('pin-dragging');
      window.getSelection()?.removeAllRanges();
      if (d.touch && typeof navigator.vibrate === 'function') navigator.vibrate(8);
    };
    const render = (d: Drag, dy: number) => {
      const center = Math.min(Math.max(d.mids[d.from]! + dy, d.mids[0]!), d.mids[d.mids.length - 1]!);
      const shift = center - d.mids[d.from]!;
      d.to = dropIndex(d.mids, d.from, center);
      d.rows.forEach((r, i) => {
        if (i === d.from) { r.style.transform = `translateY(${shift}px)`; return; }
        const k = i < d.from ? i : i - 1;
        r.style.transform = i > d.from && k < d.to ? `translateY(${-d.step}px)` : i < d.from && k >= d.to ? `translateY(${d.step}px)` : '';
      });
    };
    const end = (drop: boolean) => {
      const d = drag.current;
      if (!d) return;
      d.stop();
      if (!d.active) return;
      suppressClickUntil.current = Date.now() + SUPPRESS_CLICK_MS; // the click that follows a drop must not open the row
      const { pins: all, visible: shown, onReorder: cb } = latest.current;
      // The list changed under the drag (a broadcast, a filter): positions no longer mean the same rows — drop nothing.
      const same = shown.length === d.ids.length && shown.every((id, i) => id === d.ids[i]);
      const next = drop && same && d.to !== d.from ? reorderVisible(all, d.ids, d.from, d.to) : all;
      // The new order renders before the slide offsets go, in the same frame: no flash of the old order.
      if (next !== all && cb) { flushSync(() => cb(next)); announce(d.rows[d.from], d.to, d.ids.length); }
      clearStyles(d);
    };
    const onMove = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d || ev.pointerId !== d.pointerId) return;
      const dy = ev.clientY - ul.getBoundingClientRect().top - d.startY;
      if (!d.active) {
        if (d.touch) { if (Math.abs(dy) > TOUCH_SLOP || Math.abs(ev.clientX - d.startX) > TOUCH_SLOP) end(false); return; }
        if (Math.abs(dy) <= MOUSE_SLOP) return;
        start();
      }
      ev.preventDefault();
      render(d, dy);
    };
    const onUp = (ev: PointerEvent) => { if (ev.pointerId === drag.current?.pointerId) end(true); };
    const onCancel = (ev: PointerEvent) => { if (ev.pointerId === drag.current?.pointerId) end(false); };
    // Capture phase, swallowed: Escape cancels the drag only, not the drawer / panel / menu behind it.
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && drag.current?.active) { ev.preventDefault(); ev.stopPropagation(); end(false); } };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    drag.current = {
      pointerId: e.pointerId, touch, from, to: from, id: ids[from]!, ids: [...ids], startX: e.clientX, startY: e.clientY - top, rows,
      mids: rects.map((r) => r.top - top + r.height / 2), step: rects[from]!.height + gap, active: false,
      timer: touch ? setTimeout(start, LONG_PRESS_MS) : null,
      stop: () => {
        const d = drag.current;
        if (d?.timer) clearTimeout(d.timer);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey, true);
        drag.current = null;
      },
    };
  };

  const onClickCapture = (e: ReactMouseEvent) => {
    if (Date.now() < suppressClickUntil.current) { suppressClickUntil.current = 0; e.preventDefault(); e.stopPropagation(); }
  };
  // Android opens the context menu on a long press: not while that press is picking a row up.
  const onContextMenuCapture = (e: ReactMouseEvent) => {
    if (drag.current?.touch) { e.preventDefault(); e.stopPropagation(); }
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const { visible: ids, pins: all, onReorder: cb } = latest.current;
    if (!cb || !e.altKey || e.metaKey || e.ctrlKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !(e.target instanceof HTMLElement)) return;
    if (e.target.closest('input, textarea')) return;
    const li = e.target.closest('li');
    const from = li && list.current ? Array.from(list.current.children).indexOf(li) : -1;
    if (from < 0 || list.current?.children.length !== ids.length) return;
    const to = e.key === 'ArrowUp' ? from - 1 : from + 1;
    if (to < 0 || to >= ids.length) return;
    e.preventDefault();
    const focused = e.target;
    cb(reorderVisible(all, ids, from, to));
    announce(li ?? undefined, to, ids.length);
    // React moves the row's element; keep the keyboard focus on the same control.
    requestAnimationFrame(() => { if (focused.isConnected && document.activeElement !== focused) focused.focus(); });
  };

  return { listProps: { ref, onPointerDown, onClickCapture, onContextMenuCapture, onKeyDown }, live };
}
