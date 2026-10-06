import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { drain, installGracefulShutdown, type DrainTarget } from './lifecycle';

/** A fake clock + target: `finishAt[i]` is when turn i ends; abort ends all. */
function world(finishAt: number[]) {
  let t = 0;
  let aborted = false;
  const calls: string[] = [];
  const target: DrainTarget = {
    drain: () => { calls.push('drain'); },
    activeTurns: () => (aborted ? 0 : finishAt.filter((f) => f > t).length),
    abortAll: () => { calls.push('abort'); aborted = true; },
  };
  return { target, calls, now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe('drain', () => {
  it('refuses new turns at once and resolves when running turns finish, without aborting', async () => {
    const w = world([2500, 7000]);
    const logs: string[] = [];
    expect(await drain(w.target, { maxMs: 60_000, now: w.now, sleep: w.sleep, log: (m) => logs.push(m) })).toBe('drained');
    expect(w.calls).toEqual(['drain']);
    expect(w.now()).toBe(7000);
    expect(logs.join('\n')).toContain('2개');
  });

  it('aborts what is left at the deadline', async () => {
    const w = world([1000, 10 * 60_000]);
    expect(await drain(w.target, { maxMs: 5 * 60_000, now: w.now, sleep: w.sleep })).toBe('timeout');
    expect(w.calls).toEqual(['drain', 'abort']);
    expect(w.now()).toBe(5 * 60_000);
  });

  it('with nothing running it is done immediately', async () => {
    const w = world([]);
    expect(await drain(w.target, { maxMs: 1000, now: w.now, sleep: w.sleep })).toBe('drained');
    expect(w.now()).toBe(0);
  });
});

describe('installGracefulShutdown', () => {
  function host() {
    const handlers = new Map<string, () => void>();
    return { on: (sig: string, fn: () => void) => { handlers.set(sig, fn); }, fire: (sig: string) => handlers.get(sig)!() };
  }

  it('SIGTERM and SIGUSR2 drain then exit once; a second signal exits now', async () => {
    const h = host();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let active = 1;
    const calls: string[] = [];
    const target: DrainTarget = { drain: () => calls.push('drain'), activeTurns: () => active, abortAll: () => { calls.push('abort'); active = 0; } };
    const exits: string[] = [];
    const g = installGracefulShutdown(h, target, { maxMs: 60_000, pollMs: 1, sleep: () => gate, exit: (r) => exits.push(r) });
    h.fire('SIGUSR2');
    expect(g.draining()).toBe(true);
    expect(calls).toEqual(['drain']);
    expect(exits).toEqual([]);
    h.fire('SIGTERM');
    expect(calls).toEqual(['drain', 'drain', 'abort']);
    expect(exits).toEqual(['SIGTERM']);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(exits).toEqual(['SIGTERM']);
  });

  it('exits after the drain completes', async () => {
    const h = host();
    let active = 1;
    const target: DrainTarget = { drain: () => {}, activeTurns: () => active, abortAll: () => {} };
    const exits: string[] = [];
    installGracefulShutdown(h, target, { maxMs: 60_000, pollMs: 1, sleep: async () => { active = 0; }, exit: (r) => exits.push(r) });
    h.fire('SIGTERM');
    await new Promise((r) => setTimeout(r, 0));
    expect(exits).toEqual(['SIGTERM:drained']);
  });

  it('SIGINT does not wait', () => {
    const h = host();
    const calls: string[] = [];
    const exits: string[] = [];
    installGracefulShutdown(h, { drain: () => calls.push('drain'), activeTurns: () => 3, abortAll: () => calls.push('abort') }, { maxMs: 60_000, exit: (r) => exits.push(r) });
    h.fire('SIGINT');
    expect(calls).toEqual(['drain', 'abort']);
    expect(exits).toEqual(['SIGINT']);
  });
});

describe('config: drain and background limits', () => {
  it('defaults to 15 min drain and 120 min background hold; env minutes override, junk is ignored', () => {
    const d = loadConfig({ PATH: '/nonexistent' }, '/h', '/repo');
    expect(d.drainMaxMs).toBe(15 * 60_000);
    expect(d.bgMaxMs).toBe(120 * 60_000);
    const o = loadConfig({ PATH: '/nonexistent', DECK_DRAIN_MAX_MIN: '30', DECK_BG_MAX_MIN: '0.5' }, '/h', '/repo');
    expect(o.drainMaxMs).toBe(30 * 60_000);
    expect(o.bgMaxMs).toBe(30_000);
    expect(loadConfig({ PATH: '/nonexistent', DECK_DRAIN_MAX_MIN: 'x', DECK_BG_MAX_MIN: '-1' }, '/h', '/repo')).toMatchObject({ drainMaxMs: 15 * 60_000, bgMaxMs: 120 * 60_000 });
  });

  it('steering is on unless DECK_STEER=0', () => {
    expect(loadConfig({ PATH: '/nonexistent' }, '/h', '/repo').steer).toBe(true);
    expect(loadConfig({ PATH: '/nonexistent', DECK_STEER: '1' }, '/h', '/repo').steer).toBe(true);
    expect(loadConfig({ PATH: '/nonexistent', DECK_STEER: '0' }, '/h', '/repo').steer).toBe(false);
  });
});
