import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

const MARGIN = 8;
const GAP = 6;

/**
 * Places a `position: fixed` popover next to its anchor, right-aligned and clamped inside the viewport; it opens
 * upward unless there is clearly more room below (flips), with a max-height so it scrolls instead of being clipped.
 * `align: 'start'` left-aligns it instead (an anchor at the left edge, e.g. the composer's attach +).
 */
export function usePopoverPlacement(open: boolean, anchorRef: RefObject<HTMLElement | null>, popRef: RefObject<HTMLElement | null>, fallbackWidth = 300, align: 'start' | 'end' = 'end'): CSSProperties {
  const [pos, setPos] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const b = anchorRef.current?.getBoundingClientRect();
      const pop = popRef.current;
      if (!b || !pop) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(pop.offsetWidth || fallbackWidth, vw - 2 * MARGIN);
      const left = Math.max(MARGIN, Math.min(align === 'start' ? b.left : b.right - width, vw - width - MARGIN));
      const above = b.top - GAP - MARGIN;
      const below = vh - b.bottom - GAP - MARGIN;
      setPos(below > above
        ? { left, top: b.bottom + GAP, maxHeight: below }
        : { left, bottom: vh - b.top + GAP, maxHeight: above });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, anchorRef, popRef, fallbackWidth, align]);
  return pos;
}
