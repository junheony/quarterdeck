import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '../shared/protocol';
import type { SessionHolder } from '../shared/session-types';
import { cookieValueFor } from './auth';
import { ClaudeEngine, type QueryFn } from './engine/ClaudeEngine';
import { fakeSdk, sdk } from './engine/fakeSdk';
import { createRequestHandler } from './http';
import { AcceptedRefs } from './sessions/AcceptedRefs';
import { PinStore } from './sessions/PinStore';
import { SessionIndex } from './sessions/SessionIndex';
import { SettingsStore } from './settings';
import { SessionStateStore } from './turn/SessionState';
import { SHUTDOWN_ABORTED, TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket, recycleNotice } from './ws';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'e'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
let server: http.Server;
let origin = '';
let wsUrl = '';
let wsApi: ReturnType<typeof attachWebSocket>;
let base: string;
let work: string;
let store: SessionStateStore;
let index: SessionIndex;
let runner: TurnRunner;
/** Stands in for the process scan: who holds which session, and whether that changed since the last refresh. */
const held = new Map<string, SessionHolder>();
let heldChanged = false;
/** Each test installs its own fake CLI process. */
let fake = fakeSdk();
const queryFn: QueryFn = (p) => fake.queryFn(p);

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wsout-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wsout-work-')));
  index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json'), holders: { heldBy: (id) => held.get(id) ?? null } });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }) });
  store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  runner = new TurnRunner({ accounts: testRegistry(), attachments: null, engine: new ClaudeEngine({ accounts: testRegistry(), queryFn, readFile: async () => Buffer.from('') }), usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots), codex: null, codexSessionsRoot: path.join(base, 'codex') });
  const pins = new PinStore(path.join(base, 'pins.json'));
  await pins.load();
  const settings = new SettingsStore(path.join(base, 'settings.json'));
  await settings.load();
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  wsApi = attachWebSocket([server], { accounts: testRegistry(), token: TOKEN, devOrigins: [], runner, index, usage, store, codexAvailable: false, cwdRoots: [path.dirname(work)], pins, settings, acceptedRefs: new AcceptedRefs(null), holders: { refresh: async () => { const changed = heldChanged; heldChanged = false; return changed; } }, outsidePollMs: 40 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  origin = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});
afterAll(async () => { wsApi.close(); server.close(); await fs.rm(base, { recursive: true, force: true }); await fs.rm(work, { recursive: true, force: true }); });

/** A socket that buffers everything from connection time; `next(pred)` waits for the next matching message. */
async function client() {
  const ws = new WebSocket(wsUrl, { headers: { Origin: origin, Cookie: COOKIE } });
  const got: ServerMessage[] = [];
  let read = 0;
  let wake: (() => void) | null = null;
  ws.on('message', (d) => { got.push(JSON.parse(String(d)) as ServerMessage); wake?.(); });
  await new Promise<void>((r) => ws.once('open', () => r()));
  return {
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
  };
}

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

