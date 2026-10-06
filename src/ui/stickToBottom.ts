import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Within this many px of the bottom, scrolling down re-attaches (Desktop-like). */
export const STICK_THRESHOLD = 64;
/** At most this far from the bottom counts as "at the bottom" whatever the direction (sub-pixel rounding). */
const AT_BOTTOM = 2;

export type ScrollSample = { top: number; height: number; client: number };

export const distanceFromBottom = (s: ScrollSample) => s.height - s.top - s.client;

/**
 * Whether the transcript follows new content after a scroll event.
 * - at the very bottom: attached (our own follow lands here, and so does the browser clamping on shrink);
 * - moved up: detached — only a user (wheel, touch, keys, scrollbar) or a deliberate jump (search hit) moves it up,
 *   our follow only ever moves it down;
 * - moved down into the threshold by the user (content height unchanged — not a scroll-anchoring shift): attached;
 * - otherwise unchanged (e.g. content growth while detached).
 */
export function nextStick(stick: boolean, prev: { top: number; height: number }, s: ScrollSample, threshold = STICK_THRESHOLD): boolean {
  const dist = distanceFromBottom(s);
  if (dist <= AT_BOTTOM) return true;
  if (s.top < prev.top - 1) return false;
  if (s.top > prev.top && s.height === prev.height && dist <= threshold) return true;
  return stick;
}

const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);
const nativeAnchoring = () => typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('overflow-anchor', 'auto');

/**
 * Stick-to-bottom for a scroll container whose direct children are the transcript.
 * State lives in refs; React state changes only on detach/attach and on the first unseen content (the jump button).
 * `resetKey` changing (session switch) re-attaches; `contentKey` changing (new items) follows or marks unread.
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, contentKey: unknown, resetKey: unknown) {
  const stick = useRef(true);
  const lastTop = useRef(0);
  /** scrollHeight at the last scroll event (nextStick) and at the last resize (unread detection). */
  const scrollHeight = useRef(0);
  const lastHeight = useRef(0);
  const touchY = useRef<number | null>(null);
  // Manual anchoring (browsers without overflow-anchor, i.e. Safari): the first child crossing the viewport top.
  const anchor = useRef<{ el: Element; offset: number } | null>(null);
  const [detached, setDetached] = useState(false);
  const [unread, setUnread] = useState(false);
  const shown = useRef({ detached: false, unread: false });

  const publish = useCallback((d: boolean, u: boolean) => {
    if (shown.current.detached !== d) { shown.current.detached = d; setDetached(d); }
    if (shown.current.unread !== u) { shown.current.unread = u; setUnread(u); }
  }, []);

  const recordAnchor = useCallback((el: HTMLElement) => {
    if (nativeAnchoring()) return;
    const top = el.getBoundingClientRect().top;
    const kids = el.children;
    let lo = 0, hi = kids.length - 1, found: Element | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const kid = kids[mid]!;
      if (kid.getBoundingClientRect().bottom > top) { found = kid; hi = mid - 1; } else lo = mid + 1;
    }
    anchor.current = found ? { el: found, offset: found.getBoundingClientRect().top - top } : null;
  }, []);

  const toBottom = useCallback((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, []);

  /** Content or viewport changed size: follow when attached, else keep what the user reads in place. */
  const onResize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const grew = el.scrollHeight > lastHeight.current;
    lastHeight.current = el.scrollHeight;
    if (stick.current) { toBottom(el); return; }
    const a = anchor.current;
    if (a && a.el.isConnected && !nativeAnchoring()) {
      const delta = a.el.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset;
      if (Math.abs(delta) > 0.5) { el.scrollTop += delta; lastTop.current = el.scrollTop; }
    }
    recordAnchor(el);
    if (grew) publish(true, true);
  }, [ref, toBottom, recordAnchor, publish]);

  const detach = useCallback(() => {
    const el = ref.current;
    if (!el || el.scrollTop <= 0 || !stick.current) return;
    stick.current = false;
    publish(true, shown.current.unread);
  }, [ref, publish]);

  /** Jump to the bottom and follow again (jump button, send, session switch). */
  const attach = useCallback(() => {
    stick.current = true;
    const el = ref.current;
    if (el) { toBottom(el); lastHeight.current = el.scrollHeight; }
    publish(false, false);
  }, [ref, toBottom, publish]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const s = { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
      stick.current = nextStick(stick.current, { top: lastTop.current, height: scrollHeight.current }, s);
      lastTop.current = s.top;
      scrollHeight.current = s.height;
      if (stick.current) publish(false, false);
      else { publish(true, shown.current.unread); recordAnchor(el); }
    };
    // Upward intent detaches at once, before the scroll lands (a follow in the same frame would undo it).
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) detach(); };
    const onKey = (e: KeyboardEvent) => { if (UP_KEYS.has(e.key) || (e.key === ' ' && e.shiftKey)) detach(); };
    const onTouchStart = (e: TouchEvent) => { touchY.current = e.touches[0]?.clientY ?? null; };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (y !== undefined && touchY.current !== null && y > touchY.current + 2) detach();
      if (y !== undefined) touchY.current = y;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('keydown', onKey);
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    let ro: ResizeObserver | null = null;
    let mo: MutationObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      const obs = new ResizeObserver(onResize);
      ro = obs;
      obs.observe(el);
      for (const c of el.children) obs.observe(c);
      if (typeof MutationObserver !== 'undefined') {
        mo = new MutationObserver((records) => {
          for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) obs.observe(n);
        });
        mo.observe(el, { childList: true });
      }
    }
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [ref, onResize, detach, publish, recordAnchor]);

  // New items: same as a resize (the ResizeObserver also catches growth inside a message, images, expanding cards).
  useLayoutEffect(onResize, [contentKey, onResize]);

  // Session switch: open at the bottom.
  const prevReset = useRef(resetKey);
  useLayoutEffect(() => {
    if (prevReset.current === resetKey) return;
    const wasSession = prevReset.current != null;
    prevReset.current = resetKey;
    if (wasSession) attach();
  }, [resetKey, attach]);

  return { detached, unread, attach };
}
