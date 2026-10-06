import type { ClientMessage, ServerMessage, StreamPos } from '../shared/protocol';

/** A catch-up the server answered with an error is asked again after this long, doubling up to the maximum; back to the minimum on an answer, a reconnect and coming back into view. */
export const CATCHUP_RETRY_MIN_MS = 1000;
export const CATCHUP_RETRY_MAX_MS = 30_000;
/** A request with no answer at all for this long: the socket takes messages but returns none — it is given up for a new one. */
export const CATCHUP_STALL_MS = 30_000;

/**
 * Keeps each shown session's stream in order on this device ('catchup' servers number their turn events: `pos`).
 * `accept` sees every server message before it is applied: an event that does not follow the last applied one is held
 * back (false) and what is missing is asked for with `open_session.after` — the server answers with the events after
 * that position, or with the whole history when it cannot. An event already applied is dropped. Messages without a
 * position (an older server's, cards, lists) pass.
 *
 * One request per session and socket: while it is unanswered nothing is sent again, and after CATCHUP_STALL_MS the
 * socket is reported as `stalled`. An error answer is retried with a growing delay (and shown once); 'not_found' is final.
 */
export function createCatchup(opts: {
  /** false = not connected, nothing sent. */
  send(m: ClientMessage): boolean;
  /** The connected server answers `open_session.after` (features 'catchup'). */
  enabled(): boolean;
  /** The sessions the panes show. Others are not kept in order and nothing is asked for them. */
  shown(): string[];
  /** A request got no answer: reconnect (the new socket's hello asks again). */
  stalled(): void;
}) {
  /** The last applied position per session. */
  const applied = new Map<string, StreamPos>();
  /** Requests on the current socket without an answer yet (their stall clock). */
  const sent = new Map<string, ReturnType<typeof setTimeout>>();
  /** Requests that failed, waiting to be asked again; the delay the next failure waits. */
  const retry = new Map<string, ReturnType<typeof setTimeout>>();
  const delays = new Map<string, number>();
  /** Sessions whose failure the user has been shown (until an answer comes). */
  const told = new Set<string>();

  const stop = (timers: Map<string, ReturnType<typeof setTimeout>>, sid: string) => {
    const t = timers.get(sid);
    if (t !== undefined) clearTimeout(t);
    timers.delete(sid);
  };
  const settle = (sid: string) => { stop(sent, sid); stop(retry, sid); delays.delete(sid); told.delete(sid); };
  const forget = (sid: string) => { applied.delete(sid); settle(sid); };
  const cancel = () => { for (const sid of [...sent.keys(), ...retry.keys()]) { stop(sent, sid); stop(retry, sid); } };

  /** True when a request for the session is (now, or already) out on this socket. */
  function ask(sid: string): boolean {
    if (sent.has(sid)) return true;
    stop(retry, sid);
    const at = applied.get(sid);
    if (!at || !opts.enabled()) return false;
    if (!opts.shown().includes(sid)) { forget(sid); return false; }
    // Not connected: the reconnect's hello asks.
    if (!opts.send({ type: 'open_session', sessionId: sid, after: { epoch: at.epoch, seq: at.seq } })) return false;
    sent.set(sid, setTimeout(() => { cancel(); opts.stalled(); }, CATCHUP_STALL_MS));
    return true;
  }

  return {
    /** False: do not apply this message (a repeat, one ahead of a gap that is being filled, or a failure already shown). */
    accept(msg: ServerMessage): boolean {
      if (msg.type === 'history' || msg.type === 'catchup') {
        if (msg.type === 'history') { if (msg.pos) applied.set(msg.sessionId, msg.pos); else applied.delete(msg.sessionId); }
        settle(msg.sessionId);
        return true;
      }
      const pos = 'pos' in msg ? msg.pos : undefined;
      if (!pos) {
        // The answer to a request of ours: the server could not open the session.
        const sid = msg.type === 'error' && msg.turnId === null && msg.clientRef === undefined ? msg.sessionId : undefined;
        if (msg.type !== 'error' || sid === undefined || !sent.has(sid)) return true;
        if (msg.code === 'not_found') { forget(sid); return true; }
        stop(sent, sid);
        const wait = delays.get(sid) ?? CATCHUP_RETRY_MIN_MS;
        delays.set(sid, Math.min(wait * 2, CATCHUP_RETRY_MAX_MS));
        retry.set(sid, setTimeout(() => { retry.delete(sid); ask(sid); }, wait));
        if (told.has(sid)) return false;
        told.add(sid);
        return true;
      }
      if (!opts.shown().includes(pos.sid)) { forget(pos.sid); return true; }
      const at = applied.get(pos.sid);
      if (!at || pos.seq === at.seq + 1) { applied.set(pos.sid, pos); return true; }
      if (pos.epoch === at.epoch && pos.seq <= at.seq) return false;
      if (!retry.has(pos.sid)) ask(pos.sid);
      return false;
    },
    /**
     * A (re)connected socket's hello: every shown session is opened on it again, once — from this device's position
     * where one is known and the server can, plainly (the whole history) otherwise.
     */
    hello(): void {
      cancel();
      delays.clear();
      told.clear();
      if (!opts.enabled()) applied.clear();
      for (const sid of new Set(opts.shown())) if (!ask(sid)) opts.send({ type: 'open_session', sessionId: sid });
    },
    /** The page is back in view (a phone's socket may have stalled without closing): ask for what the shown sessions missed, now. */
    visible(): void {
      for (const sid of [...retry.keys()]) stop(retry, sid);
      delays.clear();
      if (!opts.enabled()) { applied.clear(); return; }
      for (const sid of new Set(opts.shown())) ask(sid);
    },
    /** The session is opened afresh (its history is on the way) or closed. */
    forget,
    /** The socket closed, or the app is going away: nothing is waited for. */
    cancel,
  };
}

export type Catchup = ReturnType<typeof createCatchup>;
