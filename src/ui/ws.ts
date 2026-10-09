import type { ClientMessage, ServerMessage } from '../shared/protocol';

/** Server message kinds beyond the base set this UI handles: told with every open_session (docs/protocol.md rule 3). */
const ACCEPTS = ['sandbox'];

/**
 * Review M10: a browser cannot see the HTTP status of a refused upgrade, so after every close
 * the session is checked with /api/me; a 401 hands back to the login screen instead of
 * looping on "재연결 중…".
 */
export function createSocket(
  onMessage: (m: ServerMessage) => void,
  onStatus: (connected: boolean) => void,
  onUnauthed: () => void = () => {},
): { /** `false`: not connected, nothing sent. */ send(m: ClientMessage): boolean; /** Drops the current socket (it stopped answering) and connects anew, without waiting for its close. */ reconnect(): void; /** The page is back in view or the network is back: skips the reconnect wait (or the check before it) and connects now; nothing when connected or connecting. */ wake(): void; close(): void } {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 1000;
  /** The reconnect wait, while one runs. */
  let pending: ReturnType<typeof setTimeout> | undefined;
  /** The close handler's /api/me check is out (no wait is running yet). */
  let checking = false;
  /** wake() came during that check: connect as soon as it answers, without waiting. */
  let wakeRequested = false;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  const open = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => { delay = 1000; onStatus(true); };
    ws.onmessage = (ev) => { try { onMessage(JSON.parse(String(ev.data)) as ServerMessage); } catch { /* ignore */ } };
    ws.onclose = () => {
      onStatus(false);
      if (closed) return;
      checking = true;
      void fetch('/api/me', { credentials: 'same-origin' })
        .then((r) => r.status === 401, () => false)
        .then((unauthed) => {
          checking = false;
          const woken = wakeRequested;
          wakeRequested = false;
          if (closed) return;
          if (unauthed) { closed = true; onUnauthed(); return; }
          if (woken) { delay = 1000; open(); return; }
          pending = setTimeout(() => { pending = undefined; open(); }, delay);
          delay = Math.min(delay * 2, 10_000);
        });
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return {
    send(m) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(m.type === 'open_session' ? { ...m, accepts: ACCEPTS } : m));
      return true;
    },
    reconnect() {
      if (closed || !ws) return;
      const old = ws;
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      old.close();
      onStatus(false);
      open();
    },
    wake() {
      if (closed) return;
      // A phone back from the background must not sit out a wait of up to 10 s that was set while it slept.
      if (pending !== undefined) { clearTimeout(pending); pending = undefined; delay = 1000; open(); }
      else if (checking) wakeRequested = true;
    },
    close() { closed = true; if (pending !== undefined) clearTimeout(pending); pending = undefined; ws?.close(); },
  };
}
