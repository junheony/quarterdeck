import { useEffect, useRef } from 'react';
import type { PaneState } from './state';

/**
 * How long a send may wait for its turn_started (시작하는 중…) on a connected socket before the socket is suspected dead.
 * A healthy server answers within a second or two; a phone coming back from the background can hold a socket that looks
 * open but delivers nothing. Reconnecting makes the new socket's hello requeue the send (state.ts: requeue 'lost'), so the
 * message is checked against the history and resent, or shown as a paused queue item — never left spinning.
 */
export const START_STALL_MS = 15_000;

/**
 * Calls `reconnect` once per wait when a pane has been `awaitingStart` for START_STALL_MS while connected. A wait is the
 * pane plus its clientRef, counted from when this hook first saw it; a wait that ends and starts again (a resend under
 * the same ref) counts anew. Disconnected time does not count: the next hello settles those waits by itself.
 */
export function useStartWatch(panes: PaneState[], connected: boolean, reconnect: () => void): void {
  const since = useRef(new Map<string, number | 'fired'>());
  const go = useRef(reconnect);
  go.current = reconnect;
  const waits = connected ? panes.filter((p) => p.awaitingStart).map((p) => `${p.id}\n${p.awaitingRef ?? ''}`) : [];
  const key = waits.join('\t');
  useEffect(() => {
    const m = since.current;
    const now = Date.now();
    for (const k of [...m.keys()]) if (!waits.includes(k)) m.delete(k);
    for (const k of waits) if (!m.has(k)) m.set(k, now);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const due = [...m.values()].filter((v): v is number => v !== 'fired');
      if (!due.length) return;
      timer = setTimeout(() => {
        let hit = false;
        for (const [k, v] of m) if (v !== 'fired' && Date.now() - v >= START_STALL_MS) { m.set(k, 'fired'); hit = true; }
        if (hit) go.current();
        arm();
      }, Math.max(0, Math.min(...due) + START_STALL_MS - Date.now()));
    };
    arm();
    return () => clearTimeout(timer);
    // `waits` is covered by `key` (the same strings, joined).
  }, [key]);
}
