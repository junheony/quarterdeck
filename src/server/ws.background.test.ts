import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '../shared/protocol';
import { cookieValueFor } from './auth';
import { ClaudeEngine, type QueryFn } from './engine/ClaudeEngine';
import { fakeSdk, sdk } from './engine/fakeSdk';
import { createRequestHandler } from './http';
import { AcceptedRefs } from './sessions/AcceptedRefs';
import { PinStore } from './sessions/PinStore';
import { SessionIndex } from './sessions/SessionIndex';
import { SettingsStore } from './settings';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { DRAINING_MESSAGE, attachWebSocket } from './ws';
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
/** Each test installs its own fake CLI process. */
let fake = fakeSdk();
const queryFn: QueryFn = (p) => fake.queryFn(p);

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wsbg-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wsbg-work-')));
  index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json') });
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
  wsApi = attachWebSocket([server], { accounts: testRegistry(), token: TOKEN, devOrigins: [], runner, index, usage, store, codexAvailable: false, cwdRoots: [path.dirname(work)], pins, settings, acceptedRefs: new AcceptedRefs(null) });
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

describe('ws: sessions held open for background work', () => {
  it('a send while waiting becomes a follow-up of the same process; the continuation streams as 백그라운드 계속', async () => {
    const S = '33333333-3333-4333-8333-333333333333';
    const cwd = await seed(S, 'bg1');
    fake = fakeSdk();
    const a = await client();
    await a.next('hello');
    a.send({ type: 'send', sessionId: S, cwd, text: 'go' });
    const base1 = await a.next('turn_started');
    fake.push(sdk.init(S), sdk.bgLevel([{ id: 'x', desc: 'explore' }]), sdk.result('launched', S));
    expect(await a.next('turn_background')).toMatchObject({ turnId: base1.turnId, tasks: ['explore'] });
    await a.next('turn_result', (m) => m.turnId === base1.turnId);

    // A second tab opening the session sees the pending work, but no running turn.
    const b = await client();
    await b.next('hello');
    b.send({ type: 'open_session', sessionId: S });
    expect(await b.next('history')).toMatchObject({ runningTurnId: null });
    expect(await b.next('turn_background')).toMatchObject({ tasks: ['explore'] });

    b.send({ type: 'send', sessionId: S, cwd, text: 'status?', clientRef: 'ref-1' });
    const fu = await b.next('turn_started', (m) => m.clientRef === 'ref-1');
    expect(fu.turnId).not.toBe(base1.turnId);
    expect(fu.reason).toBe('백그라운드 대기 중 이어 보냄');
    fake.push(sdk.delta('still going'), sdk.result('still going', S));
    expect(await a.next('turn_result', (m) => m.turnId === fu.turnId)).toMatchObject({ ok: true, text: 'still going' });
    expect(fake.state.calls).toBe(1);

    fake.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('found'), sdk.result('found', S));
    await a.next('turn_background', (m) => m.tasks.length === 0);
    const cont = await a.next('turn_started', (m) => m.reason === '백그라운드 계속');
    expect(await a.next('turn_result', (m) => m.turnId === cont.turnId)).toMatchObject({ ok: true, text: 'found' });

    // The process ended → the session is free again: a new send starts a new process.
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    fake = fakeSdk();
    fake.push(sdk.init(S), sdk.result('fresh', S));
    a.send({ type: 'send', sessionId: S, cwd, text: 'again' });
    expect(await a.next('turn_result', (m) => m.text === 'fresh')).toMatchObject({ ok: true });
    a.close();
    b.close();
  });

  it('steer: refused with no running turn; into a running turn it reaches every viewer as steer_delivered with its prompt', async () => {
    const S = '55555555-5555-4555-8555-555555555555';
    const cwd = await seed(S, 'steer1');
    fake = fakeSdk();
    const a = await client();
    await a.next('hello');
    a.send({ type: 'steer', turnId: 'no-such-turn', steerId: 'k0', text: 'x' });
    expect(await a.next('steer_rejected')).toMatchObject({ steerId: 'k0', turnId: 'no-such-turn' });
    a.send({ type: 'steer', turnId: 'no-such-turn', steerId: 'k0', text: '' });
    expect((await a.next('error')).message).toContain('형식 오류');

    a.send({ type: 'send', sessionId: S, cwd, text: 'go' });
    const t = await a.next('turn_started');
    const b = await client();
    await b.next('hello');
    b.send({ type: 'open_session', sessionId: S });
    await b.next('history');
    fake.push(sdk.init(S));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    a.send({ type: 'steer', turnId: t.turnId, steerId: 'k1', text: 'also this' });
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(2));
    const steer = fake.inputs[1]!;
    expect(steer.priority).toBe('next');
    fake.push({ type: 'user', isReplay: true, uuid: steer.uuid, parent_tool_use_id: null, message: steer.message, session_id: S });
    const want = { type: 'steer_delivered', turnId: t.turnId, sessionId: S, steerId: 'k1', prompt: { text: 'also this', attachments: [] } };
    expect(await a.next('steer_delivered')).toMatchObject(want);
    expect(await b.next('steer_delivered')).toMatchObject(want);
    // A device opening the session mid-turn gets it again after history (marked replay).
    const c = await client();
    await c.next('hello');
    c.send({ type: 'open_session', sessionId: S });
    await c.next('history');
    expect(await c.next('steer_delivered')).toMatchObject({ ...want, replay: true });
    c.close();
    // A repeated steerId is refused as already in (D) and never reaches the process again.
    a.send({ type: 'steer', turnId: t.turnId, steerId: 'k1', text: 'also this' });
    expect(await a.next('steer_rejected', (m) => m.steerId === 'k1')).toMatchObject({ code: 'already_accepted' });
    fake.push({ ...sdk.result('done', S), user_message_uuids: [fake.inputs[0]!.uuid, steer.uuid] });
    await a.next('turn_result', (m) => m.turnId === t.turnId);
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    expect(a.got.filter((m) => m.type === 'turn_result')).toHaveLength(1);
    expect(a.got.filter((m) => m.type === 'steer_rejected' && m.steerId === 'k1')).toHaveLength(1);
    expect(fake.inputs).toHaveLength(2);
    a.close();
    b.close();
  });

  it('A: a steer handed to the process but never delivered is pending, not accepted — after the process dies it is in neither list', async () => {
    const S = '66666666-6666-4666-8666-666666666666';
    const cwd = await seed(S, 'steer2');
    fake = fakeSdk();
    const a = await client();
    await a.next('hello');
    a.send({ type: 'send', sessionId: S, cwd, text: 'go', clientRef: 'g1' });
    const t = await a.next('turn_started');
    fake.push(sdk.init(S));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    a.send({ type: 'steer', turnId: t.turnId, steerId: 'k2', text: 'late' });
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(2));
    const b = await client();
    await b.next('hello');
    b.send({ type: 'open_session', sessionId: S });
    const h = await b.next('history');
    expect(h).toMatchObject({ acceptedRefs: ['g1'] });
    expect(h.pendingRefs).toEqual(['k2']);
    // While pending, a resend of the steer is refused too, as in_flight: it may still go in — or fail, so the device keeps it.
    b.send({ type: 'steer', turnId: t.turnId, steerId: 'k2', text: 'late' });
    expect(await b.next('steer_rejected', (m) => m.steerId === 'k2')).toMatchObject({ code: 'in_flight', message: '아직 처리 중인 메시지 — 멈춰 둠' });
    b.close();
    fake.end();
    await a.next('turn_result', (m) => m.turnId === t.turnId);
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    a.close();
    const c = await client();
    await c.next('hello');
    c.send({ type: 'open_session', sessionId: S });
    const h2 = await c.next('history');
    expect(h2.acceptedRefs).toEqual(['g1']);
    expect(h2.pendingRefs).toEqual([]);
    c.close();
  });

  it('a steer the runner rejects (retry, process gone) is no longer pending; an error carrying a clientRef takes back its accepted ref', async () => {
    const S = '67676767-6767-4767-8767-676767676767';
    const cwd = await seed(S, 'steer3');
    fake = fakeSdk();
    let sink: Parameters<TurnRunner['run']>[1] | null = null;
    const run = runner.run.bind(runner);
    const spy = vi.spyOn(runner, 'run').mockImplementation((p, s) => { sink = s; return run(p, s); });
    const a = await client();
    await a.next('hello');
    a.send({ type: 'send', sessionId: S, cwd, text: 'go', clientRef: 'g3' });
    const t = await a.next('turn_started');
    spy.mockRestore();
    fake.push(sdk.init(S));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    a.send({ type: 'steer', turnId: t.turnId, steerId: 'k3', text: 'late' });
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(2));
    // What the runner sends for a steer a retry dropped, and for a follow-up it could not write after its turn_started.
    sink!.emit({ type: 'steer_rejected', turnId: t.turnId, sessionId: S, cwd, steerId: 'k3', message: '재시도 중이라 턴이 끝난 뒤 보냅니다' });
    sink!.emit({ type: 'error', turnId: t.turnId, message: '메시지를 보내지 못했습니다', clientRef: 'g3' });
    a.send({ type: 'open_session', sessionId: S });
    const h = await a.next('history');
    expect(h.pendingRefs).toEqual([]);
    expect(h.acceptedRefs).toEqual([]);
    fake.end();
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    a.close();
  });

  it('D: a send whose clientRef the session already accepted is refused with already_accepted and never runs again; a follow-up is recorded at its turn_started', async () => {
    const S = '77777777-7777-4777-8777-777777777777';
    const cwd = await seed(S, 'dedupe');
    fake = fakeSdk();
    let sink: Parameters<TurnRunner['run']>[1] | null = null;
    const run = runner.run.bind(runner);
    const spy = vi.spyOn(runner, 'run').mockImplementation((p, s) => { sink = s; return run(p, s); });
    const a = await client();
    await a.next('hello');
    a.send({ type: 'send', sessionId: S, cwd, text: 'go', clientRef: 'd1' });
    const t = await a.next('turn_started');
    spy.mockRestore();
    fake.push(sdk.init(S), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', S));
    await a.next('turn_result', (m) => m.turnId === t.turnId);
    a.send({ type: 'send', sessionId: S, cwd, text: 'go', clientRef: 'd1' });
    expect(await a.next('error', (m) => m.clientRef === 'd1')).toMatchObject({ turnId: null, code: 'already_accepted' });
    a.send({ type: 'send', sessionId: S, cwd, text: 'more', clientRef: 'd2' });
    const fu = await a.next('turn_started', (m) => m.clientRef === 'd2');
    a.send({ type: 'send', sessionId: S, cwd, text: 'more', clientRef: 'd2' });
    expect(await a.next('error', (m) => m.clientRef === 'd2')).toMatchObject({ code: 'already_accepted' });
    a.send({ type: 'open_session', sessionId: S });
    expect((await a.next('history')).acceptedRefs).toEqual(['d1', 'd2']);
    expect(fake.inputs).toHaveLength(2);
    // The follow-up's write failing after its turn_started: the ref is taken back, and no second (app-wide) error goes out —
    // its failed turn_result is the one place the user sees it.
    sink!.emit({ type: 'error', turnId: fu.turnId, message: '메시지를 보내지 못했습니다', clientRef: 'd2' });
    a.send({ type: 'open_session', sessionId: S });
    expect((await a.next('history')).acceptedRefs).toEqual(['d1']);
    expect(a.got.some((m) => m.type === 'error' && m.message === '메시지를 보내지 못했습니다')).toBe(false);
    a.send({ type: 'interrupt', turnId: t.turnId });
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    a.close();
  });
  it('interrupting a follow-up stops the whole process; drain refuses new sends and counts held turns', async () => {
    const S = '44444444-4444-4444-8444-444444444444';
    const cwd = await seed(S, 'bg2');
    fake = fakeSdk();
    const a = await client();
    await a.next('hello');
    a.send({ type: 'send', sessionId: S, cwd, text: 'go' });
    const t = await a.next('turn_started');
    fake.push(sdk.init(S), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', S));
    await a.next('turn_background');
    await a.next('turn_result', (m) => m.turnId === t.turnId);
    expect(wsApi.activeTurns()).toBe(1);

    a.send({ type: 'send', sessionId: S, cwd, text: 'next', clientRef: 'r2' });
    const fu = await a.next('turn_started', (m) => m.clientRef === 'r2');
    wsApi.drain();
    expect(await a.next('error', (m) => m.message === DRAINING_MESSAGE)).toMatchObject({ turnId: null, code: 'draining' });
    a.send({ type: 'send', sessionId: null, cwd, text: 'new', clientRef: 'r3' });
    expect(await a.next('error', (m) => m.clientRef === 'r3')).toMatchObject({ message: DRAINING_MESSAGE, code: 'draining' });
    // A steer refused while draining says why, so the device sends it again after the restart.
    a.send({ type: 'steer', turnId: fu.turnId, steerId: 'k9', text: 'more' });
    expect(await a.next('steer_rejected', (m) => m.steerId === 'k9')).toMatchObject({ message: DRAINING_MESSAGE, code: 'draining' });

    a.send({ type: 'interrupt', turnId: fu.turnId });
    expect(await a.next('turn_background', (m) => m.tasks.length === 0)).toMatchObject({ turnId: fu.turnId });
    expect(await a.next('turn_result', (m) => m.turnId === fu.turnId)).toMatchObject({ ok: false, errorText: '중단됨' });
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    a.close();
  });

});
