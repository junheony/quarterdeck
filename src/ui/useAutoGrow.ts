import { useLayoutEffect, type RefObject } from 'react';

/**
 * Fits a textarea's height to its text; the CSS max-height caps it (then the textarea scrolls). Measuring sets the
 * height to auto for a moment, which grows the transcript above (`keep`) and makes the browser clamp its scrollTop —
 * read as the user scrolling up, it would detach stick-to-bottom mid-stream. So `keep`'s scroll is put back: to the
 * bottom if it was there, else where it was.
 */
export function autoGrow(ta: HTMLTextAreaElement, keep?: HTMLElement | null): void {
  const top = keep?.scrollTop ?? 0;
  const atBottom = !!keep && keep.scrollHeight - top - keep.clientHeight <= 2;
  ta.style.height = 'auto';
  const full = ta.scrollHeight;
  if (full) ta.style.height = `${full}px`;
  // While the whole text fits, the textarea must not be a scroller. Typing onto a new line scrolls it by a line to
  // reveal the caret before this refit; iOS/iPadOS keeps that offset on its own scroller after the box has grown, so
  // the text sits a line off from where the caret is drawn. Only a text taller than the CSS max-height scrolls.
  ta.style.overflowY = full && ta.clientHeight >= full ? 'hidden' : '';
  if (keep) keep.scrollTop = atBottom ? keep.scrollHeight : top;
}

/** Re-fits on every change of `value` (typing, a recalled message, the empty composer after a send) and of width. */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, keep?: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    if (ref.current) autoGrow(ref.current, keep?.current);
  }, [ref, keep, value]);
  // A narrower pane (split, side panel, window resize) wraps the text onto more lines.
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta || typeof ResizeObserver === 'undefined') return;
    let width = ta.clientWidth;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      // Our own height change — unless the cap (max-height: 40vh) dropped below a text that used to fit: refit so it scrolls.
      if (ta.clientWidth === width && !(ta.style.overflowY === 'hidden' && ta.scrollHeight > ta.clientHeight)) return;
      width = ta.clientWidth;
      // Resizing inside the observer callback trips "ResizeObserver loop completed"; refit on the next frame.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => autoGrow(ta, keep?.current));
    });
    ro.observe(ta);
    return () => { ro.disconnect(); cancelAnimationFrame(frame); };
  }, [ref, keep]);
}
