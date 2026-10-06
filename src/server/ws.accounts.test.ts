import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { buildRegistry, type AccountRegistry } from '../shared/accounts';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { cookieValueFor } from './auth';
import { StubEngine, okResult } from './engine/StubEngine';
import { createRequestHandler } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket } from './ws';
import { testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'a'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
const SID = '21212121-2121-4212-8212-212121212121';
let base: string;
let work: string;
let store: SessionStateStore;
let engineAccounts: string[] = [];
const servers: http.Server[] = [];
const apis: ReturnType<typeof attachWebSocket>[] = [];
/** A server with the four-account registry (`reg`) and one without any (the a/b/c defaults). */
let withReg = '';
let legacy = '';

beforeAll(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-ws-accounts-')));
  work = path.join(base, 'work');
  await fs.mkdir(work);
  // Profile dirs under the temp dir only: a = <base>/.claude, the others <base>/.claude-<id>.
  const reg = buildRegistry({ version: 1, accounts: [{ id: 'a' }, { id: 'b', label: 'Work' }, { id: 'old', retired: true }, { id: 'd' }] }, { homeDir: base });
  const start = async (accounts: AccountRegistry, name: string, seed: boolean): Promise<string> => {
    const roots = accounts.projectsRoots();
    for (const r of roots) await fs.mkdir(r.dir, { recursive: true });
    const index = new SessionIndex({ roots, pinnedFile: path.join(base, `${name}-p.json`) });
    await index.refresh();
    const usage = new UsageService({ deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }), accounts });
    const st = new SessionStateStore(path.join(base, `${name}-state.json`));
    await st.load();
    if (seed) {
      store = st;
      await st.set({ sessionId: SID, cwd: work, account: 'b', projectDir: path.join(accounts.projectsDir('b'), 'p'), lastTurnAtMs: Date.now(), justCompacted: false, defaultModel: 'opus' });
    }
    const engine = new StubEngine(async (req) => { engineAccounts.push(req.account); return [{ kind: 'init', sessionId: 'sess-new', model: 'm' }, okResult('sess-new', 'ok')]; });
    const runner = new TurnRunner({ attachments: null, engine, usage, index, store: st, cooldownDir: path.join(base, `${name}-cd`), protectedAccount: null, auditFile: path.join(base, `${name}-audit.log`), projectsRoots: roots, codex: null, codexSessionsRoot: path.join(base, 'codex-sessions'), accounts });
    const server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
    apis.push(attachWebSocket([server], { token: TOKEN, devOrigins: [], runner, index, usage, store: st, codexAvailable: false, cwdRoots: [base], accounts }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  withReg = await start(reg, 'reg', true);
  legacy = await start(testRegistry(path.join(base, 'legacy')), 'legacy', false);
});
afterAll(async () => { for (const a of apis) a.close(); for (const s of servers) s.close(); await fs.rm(base, { recursive: true, force: true }); });

/** A socket buffering every message from connection time. */
async function client(host: string) {
  const ws = new WebSocket(`ws://${host}/ws`, { headers: { Origin: `http://${host}`, Cookie: COOKIE } });
  const got: ServerMessage[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d)) as ServerMessage));
  await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j); });
  const until = async <T extends ServerMessage>(pred: (m: ServerMessage) => boolean, ms = 3000): Promise<T> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = got.find(pred);
      if (hit) return hit as T;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout; got ${JSON.stringify(got)}`);
  };
  const say = (m: ClientMessage | Record<string, unknown>) => ws.send(JSON.stringify(m));
  return { ws, got, until, say };
}
type Err = Extract<ServerMessage, { type: 'error' }>;
type Hello = Extract<ServerMessage, { type: 'hello' }>;

describe('ws: accounts from the registry', () => {
  it('hello names the feature and lists every configured account in order, retired included', async () => {
    const c = await client(withReg);
    const hello = await c.until<Hello>((m) => m.type === 'hello');
    expect(hello.features).toContain('accounts');
    expect(hello.accounts).toEqual([
      { id: 'a', label: 'A', home: true, retired: false },
      { id: 'b', label: 'Work', home: false, retired: false },
      { id: 'old', label: 'OLD', home: false, retired: true },
      { id: 'd', label: 'D', home: false, retired: false },
    ]);
    c.ws.close();
  });

  it('a server with the a/b/c registry lists a/b/c with a as home', async () => {
    const c = await client(legacy);
    const hello = await c.until<Hello>((m) => m.type === 'hello');
    expect(hello.accounts?.map((a) => [a.id, a.label, a.home, a.retired])).toEqual([['a', 'A', true, false], ['b', 'B', false, false], ['c', 'C', false, false]]);
    c.ws.close();
  });

  it('send.accountPin: an id that is not configured or is retired is refused before any turn starts, saying which and what can be used', async () => {
    const c = await client(withReg);
    await c.until((m) => m.type === 'hello');
    engineAccounts = [];
    c.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', accountPin: 'zz', clientRef: 'r-unknown' });
    const unknown = await c.until<Err>((m) => m.type === 'error' && m.clientRef === 'r-unknown');
    expect(unknown.message).toBe('설정에 없는 계정이라 고정할 수 없습니다: zz (쓸 수 있는 계정: A(a), Work(b), D(d))');
    expect(unknown.turnId).toBeNull();
    c.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', accountPin: 'old', clientRef: 'r-retired' });
    const retired = await c.until<Err>((m) => m.type === 'error' && m.clientRef === 'r-retired');
    expect(retired.message).toBe('설정에서 뺀(retired) 계정이라 고정할 수 없습니다: OLD(old) (쓸 수 있는 계정: A(a), Work(b), D(d))');
    // c is an account of the default three, not of this server.
    c.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', accountPin: 'c', clientRef: 'r-c' });
    expect((await c.until<Err>((m) => m.type === 'error' && m.clientRef === 'r-c')).message).toContain('설정에 없는 계정');
    expect(c.got.some((m) => m.type === 'turn_started')).toBe(false);
    expect(engineAccounts).toEqual([]);
    c.ws.close();
  });

  it('send.accountPin: a fourth account runs the turn on it; a malformed id is a schema error and the socket stays open', async () => {
    const c = await client(withReg);
    await c.until((m) => m.type === 'hello');
    c.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', accountPin: 'Bad Id', clientRef: 'r-shape' });
    expect((await c.until<Err>((m) => m.type === 'error' && m.clientRef === 'r-shape')).message).not.toContain('설정에 없는');
    engineAccounts = [];
    c.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', accountPin: 'd', clientRef: 'r-d' });
    await c.until((m) => m.type === 'turn_result');
    expect(engineAccounts).toEqual(['d']);
    c.ws.close();
  });

  it('set_account_pin: unknown and retired ids are refused with the session id and nothing is stored; a fourth account is stored and broadcast', async () => {
    const c = await client(withReg);
    await c.until((m) => m.type === 'hello');
    c.say({ type: 'set_account_pin', sessionId: SID, pin: 'zz' });
    const unknown = await c.until<Err>((m) => m.type === 'error' && m.message.includes('zz'));
    expect(unknown).toMatchObject({ sessionId: SID, turnId: null, message: '설정에 없는 계정이라 고정할 수 없습니다: zz (쓸 수 있는 계정: A(a), Work(b), D(d))' });
    c.say({ type: 'set_account_pin', sessionId: SID, pin: 'old' });
    const retired = await c.until<Err>((m) => m.type === 'error' && m.message.includes('old'));
    expect(retired).toMatchObject({ sessionId: SID, message: '설정에서 뺀(retired) 계정이라 고정할 수 없습니다: OLD(old) (쓸 수 있는 계정: A(a), Work(b), D(d))' });
    expect(store.get(SID)).not.toHaveProperty('accountPin');
    expect(c.got.some((m) => m.type === 'account_pin' && m.pin !== null)).toBe(false);
    c.say({ type: 'set_account_pin', sessionId: SID, pin: 'd' });
    expect(await c.until((m) => m.type === 'account_pin' && m.pin !== null)).toEqual({ type: 'account_pin', sessionId: SID, pin: 'd' });
    expect(store.get(SID)).toMatchObject({ accountPin: 'd' });
    c.say({ type: 'set_account_pin', sessionId: SID, pin: null });
    await c.until((m) => m.type === 'account_pin' && m.pin === null);
    c.ws.close();
  });

  it('the default a/b/c server: an old UI\'s pins still pass; a fourth id is refused', async () => {
    const c = await client(legacy);
    await c.until((m) => m.type === 'hello');
    engineAccounts = [];
    c.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', accountPin: 'c' });
    await c.until((m) => m.type === 'turn_result');
    expect(engineAccounts).toEqual(['c']);
    c.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', accountPin: 'd', clientRef: 'r-d' });
    expect((await c.until<Err>((m) => m.type === 'error' && m.clientRef === 'r-d')).message).toBe('설정에 없는 계정이라 고정할 수 없습니다: d (쓸 수 있는 계정: A(a), B(b), C(c))');
    c.ws.close();
  });
});

describe('ws: pins that stopped being usable', () => {
  const PARENT = '31313131-3131-4313-8313-313131313131';
  type Pin = Extract<ServerMessage, { type: 'account_pin' }>;
  type Result = Extract<ServerMessage, { type: 'turn_result' }>;
  /** A session of account b whose stored pin is the retired account, with a two-message transcript. */
  const seedParent = async () => {
    const dir = path.join(base, '.claude-b', 'projects', 'p');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${PARENT}.jsonl`), [
      { type: 'user', uuid: 'u0', parentUuid: null, cwd: work, message: { role: 'user', content: 'seed' } },
      { type: 'assistant', uuid: 'a0', parentUuid: 'u0', message: { id: 'm0', role: 'assistant', content: [{ type: 'text', text: '답 0' }] } },
      { type: 'user', uuid: 'u1', parentUuid: 'a0', message: { role: 'user', content: '두 번째' } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    await store.set({ sessionId: PARENT, cwd: work, account: 'b', projectDir: dir, lastTurnAtMs: Date.now(), justCompacted: false, defaultModel: 'opus', accountPin: 'old' });
  };

  it('an edit branch and a handoff carrying the parent\'s retired pin are not refused: the turn runs and the pin is ignored', async () => {
    await seedParent();
    const c = await client(withReg);
    await c.until((m) => m.type === 'hello');
    for (const [ref, extra] of [['r-branch0', { branch: { from: PARENT, n: 0, expect: 'seed' } }], ['r-branch1', { branch: { from: PARENT, n: 1, expect: '두 번째' } }], ['r-handoff', { handoffFrom: PARENT }], ['r-unknown-pin', { handoffFrom: PARENT, accountPin: 'zz' }]] as const) {
      engineAccounts = [];
      c.got.length = 0;
      c.say({ type: 'send', sessionId: null, cwd: work, text: 'edited', accountPin: 'old', clientRef: ref, ...extra });
      const done = await c.until<Result>((m) => m.type === 'turn_result');
      expect(done.ok, ref).toBe(true);
      expect(c.got.filter((m) => m.type === 'error'), ref).toEqual([]);
      expect(engineAccounts, ref).toHaveLength(1);
      expect(['a', 'b', 'd'], ref).toContain(engineAccounts[0]);
    }
    c.ws.close();
  });

  it('the same pin picked for a plain new session is refused', async () => {
    const c = await client(withReg);
    await c.until((m) => m.type === 'hello');
    engineAccounts = [];
    c.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', accountPin: 'old', clientRef: 'r-new' });
    expect((await c.until<Err>((m) => m.type === 'error' && m.clientRef === 'r-new')).message).toContain('설정에서 뺀(retired) 계정이라 고정할 수 없습니다: OLD(old)');
    expect(c.got.some((m) => m.type === 'turn_started')).toBe(false);
    expect(engineAccounts).toEqual([]);
    c.ws.close();
  });

  it('a send into an existing session ignores an accountPin that is not configured (the session keeps its own)', async () => {
    const c = await client(withReg);
    await c.until((m) => m.type === 'hello');
    engineAccounts = [];
    c.say({ type: 'send', sessionId: SID, cwd: work, text: 'more', accountPin: 'zz', clientRef: 'r-existing' });
    const done = await c.until<Result>((m) => m.type === 'turn_result');
    expect(done.ok).toBe(true);
    expect(c.got.filter((m) => m.type === 'error')).toEqual([]);
    expect(engineAccounts).toHaveLength(1);
    expect(store.get(SID)).not.toHaveProperty('accountPin');
    c.ws.close();
  });

  it('set_account_pin refused: the sender gets the stored pin back (null when none), so its picker returns to it', async () => {
    const c = await client(withReg);
    await c.until((m) => m.type === 'hello');
    c.say({ type: 'set_account_pin', sessionId: SID, pin: 'zz' });
    await c.until((m) => m.type === 'error' && m.message.includes('zz'));
    expect(await c.until<Pin>((m) => m.type === 'account_pin')).toEqual({ type: 'account_pin', sessionId: SID, pin: null });
    c.say({ type: 'set_account_pin', sessionId: SID, pin: 'd' });
    await c.until((m) => m.type === 'account_pin' && m.pin === 'd');
    c.got.length = 0;
    c.say({ type: 'set_account_pin', sessionId: SID, pin: 'old' });
    await c.until((m) => m.type === 'error' && m.message.includes('old'));
    expect(await c.until<Pin>((m) => m.type === 'account_pin')).toEqual({ type: 'account_pin', sessionId: SID, pin: 'd' });
    expect(store.get(SID)).toMatchObject({ accountPin: 'd' });
    c.say({ type: 'set_account_pin', sessionId: SID, pin: null });
    await c.until((m) => m.type === 'account_pin' && m.pin === null);
    c.ws.close();
  });
});

