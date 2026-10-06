import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { FEATURES, type ServerMessage, type StreamPos } from '../shared/protocol';
import { cookieValueFor } from './auth';
import { StubEngine, okResult } from './engine/StubEngine';
import { createRequestHandler } from './http';
import { AcceptedRefs } from './sessions/AcceptedRefs';
import { PinStore } from './sessions/PinStore';
import { SessionIndex } from './sessions/SessionIndex';
import { SettingsStore } from './settings';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner, type TurnSink } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket } from './ws';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'c'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
let base: string;
let work: string;
let store: SessionStateStore;
let index: SessionIndex;
/** Two servers over the same sessions: the default one, and one that keeps only the last two events of a stream. */
let full: Awaited<ReturnType<typeof boot>>;
let short: Awaited<ReturnType<typeof boot>>;
/** A server whose runner is scripted (below), keeping 4000 bytes of a stream and dropping an idle process's after 60 ms. */
let scripted: Awaited<ReturnType<typeof boot>>;
let release: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
const hold = () => { gate = new Promise<void>((r) => { release = r; }); };

async function boot(runner: TurnRunner, usage: UsageService, extra: { catchupKeep?: number; catchupKeepBytes?: number; catchupIdleMs?: number } = {}, name = String(extra.catchupKeep ?? 'd')) {
  const pins = new PinStore(path.join(base, `pins-${name}.json`));
  await pins.load();
  const settings = new SettingsStore(path.join(base, `settings-${name}.json`));
  await settings.load();
  const server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  const api = attachWebSocket([server], { accounts: testRegistry(), token: TOKEN, devOrigins: [], runner, index, usage, store, codexAvailable: false, cwdRoots: [path.dirname(work)], pins, settings, acceptedRefs: new AcceptedRefs(null), outsidePollMs: 0, ...extra });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { server, api, origin: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws` };
}

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wscu-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wscu-work-')));
  index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }) });
  store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const stub = new StubEngine(async (req) => {
    const sid = req.resumeSessionId ?? 'sess-new';
    if (req.prompt === 'slow') {
      return (async function* () {
        yield { kind: 'init' as const, sessionId: sid, model: 'm' };
        yield { kind: 'delta' as const, text: 'a' };
        yield { kind: 'delta' as const, text: 'b' };
        await gate;
        yield { kind: 'delta' as const, text: 'c' };
        yield okResult(sid, 'abc');
      })();
    }
    return [{ kind: 'init', sessionId: sid, model: 'm' }, { kind: 'delta', text: 'o' }, { kind: 'delta', text: 'k' }, okResult(sid, 'ok')];
  });
  const runner = new TurnRunner({ accounts: testRegistry(), attachments: null, engine: stub, usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots), codex: null, codexSessionsRoot: path.join(base, 'codex') });
  full = await boot(runner, usage);
  short = await boot(runner, usage, { catchupKeep: 2 });
  // A runner that plays a script: 'big' streams a small and a large (Korean) delta and waits; 'park' ends its turn and
  // keeps its process open (background work); 'abort' rejects with the SDK's text once it is interrupted.
  const run = async (p: Parameters<TurnRunner['run']>[0], sink: TurnSink): Promise<void> => {
    const scope = { turnId: p.turnId, sessionId: p.sessionId, cwd: p.cwd };
    sink.emit({ type: 'turn_started', ...scope, account: 'b', model: 'opus', reason: '', attempt: 1 });
    if (p.text === 'abort') {
      await new Promise<void>((_, reject) => sink.signal!.addEventListener('abort', () => reject(new Error('Claude Code process aborted by user'))));
    }
    sink.emit({ type: 'delta', ...scope, text: 'x' });
    if (p.text === 'big') { sink.emit({ type: 'delta', ...scope, text: BIG }); await gate; }
    sink.emit({ type: 'turn_result', ...scope, ok: true, text: 'x', badge: null, errorText: null });
    if (p.text === 'park') await gate;
  };
  scripted = await boot(Object.assign(Object.create(runner) as TurnRunner, { run }), usage, { catchupKeepBytes: 4000, catchupIdleMs: 60 }, 'scripted');
});
afterAll(async () => {
  release();
  for (const s of [full, short, scripted]) { s.api.close(); s.server.close(); }
  await fs.rm(base, { recursive: true, force: true });
  await fs.rm(work, { recursive: true, force: true });
});

/** 1500 Korean characters: 1500 UTF-16 units, 4500 bytes. */
const BIG = '가'.repeat(1500);

type Stamped = ServerMessage & { pos: StreamPos };
const stamped = (m: ServerMessage): m is Stamped => 'pos' in m && m.pos !== undefined && m.type !== 'history' && m.type !== 'catchup';

/** A socket that buffers everything from connection time; `next(type)` waits for the next matching message. */
async function client(at = full) {
  const ws = new WebSocket(at.wsUrl, { headers: { Origin: at.origin, Cookie: COOKIE } });
  const got: ServerMessage[] = [];
  let read = 0;
  let wake: (() => void) | null = null;
  ws.on('message', (d) => { got.push(JSON.parse(String(d)) as ServerMessage); wake?.(); });
  await new Promise<void>((r) => ws.once('open', () => r()));
  const c = {
    got,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
    async next<T extends ServerMessage['type']>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true): Promise<Extract<ServerMessage, { type: T }>> {
      const deadline = Date.now() + 3000;
      for (;;) {
        while (read < got.length) {
          const m = got[read++]!;
          if (m.type === type && pred(m as Extract<ServerMessage, { type: T }>)) return m as Extract<ServerMessage, { type: T }>;
        }
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${type}; got ${JSON.stringify(got)}`);
        await new Promise<void>((r) => { wake = r; setTimeout(r, 50); });
      }
    },
    /** The stream events of `sid` received so far. */
    events: (sid: string) => got.filter(stamped).filter((m) => m.pos.sid === sid),
    /** What arrives in the next `ms`. */
    async quiet(ms = 150) { const n = got.length; await new Promise((r) => setTimeout(r, ms)); return got.slice(n); },
  };
  await c.next('hello');
  return c;
}

