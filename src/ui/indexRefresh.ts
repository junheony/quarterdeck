import { useEffect, useRef } from 'react';

/** At most one `refresh_index` per this gap; a request inside it runs once at its end (trailing). */
export const INDEX_REFRESH_MIN_GAP_MS = 20_000;
/** While the page is visible, a full rescan this often (new sessions started outside deck appear without a click). */
export const INDEX_REFRESH_EVERY_MS = 120_000;

/** After a turn's result, how long to wait for the server's own index (a newer server sends one at a turn's end) before asking. */
export const AFTER_TURN_WAIT_MS = 3_000;

/**
 * `run` (a rescan) at most once per `gapMs`. `request`: now, or not at all inside the gap (a list that fresh is fresh
 * enough — reconnect and coming into view often come together). `afterTurn`: a turn ended — if no index arrives within
 * `waitMs` (an older server sends none for an existing session), a rescan, at the gap's end if inside it. `indexSeen`:
 * an index message arrived.
 */
export function throttled(run: () => void, gapMs = INDEX_REFRESH_MIN_GAP_MS, now: () => number = Date.now, waitMs = AFTER_TURN_WAIT_MS) {
  let last = -Infinity;
  let seen = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let turnTimer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => { timer = null; last = now(); run(); };
  const trailing = () => {
    if (timer) return;
    const wait = last + gapMs - now();
    if (wait <= 0) fire();
    else timer = setTimeout(fire, wait);
  };
  return {
    request() { if (!timer && now() - last >= gapMs) fire(); },
    afterTurn() {
      if (turnTimer) return;
      const at = now();
      turnTimer = setTimeout(() => { turnTimer = null; if (seen < at) trailing(); }, waitMs);
    },
    indexSeen() { seen = now(); },
    cancel() {
      if (timer) clearTimeout(timer);
      if (turnTimer) clearTimeout(turnTimer);
      timer = turnTimer = null;
    },
  };
}

export type IndexRefresh = Pick<ReturnType<typeof throttled>, 'request' | 'afterTurn' | 'indexSeen'>;

/**
 * Keeps the sidebar's list fresh: asks the server for a rescan when the page comes back into view and every
 * INDEX_REFRESH_EVERY_MS while it is visible (throttled). Returns the same throttle for the socket's own triggers
 * (reconnect, a turn's result, an index that arrived). Works with any server: `refresh_index` is an existing message.
 */
export function useIndexRefresh(enabled: boolean, send: () => void): IndexRefresh {
  const sendRef = useRef(send);
  sendRef.current = send;
  const t = useRef<ReturnType<typeof throttled> | null>(null);
  if (!t.current) t.current = throttled(() => sendRef.current());
  useEffect(() => {
    if (!enabled) return;
    const th = t.current!;
    const visible = () => document.visibilityState === 'visible';
    const onVis = () => { if (visible()) th.request(); };
    document.addEventListener('visibilitychange', onVis);
    const every = setInterval(() => { if (visible()) th.request(); }, INDEX_REFRESH_EVERY_MS);
    return () => { document.removeEventListener('visibilitychange', onVis); clearInterval(every); th.cancel(); };
  }, [enabled]);
  return t.current;
}