describe('ws: a handoffFrom that names no session does not lift the pin check', () => {
  type Result = Extract<ServerMessage, { type: 'turn_result' }>;

  it('a made-up handoffFrom with a retired or unknown pin is refused; one naming a known session still runs', async () => {
    const c = await client(withReg);
    await c.until((m) => m.type === 'hello');
    engineAccounts = [];
    for (const [ref, handoffFrom, accountPin, want] of [
      ['r-fake', 'x', 'old', '설정에서 뺀(retired) 계정이라 고정할 수 없습니다: OLD(old)'],
      ['r-fake-uuid', '41414141-4141-4414-8414-414141414141', 'old', '설정에서 뺀(retired) 계정이라 고정할 수 없습니다: OLD(old)'],
      ['r-fake-path', '../x', 'zz', '설정에 없는 계정이라 고정할 수 없습니다: zz'],
    ] as const) {
      c.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', accountPin, handoffFrom, clientRef: ref });
      expect((await c.until<Err>((m) => m.type === 'error' && m.clientRef === ref)).message, ref).toContain(want);
    }
    expect(c.got.some((m) => m.type === 'turn_started')).toBe(false);
    expect(engineAccounts).toEqual([]);
    // SID is a session deck has state for: a real handoff, so the pin is ignored as before.
    c.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', accountPin: 'old', handoffFrom: SID, clientRef: 'r-real' });
    expect((await c.until<Result>((m) => m.type === 'turn_result')).ok).toBe(true);
    expect(c.got.filter((m) => m.type === 'error' && m.clientRef === 'r-real')).toEqual([]);
    expect(engineAccounts).toHaveLength(1);
    expect(['a', 'b', 'd']).toContain(engineAccounts[0]);
    c.ws.close();
  });
});
