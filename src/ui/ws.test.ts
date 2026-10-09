// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSocket } from './ws';

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWS.instances.push(this); }
  sent: string[] = [];
  send(d: string) { this.sent.push(d); }
  close() { this.onclose?.({ code: 1006 }); }
}

describe('createSocket', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWS);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('on a close caused by lost authentication, reports it and stops reconnecting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 401, ok: false })));
    const onUnauthed = vi.fn();
    createSocket(() => {}, () => {}, onUnauthed);
    FakeWS.instances[0]!.onclose?.({ code: 1006 });
    await vi.runAllTimersAsync();
    expect(onUnauthed).toHaveBeenCalledTimes(1);
    expect(FakeWS.instances).toHaveLength(1);
  });

  it('reconnect: a socket that stopped answering is dropped at once (its late events go nowhere) and a new one opened', () => {
    const status: boolean[] = [];
    const sock = createSocket(() => {}, (v) => status.push(v));
    const first = FakeWS.instances[0]!;
    first.readyState = 1;
    first.onopen?.();
    sock.reconnect();
    expect(FakeWS.instances).toHaveLength(2);
    expect(status).toEqual([true, false]);
    expect(first.onmessage).toBeNull();
    expect(first.onclose).toBeNull();
    // After close(): nothing.
    sock.close();
    sock.reconnect();
    expect(FakeWS.instances).toHaveLength(2);
  });

  it('still reconnects when the session is valid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true })));
    const onUnauthed = vi.fn();
    createSocket(() => {}, () => {}, onUnauthed);
    FakeWS.instances[0]!.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(onUnauthed).not.toHaveBeenCalled();
    expect(FakeWS.instances.length).toBeGreaterThan(1);
  });

  it('send reports whether the message left: false until open', () => {
    const s = createSocket(() => {}, () => {});
    expect(s.send({ type: 'interrupt', turnId: 't' })).toBe(false);
    FakeWS.instances[0]!.readyState = FakeWS.OPEN;
    expect(s.send({ type: 'interrupt', turnId: 't' })).toBe(true);
  });

  it('open_session says which newer server message kinds this UI understands (sandbox); other messages go as they are', () => {
    const s = createSocket(() => {}, () => {});
    const w = FakeWS.instances[0]!;
    w.readyState = FakeWS.OPEN;
    s.send({ type: 'open_session', sessionId: 's1' });
    s.send({ type: 'interrupt', turnId: 't' });
    expect(w.sent.map((d) => JSON.parse(d))).toEqual([{ type: 'open_session', sessionId: 's1', accepts: ['sandbox'] }, { type: 'interrupt', turnId: 't' }]);
  });

  it('wake() during the backoff wait opens a new socket at once and resets the delay', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true })));
    const sock = createSocket(() => {}, () => {});
    FakeWS.instances[0]!.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(0); // the /api/me check is done; the 1 s wait is pending (the next one will be 2 s)
    expect(FakeWS.instances).toHaveLength(1);
    sock.wake();
    expect(FakeWS.instances).toHaveLength(2);
    // The delay is back to 1 s, and the cleared timer does not open a third socket.
    FakeWS.instances[1]!.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWS.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWS.instances).toHaveLength(3);
  });

  it('wake() while the /api/me check is still out opens as soon as it answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true })));
    const sock = createSocket(() => {}, () => {});
    FakeWS.instances[0]!.onclose?.({ code: 1006 });
    sock.wake();
    expect(FakeWS.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWS.instances).toHaveLength(2);
  });

  it('wake() while connected does nothing', async () => {
    const sock = createSocket(() => {}, () => {});
    FakeWS.instances[0]!.readyState = 1;
    FakeWS.instances[0]!.onopen?.();
    sock.wake();
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWS.instances).toHaveLength(1);
  });
});