/** A session on account b whose jsonl exists and whose state is warm, so turns stay on b. */
async function seed(sid: string, name: string): Promise<string> {
  const cwd = path.join(work, name);
  await fs.mkdir(cwd, { recursive: true });
  const dir = path.join(base, 'b', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'seed' } }) + '\n');
  await index.refresh();
  await store.set({ sessionId: sid, cwd, account: 'b', projectDir: dir, lastTurnAtMs: Date.now(), justCompacted: false, defaultModel: 'opus' });
  return cwd;
}

const seqs = (ms: Stamped[]) => ms.map((m) => m.pos.seq);
const consecutive = (ns: number[]) => ns.every((n, i) => i === 0 || n === ns[i - 1]! + 1);

describe('features', () => {
  it('hello lists what this server can do', async () => {
    const c = await client();
    expect(c.got[0]).toMatchObject({ type: 'hello', features: [...FEATURES] });
    expect(FEATURES).toContain('catchup');
    c.close();
  });
});

describe('stream positions', () => {
  it('every event of a session is numbered, one by one, across turns; history says where the stream stands', async () => {
    const sid = 'c0c0c0c0-0000-4000-8000-000000000001';
    const cwd = await seed(sid, 'seq');
    const c = await client();
    c.send({ type: 'send', sessionId: sid, cwd, text: 'one' });
    await c.next('turn_result');
    const first = c.events(sid);
    expect(first.length).toBeGreaterThanOrEqual(4);
    expect(first[0]!.type).toBe('turn_started');
    expect(first[0]!.pos.seq).toBe(1);
    expect(consecutive(seqs(first))).toBe(true);
    expect(new Set(first.map((m) => m.pos.epoch)).size).toBe(1);

    c.send({ type: 'open_session', sessionId: sid });
    const h = await c.next('history');
    expect(h.pos).toEqual(first[first.length - 1]!.pos);

    // The next turn (a new process): the numbers go on, under a new epoch.
    await new Promise((r) => setTimeout(r, 50));
    c.send({ type: 'send', sessionId: sid, cwd, text: 'two' });
    await c.next('turn_result');
    const all = c.events(sid);
    expect(consecutive(seqs(all))).toBe(true);
    expect(all[all.length - 1]!.pos.epoch).not.toBe(first[0]!.pos.epoch);
    c.close();
  });

  it('a session opened before any turn has no position', async () => {
    const sid = 'c0c0c0c0-0000-4000-8000-000000000002';
    await seed(sid, 'none');
    const c = await client();
    c.send({ type: 'open_session', sessionId: sid });
    expect((await c.next('history')).pos).toBeUndefined();
    c.close();
  });
});