/** One transcript line as the CLI writes it; `entrypoint` says which kind of process wrote it. */
const line = (entrypoint: string, text: string, type: 'user' | 'assistant' = 'user') => JSON.stringify({
  parentUuid: null, isSidechain: false, type, uuid: `${entrypoint}-${text}`, timestamp: new Date().toISOString(), entrypoint,
  message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] },
}) + '\n';
const fileOf = (cwd: string, sid: string) => path.join(base, 'b', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`);
const flagOf = (m: { projects: { sessions: { sessionId: string; heldBy?: SessionHolder }[] }[] }, sid: string) => m.projects.flatMap((p) => p.sessions).find((s) => s.sessionId === sid)?.heldBy;

describe('ws: sessions another Claude process holds', () => {
  it('the index says who else holds a session, and says so again when the holder goes', async () => {
    const S = '51515151-5151-4515-8515-515151515151';
    await seed(S, 'held1');
    const a = await client();
    expect(flagOf(await a.next('hello'), S)).toBeUndefined();
    held.set(S, 'desktop');
    heldChanged = true;
    expect(flagOf(await a.next('index', (m) => flagOf(m, S) !== undefined), S)).toBe('desktop');
    // A device connecting now gets it with its first message.
    const b = await client();
    expect(flagOf(await b.next('hello'), S)).toBe('desktop');
    held.delete(S);
    heldChanged = true;
    await a.next('index', (m) => flagOf(m, S) === undefined);
    a.close();
    b.close();
  });

  it('an open pane follows the other side: the history goes out again when another process wrote to the transcript, not for deck\'s own writes', async () => {
    const S = '52525252-5252-4525-8525-525252525252';
    const cwd = await seed(S, 'follow1');
    const a = await client();
    await a.next('hello');
    a.send({ type: 'open_session', sessionId: S });
    await a.next('history', (m) => m.sessionId === S);
    const seen = () => a.got.filter((m) => m.type === 'history' && m.sessionId === S).length;
    await fs.appendFile(fileOf(cwd, S), line('sdk-ts', 'from deck'));
    await new Promise((r) => setTimeout(r, 250));
    expect(seen()).toBe(1);
    await fs.appendFile(fileOf(cwd, S), line('claude-desktop', 'from desktop') + line('claude-desktop', 'desktop answer', 'assistant'));
    const again = await a.next('history', (m) => m.sessionId === S);
    expect(JSON.stringify(again.messages)).toContain('from desktop');
    expect(JSON.stringify(again.messages)).toContain('desktop answer');
    expect(again.runningTurnId).toBeNull();
    // Sent once: the poll goes on from where that read ended instead of finding the same entries at every tick.
    await new Promise((r) => setTimeout(r, 300));
    expect(seen()).toBe(2);
    a.close();
  });
});

describe('ws: outside poll, per socket', () => {
  it('a pane that closed is not sent anything, nor re-registered, by the poll — and its transcript is not read for it', async () => {
    const S = '5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a5a';
    const cwd = await seed(S, 'follow2');
    const a = await client();
    await a.next('hello');
    a.send({ type: 'open_session', sessionId: S });
    await a.next('history', (m) => m.sessionId === S);
    const reads = vi.spyOn(index, 'bestCopy');
    await fs.appendFile(fileOf(cwd, S), line('claude-desktop', 'from desktop'));
    expect(JSON.stringify((await a.next('history', (m) => m.sessionId === S)).messages)).toContain('from desktop');
    // A pane that closed is not re-registered by the poll.
    a.send({ type: 'close_session', sessionId: S });
    await new Promise((r) => setTimeout(r, 150));
    reads.mockClear();
    await fs.appendFile(fileOf(cwd, S), line('claude-desktop', 'more from desktop'));
    await new Promise((r) => setTimeout(r, 250));
    expect(a.got.filter((m) => m.type === 'history' && JSON.stringify(m.messages).includes('more from desktop'))).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    a.close();
  });

  it('a turn that starts while the poll reads the transcript keeps its pane: no history lands on top of the stream', async () => {
    const S = '5b5b5b5b-5b5b-45b5-85b5-5b5b5b5b5b5b';
    const cwd = await seed(S, 'follow3');
    fake = fakeSdk();
    const a = await client();
    await a.next('hello');
    a.send({ type: 'open_session', sessionId: S });
    await a.next('history', (m) => m.sessionId === S);
    // The poll's read is held until the send below has started its turn.
    let letGo = () => {};
    const gate = new Promise<void>((r) => { letGo = r; });
    let reading = () => {};
    const began = new Promise<void>((r) => { reading = r; });
    const real = index.bestCopy.bind(index);
    const spy = vi.spyOn(index, 'bestCopy').mockImplementation(async (...args) => { reading(); await gate; return real(...args); });
    await fs.appendFile(fileOf(cwd, S), line('claude-desktop', 'from desktop'));
    await began;
    a.send({ type: 'send', sessionId: S, cwd, text: 'go' });
    spy.mockRestore();
    const t = await a.next('turn_started');
    fake.push(sdk.init(S), sdk.delta('streaming'));
    await a.next('delta');
    letGo();
    await new Promise((r) => setTimeout(r, 200));
    const at = a.got.findIndex((m) => m.type === 'turn_started');
    expect(a.got.slice(at).filter((m) => m.type === 'history')).toEqual([]);
    fake.push(sdk.result('done', S));
    await a.next('turn_result', (m) => m.turnId === t.turnId);
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    a.close();
  });
});

describe('ws: the sidebar times stay current', () => {
  const lastOf = (m: { projects: { sessions: { sessionId: string; lastModified: number }[] }[] }, sid: string) => m.projects.flatMap((p) => p.sessions).find((s) => s.sessionId === sid)?.lastModified;

  it('the poll tick sends a fresh index when a known transcript was written outside deck (no pane open)', async () => {
    const S = '5c5c5c5c-5c5c-45c5-85c5-5c5c5c5c5c5c';
    const cwd = await seed(S, 'times1');
    const a = await client();
    const before = lastOf(await a.next('hello'), S)!;
    expect(before).toBeGreaterThan(0);
    const later = new Date(before + 120_000);
    await fs.appendFile(fileOf(cwd, S), line('cli', 'from a terminal'));
    await fs.utimes(fileOf(cwd, S), later, later);
    expect(lastOf(await a.next('index', (m) => (lastOf(m, S) ?? 0) > before), S)).toBe(later.getTime());
    a.close();
  });

  it('a turn in an existing session updates that session\'s entry right after the turn', async () => {
    const S = '5d5d5d5d-5d5d-45d5-85d5-5d5d5d5d5d5d';
    const cwd = await seed(S, 'times2');
    fake = fakeSdk();
    const a = await client();
    await a.next('hello');
    const touch = vi.spyOn(index, 'touch');
    a.send({ type: 'send', sessionId: S, cwd, text: 'go' });
    const t = await a.next('turn_started');
    fake.push(sdk.init(S), sdk.result('done', S));
    await a.next('turn_result', (m) => m.turnId === t.turnId);
    await vi.waitFor(() => expect(touch).toHaveBeenCalledWith([S]));
    touch.mockRestore();
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    a.close();
  });
});

describe('ws: a running turn\'s own writes', () => {
  const lastOf = (m: { projects: { sessions: { sessionId: string; lastModified: number }[] }[] }, sid: string) => m.projects.flatMap((p) => p.sessions).find((s) => s.sessionId === sid)?.lastModified;

  it('abortAll (server shutdown) ends a running turn with the shutdown text, not the hidden 중단됨', async () => {
    const S = '5b5b5b5b-5b5b-45b5-85b5-5b5b5b5b5b5b';
    const cwd = await seed(S, 'shutdown1');
    fake = fakeSdk();
    const a = await client();
    await a.next('hello');
    a.send({ type: 'send', sessionId: S, cwd, text: 'go' });
    const t = await a.next('turn_started');
    wsApi.abortAll();
    expect((await a.next('turn_result', (m) => m.turnId === t.turnId)).errorText).toBe(SHUTDOWN_ABORTED);
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    a.close();
  });

  it('a Claude history names the model a send without one runs on (sessionModel): the imported default for a session deck never ran', async () => {
    const S = '5f5f5f5f-5f5f-45f5-85f5-5f5f5f5f5f5f';
    await seed(S, 'model1');
    const a = await client();
    await a.next('hello');
    a.send({ type: 'open_session', sessionId: S });
    expect((await a.next('history', (m) => m.sessionId === S)).sessionModel).toBe('opus');
    a.close();
  });

  it('the poll does not broadcast for a transcript that grows only because a deck turn runs; the turn\'s end does', async () => {
    const S = '5e5e5e5e-5e5e-45e5-85e5-5e5e5e5e5e5e';
    const cwd = await seed(S, 'times3');
    fake = fakeSdk();
    const a = await client();
    const before = lastOf(await a.next('hello'), S)!;
    a.send({ type: 'send', sessionId: S, cwd, text: 'go' });
    const t = await a.next('turn_started');
    const later = new Date(before + 120_000);
    await fs.appendFile(fileOf(cwd, S), line('sdk-ts', 'streaming', 'assistant'));
    await fs.utimes(fileOf(cwd, S), later, later);
    // Several poll ticks (40 ms each) while the turn runs: no index moves this session.
    await new Promise((r) => setTimeout(r, 300));
    expect(a.got.some((m) => m.type === 'index' && (lastOf(m, S) ?? 0) > before)).toBe(false);
    fake.push(sdk.init(S), sdk.result('done', S));
    await a.next('turn_result', (m) => m.turnId === t.turnId);
    expect(lastOf(await a.next('index', (m) => (lastOf(m, S) ?? 0) > before), S)).toBeGreaterThan(before);
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    a.close();
  });
});

describe('ws: deck follows a conversation that went on outside it', () => {
  /** Starts a turn that leaves the process held open with one background task. */
  async function heldOpen(S: string, name: string) {
    const cwd = await seed(S, name);
    fake = fakeSdk();
    const a = await client();
    await a.next('hello');
    a.send({ type: 'open_session', sessionId: S });
    await a.next('history');
    a.send({ type: 'send', sessionId: S, cwd, text: 'go' });
    const first = await a.next('turn_started');
    fake.push(sdk.init(S), sdk.bgLevel([{ id: 'x', desc: 'explore' }]), sdk.result('launched', S));
    await a.next('turn_result', (m) => m.turnId === first.turnId);
    return { a, cwd };
  }

  it('a send into the held-open process after Desktop wrote: that process is ended and a new one answers, with a notice', async () => {
    const S = '53535353-5353-4535-8535-535353535353';
    const { a, cwd } = await heldOpen(S, 'recycle1');
    const old = fake;
    await fs.appendFile(fileOf(cwd, S), line('claude-desktop', 'from desktop') + line('claude-desktop', 'desktop answer', 'assistant'));
    fake = fakeSdk();
    a.send({ type: 'send', sessionId: S, cwd, text: 'and then?', clientRef: 'ref-r' });
    expect(await a.next('turn_notice', (m) => m.turnId === '')).toMatchObject({ sessionId: S, message: recycleNotice(1) });
    const next = await a.next('turn_started', (m) => m.clientRef === 'ref-r');
    expect(next.reason).not.toBe('백그라운드 대기 중 이어 보냄');
    fake.push(sdk.init(S), sdk.result('after desktop', S));
    expect(await a.next('turn_result', (m) => m.turnId === next.turnId)).toMatchObject({ ok: true, text: 'after desktop' });
    // The message went to a new process, not into the old one's input; ending the old one failed no turn.
    expect(old.state.calls).toBe(1);
    expect(old.inputs.length).toBe(1);
    expect(fake.state.calls).toBe(1);
    expect(a.got.filter((m) => m.type === 'turn_result' && !m.ok)).toEqual([]);
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    a.close();
  });

  /** The next foreign-write check answers `foreign` only after `ms`: time for a second send or a closing socket to arrive first. */
  const slowCheck = (foreign: boolean, ms = 120) => vi.spyOn(runner, 'foreignWrites').mockImplementationOnce(async () => { await new Promise((r) => setTimeout(r, ms)); return foreign; });
  const errors = (c: { got: ServerMessage[] }) => c.got.filter((m) => m.type === 'error');

  it('two sends during a recycle (two devices): both run, one after the other, neither is refused', async () => {
    const S = '56565656-5656-4565-8565-565656565656';
    const { a, cwd } = await heldOpen(S, 'recycle4');
    const b = await client();
    await b.next('hello');
    b.send({ type: 'open_session', sessionId: S });
    await b.next('history');
    const old = fake;
    fake = fakeSdk();
    const spy = slowCheck(true);
    a.send({ type: 'send', sessionId: S, cwd, text: 'one', clientRef: 'ref-1' });
    b.send({ type: 'send', sessionId: S, cwd, text: 'two', clientRef: 'ref-2' });
    await a.next('turn_notice', (m) => m.message === recycleNotice(1));
    const t1 = await a.next('turn_started', (m) => m.clientRef === 'ref-1');
    fake.push(sdk.init(S), sdk.result('answer one', S));
    expect(await a.next('turn_result', (m) => m.turnId === t1.turnId)).toMatchObject({ ok: true, text: 'answer one' });
    const t2 = await b.next('turn_started', (m) => m.clientRef === 'ref-2');
    fake.push(sdk.init(S), sdk.result('answer two', S));
    expect(await b.next('turn_result', (m) => m.turnId === t2.turnId)).toMatchObject({ ok: true, text: 'answer two' });
    expect(errors(a)).toEqual([]);
    expect(errors(b)).toEqual([]);
    expect(old.inputs.length).toBe(1);
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    spy.mockRestore();
    a.close();
    b.close();
  });

  it('a second send while the recycled session\'s new process is held open again joins it as a follow-up', async () => {
    const S = '57575757-5757-4575-8575-575757575757';
    const { a, cwd } = await heldOpen(S, 'recycle5');
    fake = fakeSdk();
    const spy = slowCheck(true);
    a.send({ type: 'send', sessionId: S, cwd, text: 'one', clientRef: 'ref-1' });
    a.send({ type: 'send', sessionId: S, cwd, text: 'two', clientRef: 'ref-2' });
    const t1 = await a.next('turn_started', (m) => m.clientRef === 'ref-1');
    fake.push(sdk.init(S), sdk.bgLevel([{ id: 'y', desc: 'again' }]), sdk.result('answer one', S));
    await a.next('turn_result', (m) => m.turnId === t1.turnId);
    // Not left waiting for that process to end (it may be held for hours): given to it as soon as it is between turns.
    const t2 = await a.next('turn_started', (m) => m.clientRef === 'ref-2');
    expect(t2.reason).toBe('백그라운드 대기 중 이어 보냄');
    fake.push(sdk.result('answer two', S));
    expect(await a.next('turn_result', (m) => m.turnId === t2.turnId)).toMatchObject({ ok: true, text: 'answer two' });
    expect(fake.state.calls).toBe(1);
    expect(errors(a)).toEqual([]);
    fake.push(sdk.bgLevel([]));
    fake.end();
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    spy.mockRestore();
    a.close();
  });

  it('a send whose socket closes during the check still goes in: into the held-open process, or as the new process\'s turn after a recycle', async () => {
    const S = '58585858-5858-4585-8585-585858585858';
    const { a, cwd } = await heldOpen(S, 'recycle6');
    const b = await client();
    await b.next('hello');
    b.send({ type: 'open_session', sessionId: S });
    await b.next('history');
    let spy = slowCheck(false);
    a.send({ type: 'send', sessionId: S, cwd, text: 'sent, then the app went to the background', clientRef: 'ref-gone' });
    await new Promise((r) => setTimeout(r, 20));
    a.close();
    const fu = await b.next('turn_started', (m) => m.clientRef === 'ref-gone');
    expect(fu.reason).toBe('백그라운드 대기 중 이어 보냄');
    expect(fake.inputs.length).toBe(2);
    fake.push(sdk.result('got it', S));
    await b.next('turn_result', (m) => m.turnId === fu.turnId);
    spy.mockRestore();

    // The same with a foreign write: the old process is ended, and the message starts the new one although its sender is gone.
    const c = await client();
    await c.next('hello');
    const old = fake;
    fake = fakeSdk();
    spy = slowCheck(true);
    c.send({ type: 'send', sessionId: S, cwd, text: 'and again', clientRef: 'ref-gone-2' });
    await new Promise((r) => setTimeout(r, 20));
    c.close();
    await b.next('turn_notice', (m) => m.message === recycleNotice(1));
    const next = await b.next('turn_started', (m) => m.clientRef === 'ref-gone-2');
    fake.push(sdk.init(S), sdk.result('after recycle', S));
    expect(await b.next('turn_result', (m) => m.turnId === next.turnId)).toMatchObject({ ok: true, text: 'after recycle' });
    expect(old.inputs.length).toBe(2);
    expect(fake.state.calls).toBe(1);
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    spy.mockRestore();
    b.close();
  });

  it('a slash command typed in Desktop is not the conversation going on: the held-open process and its background work stay', async () => {
    const S = '59595959-5959-4595-8595-595959595959';
    const { a, cwd } = await heldOpen(S, 'recycle7');
    await fs.appendFile(fileOf(cwd, S), line('claude-desktop', '<command-name>/model</command-name>') + line('claude-desktop', '<local-command-stdout>Set model to opus</local-command-stdout>'));
    a.send({ type: 'send', sessionId: S, cwd, text: 'status?', clientRef: 'ref-m' });
    expect((await a.next('turn_started', (m) => m.clientRef === 'ref-m')).reason).toBe('백그라운드 대기 중 이어 보냄');
    expect(fake.state.calls).toBe(1);
    fake.push(sdk.result('ok', S), sdk.bgLevel([]));
    fake.end();
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    a.close();
  });

  it('nothing foreign in the transcript: the send joins the held-open process as before', async () => {
    const S = '54545454-5454-4545-8545-545454545454';
    const { a, cwd } = await heldOpen(S, 'recycle2');
    await fs.appendFile(fileOf(cwd, S), line('sdk-ts', 'deck wrote this'));
    a.send({ type: 'send', sessionId: S, cwd, text: 'status?', clientRef: 'ref-k' });
    const fu = await a.next('turn_started', (m) => m.clientRef === 'ref-k');
    expect(fu.reason).toBe('백그라운드 대기 중 이어 보냄');
    fake.push(sdk.result('still going', S));
    await a.next('turn_result', (m) => m.turnId === fu.turnId);
    expect(fake.state.calls).toBe(1);
    expect(a.got.some((m) => m.type === 'turn_notice' && m.turnId === '')).toBe(false);
    fake.push(sdk.bgLevel([]));
    fake.end();
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    a.close();
  });

  it('a running turn is never cut: with a foreign write and a turn streaming, the process keeps going', async () => {
    const S = '55555555-5555-4555-8555-555555555555';
    const cwd = await seed(S, 'recycle3');
    fake = fakeSdk();
    const a = await client();
    await a.next('hello');
    a.send({ type: 'send', sessionId: S, cwd, text: 'go' });
    const first = await a.next('turn_started');
    fake.push(sdk.init(S), sdk.delta('working'));
    await a.next('delta');
    await fs.appendFile(fileOf(cwd, S), line('claude-desktop', 'from desktop'));
    a.send({ type: 'send', sessionId: S, cwd, text: 'more', clientRef: 'ref-q' });
    await new Promise((r) => setTimeout(r, 200));
    expect(a.got.some((m) => m.type === 'turn_notice' && m.turnId === '')).toBe(false);
    fake.push(sdk.result('done', S));
    expect(await a.next('turn_result', (m) => m.turnId === first.turnId)).toMatchObject({ ok: true, text: 'done' });
    fake.end();
    a.close();
  });
});
