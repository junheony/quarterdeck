import type { ClientMessage, ServerMessage } from '../shared/protocol';

/**
 * Review M10: a browser cannot see the HTTP status of a refused upgrade, so after every close
 * the session is checked with /api/me; a 401 hands back to the login screen instead of
 * looping on "재연결 중…".
 */
export function createSocket(
  onMessage: (m: ServerMessage) => void,
  onStatus: (connected: boolean) => void,
  onUnauthed: () => void = () => {},
): { /** `false`: not connected, nothing sent. */ send(m: ClientMessage): boolean; /** Drops the current socket (it stopped answering) and connects anew, without waiting for its close. */ reconnect(): void; close(): void } {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 1000;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  const open = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => { delay = 1000; onStatus(true); };
    ws.onmessage = (ev) => { try { onMessage(JSON.parse(String(ev.data)) as ServerMessage); } catch { /* ignore */ } };
    ws.onclose = () => {
      onStatus(false);
      if (closed) return;
      void fetch('/api/me', { credentials: 'same-origin' })
        .then((r) => r.status === 401, () => false)
        .then((unauthed) => {
          if (closed) return;
          if (unauthed) { closed = true; onUnauthed(); return; }
          setTimeout(open, delay);
          delay = Math.min(delay * 2, 10_000);
        });
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return {
    send(m) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(m));
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
    close() { closed = true; ws?.close(); },
  };
}