describe('catch-up (open_session.after)', () => {
  it('mid-turn, a device that comes back gets only what it missed — then the live stream', async () => {
    const sid = 'c0c0c0c0-0000-4000-8000-000000000003';
    const cwd = await seed(sid, 'mid');
    hold();
    const a = await client();
    a.send({ type: 'send', sessionId: sid, cwd, text: 'slow', clientRef: 'ref-mid' });
    await a.next('delta', (m) => m.text === 'b');
    const sofar = a.events(sid);
    const da = sofar.find((m) => m.type === 'delta' && m.text === 'a')!;

    const b = await client();
    b.send({ type: 'open_session', sessionId: sid, after: { epoch: da.pos.epoch, seq: da.pos.seq } });
    const head = await b.next('catchup');
    expect(head).toMatchObject({ sessionId: sid, runningTurnId: sofar[0]!.type === 'turn_started' ? sofar[0]!.turnId : 'x', sessionModel: 'opus', acceptedRefs: ['ref-mid'] });
    await b.next('delta', (m) => m.text === 'b');
    expect(b.got.some((m) => m.type === 'history')).toBe(false);
    expect(b.events(sid)[0]!.pos.seq).toBe(da.pos.seq + 1);
    expect(b.events(sid).map((m) => JSON.stringify(m))).toEqual(a.events(sid).filter((m) => m.pos.seq > da.pos.seq).map((m) => JSON.stringify(m)));

    release();
    await b.next('turn_result');
    await a.next('turn_result');
    expect(consecutive(seqs(b.events(sid)))).toBe(true);
    expect(b.events(sid).map((m) => m.pos.seq)).toEqual(a.events(sid).filter((m) => m.pos.seq > da.pos.seq).map((m) => m.pos.seq));
    a.close();
    b.close();
  });

  it('a position the server cannot answer from gets the full history: another epoch, ahead of the stream, or a finished turn on a new socket', async () => {
    const sid = 'c0c0c0c0-0000-4000-8000-000000000004';
    const cwd = await seed(sid, 'full');
    hold();
    const a = await client();
    a.send({ type: 'send', sessionId: sid, cwd, text: 'slow' });
    const db = await a.next('delta', (m) => m.text === 'b');
    const pos = db.pos!;

    const b = await client();
    b.send({ type: 'open_session', sessionId: sid, after: { epoch: 'another-process', seq: pos.seq } });
    expect((await b.next('history')).pos).toEqual(pos);
    b.send({ type: 'open_session', sessionId: sid, after: { epoch: pos.epoch, seq: pos.seq + 50 } });
    await b.next('history');
    expect(b.got.some((m) => m.type === 'catchup')).toBe(false);
    b.close();

    release();
    const done = await a.next('turn_result');
    // The turn's process is gone: a new socket may have missed more than the stream (writes from outside deck).
    await new Promise((r) => setTimeout(r, 50));
    const c = await client();
    c.send({ type: 'open_session', sessionId: sid, after: { epoch: pos.epoch, seq: pos.seq } });
    await c.next('history');
    const d = await client();
    d.send({ type: 'open_session', sessionId: sid, after: { epoch: done.pos!.epoch, seq: done.pos!.seq } });
    await d.next('history');
    expect([...c.got, ...d.got].some((m) => m.type === 'catchup')).toBe(false);
    c.close();
    d.close();
    a.close();
  });

  it('an idle session on a socket that has viewed it all along: nothing new, nothing read again', async () => {
    const sid = 'c0c0c0c0-0000-4000-8000-000000000005';
    const cwd = await seed(sid, 'idle');
    const a = await client();
    a.send({ type: 'send', sessionId: sid, cwd, text: 'one' });
    const done = await a.next('turn_result');
    await new Promise((r) => setTimeout(r, 50));
    a.send({ type: 'open_session', sessionId: sid, after: { epoch: done.pos!.epoch, seq: done.pos!.seq } });
    expect(await a.next('catchup')).toMatchObject({ sessionId: sid, runningTurnId: null, pos: done.pos });
    const after = await a.quiet();
    expect(after.filter((m) => m.type === 'history' || stamped(m))).toEqual([]);
    // Behind the stream with nothing kept: the history.
    a.send({ type: 'open_session', sessionId: sid, after: { epoch: done.pos!.epoch, seq: done.pos!.seq - 1 } });
    await a.next('history');
    a.close();
  });

  it('events that fell out of what the server keeps are never skipped: the full history instead', async () => {
    const sid = 'c0c0c0c0-0000-4000-8000-000000000006';
    const cwd = await seed(sid, 'short');
    hold();
    const a = await client(short);
    a.send({ type: 'send', sessionId: sid, cwd, text: 'slow' });
    await a.next('delta', (m) => m.text === 'b');
    const ev = a.events(sid);
    expect(ev.length).toBeGreaterThanOrEqual(3);
    const last = ev[ev.length - 1]!.pos;

    const b = await client(short);
    b.send({ type: 'open_session', sessionId: sid, after: { epoch: last.epoch, seq: ev[0]!.pos.seq - 1 } });
    await b.next('history');
    expect(b.got.some((m) => m.type === 'catchup')).toBe(false);
    // Within what is kept: caught up.
    b.send({ type: 'open_session', sessionId: sid, after: { epoch: last.epoch, seq: last.seq - 1 } });
    await b.next('catchup');
    // The tail follows the header in frames of its own: wait for it rather than assume it came in the same read.
    await b.next('delta', (m) => m.pos?.seq === last.seq);
    expect(b.events(sid).map((m) => m.pos.seq)).toEqual([last.seq]);
    release();
    await a.next('turn_result');
    a.close();
    b.close();
  });

  it('a server that drops unknown fields (an older one) answers open_session.after with the history', async () => {
    const sid = 'c0c0c0c0-0000-4000-8000-000000000007';
    await seed(sid, 'old');
    const c = await client();
    c.send({ type: 'open_session', sessionId: sid, after: { epoch: 'e', seq: 3 } });
    await c.next('history');
    c.close();
  });
});

describe('what the server keeps of a stream', () => {
  it('is bounded in bytes (not characters), and an event larger than the bound is still kept whole — never a partial tail', async () => {
    const sid = 'c0c0c0c0-0000-4000-8000-000000000008';
    const cwd = await seed(sid, 'bytes');
    hold();
    const a = await client(scripted);
    a.send({ type: 'send', sessionId: sid, cwd, text: 'big' });
    const big = await a.next('delta', (m) => m.text === BIG);
    const pos = big.pos!;
    expect(JSON.stringify(big).length).toBeLessThan(4000);
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(4000);

    // The large event pushed the earlier ones out: from before them, the history.
    const b = await client(scripted);
    b.send({ type: 'open_session', sessionId: sid, after: { epoch: pos.epoch, seq: pos.seq - 2 } });
    await b.next('history');
    expect(b.got.some((m) => m.type === 'catchup')).toBe(false);
    // The large one itself is there, whole — also well after the idle time, since its turn is still running.
    await new Promise((r) => setTimeout(r, 250));
    b.send({ type: 'open_session', sessionId: sid, after: { epoch: pos.epoch, seq: pos.seq - 1 } });
    await b.next('catchup');
    expect((await b.next('delta')).text).toBe(BIG);
    release();
    await a.next('turn_result');
    a.close();
    b.close();
  });

  it('is dropped once a process has sat idle after its turn: a device behind gets the history, one at the head still nothing', async () => {
    const sid = 'c0c0c0c0-0000-4000-8000-000000000009';
    const cwd = await seed(sid, 'park');
    hold();
    const a = await client(scripted);
    a.send({ type: 'send', sessionId: sid, cwd, text: 'park' });
    const done = (await a.next('turn_result')).pos!;
    // Right away the tail is there.
    const b = await client(scripted);
    b.send({ type: 'open_session', sessionId: sid, after: { epoch: done.epoch, seq: done.seq - 1 } });
    await b.next('catchup');
    expect((await b.next('turn_result')).pos).toEqual(done);
    await new Promise((r) => setTimeout(r, 250));
    b.send({ type: 'open_session', sessionId: sid, after: { epoch: done.epoch, seq: done.seq - 1 } });
    await b.next('history');
    b.send({ type: 'open_session', sessionId: sid, after: { epoch: done.epoch, seq: done.seq } });
    expect(await b.next('catchup')).toMatchObject({ sessionId: sid, pos: done });
    release();
    a.close();
    b.close();
  });
});

describe('a run that rejects because it was interrupted', () => {
  it('ends as a stop (중단됨), not as the SDK error text', async () => {
    const sid = 'c0c0c0c0-0000-4000-8000-00000000000a';
    const cwd = await seed(sid, 'abort');
    const a = await client(scripted);
    a.send({ type: 'send', sessionId: sid, cwd, text: 'abort' });
    const started = await a.next('turn_started');
    a.send({ type: 'interrupt', turnId: started.turnId });
    expect(await a.next('turn_result')).toMatchObject({ ok: false, errorText: '중단됨' });
    a.close();
  });
});
