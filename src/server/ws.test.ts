import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { HANDOFF_PROMPT } from '../shared/handoff';
import type { ServerMessage } from '../shared/protocol';
import { AttachmentStore } from './attachments/AttachmentStore';
import { cookieValueFor } from './auth';
import { StubEngine, okResult } from './engine/StubEngine';
import { createRequestHandler } from './http';
import { PinStore } from './sessions/PinStore';
import { SettingsStore } from './settings';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionMetaStore } from './sessions/SessionMetaStore';
import { AcceptedRefs } from './sessions/AcceptedRefs';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { PermissionBroker, QuestionBroker, attachWebSocket } from './ws';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'f'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
let server: http.Server;
let origin = '';
let wsUrl = '';
let stub: StubEngine;
let wsApi: ReturnType<typeof attachWebSocket>;
let pins: PinStore;
let settings: SettingsStore;
let base: string;
let work: string;
let store: SessionStateStore;
let index: SessionIndex;
let meta: SessionMetaStore;
let store2: AttachmentStore;
let gate: Promise<void> = Promise.resolve();
let release: () => void = () => {};
const hold = () => { gate = new Promise<void>((r) => { release = r; }); };
/** 'linger': the stream stays open after its result until lingerEnd() (the CLI process still shutting down). */
let lingerGate: Promise<void> = Promise.resolve();
let lingerEnd: () => void = () => {};

function card(id: string) {
  return { id, status: 'ok', fetchedAt: new Date().toISOString(), rows: [{ label: 'Session (5h)', used: 1 }, { label: 'Weekly (7d)', used: 1, resetsAt: new Date(Date.now() + 36e5).toISOString() }] };
}

/** Web Push hook: every event the ws layer hands to the notifier. */
const notified: ServerMessage[] = [];

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-ws-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-ws-work-')));
  meta = new SessionMetaStore(path.join(base, 'session-meta.json'));
  index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json'), meta });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [card('claude:main'), card('claude:second'), card('claude:third')] }) }) });
  await usage.pollOnce();
  store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  stub = new StubEngine(async (req) => {
    if (req.prompt === 'ask-scoped') {
      const d = await req.onPermission({ toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'tu2', title: 'Claude wants to run ls', decisionReason: 'r', blockedPath: '/b', defaultToNo: true, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'session' }] });
      return [{ kind: 'init', sessionId: 'sess-scoped', model: 'm' }, okResult('sess-scoped', `decision=${d}`)];
    }
    if (req.prompt === 'ask') {
      const d = await req.onPermission({ toolName: 'Write', input: { file_path: '/x' }, toolUseId: 'tu1' });
      return [{ kind: 'init', sessionId: 'sess-ask', model: 'm' }, { kind: 'delta', text: `decision=${d}` }, okResult('sess-ask', `decision=${d}`)];
    }
    if (req.prompt === 'question') {
      const a = await req.onQuestion?.({ toolUseId: 'q1', questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'red', description: '' }, { label: 'blue', description: '' }], multiSelect: false }] });
      return [{ kind: 'init', sessionId: 'sess-q', model: 'm' }, okResult('sess-q', `answer=${a ? a['Which color?'] : 'none'}`)];
    }
    if (req.prompt === 'att') return [{ kind: 'init', sessionId: 'sess-att', model: 'm' }, okResult('sess-att', `n=${req.attachments?.length ?? 0}`)];
    if (req.prompt === 'effort') return [{ kind: 'init', sessionId: 'sess-eff', model: 'm' }, okResult('sess-eff', `effort=${req.effort ?? 'none'}`)];
    if (req.prompt === 'whereami') return [{ kind: 'init', sessionId: 'sess-cwd', model: 'm' }, okResult('sess-cwd', `cwd=${req.cwd}`)];
    if (req.prompt === 'linger') {
      lingerGate = new Promise<void>((r) => { lingerEnd = r; });
      const sid = req.resumeSessionId ?? 'sess-linger';
      return (async function* () { yield { kind: 'init' as const, sessionId: sid, model: 'm' }; yield okResult(sid, 'first'); await lingerGate; })();
    }
    if (req.prompt === 'announce') {
      return (async function* () { yield { kind: 'init' as const, sessionId: '14141414-1414-4141-8141-141414141414', model: 'm' }; yield { kind: 'delta' as const, text: 'thinking' }; await gate; yield okResult('14141414-1414-4141-8141-141414141414', 'done'); })();
    }
    if (req.prompt === HANDOFF_PROMPT) return [{ kind: 'init', sessionId: req.resumeSessionId!, model: 'm' }, okResult(req.resumeSessionId!, `note noTools=${req.noTools === true}`)];
    if (req.prompt === 'continued') return [{ kind: 'init', sessionId: '77777777-7777-4777-8777-777777777777', model: 'm' }, okResult('77777777-7777-4777-8777-777777777777', `noTools=${req.noTools === true}`)];
    if (req.prompt === 'continued-later') {
      // The new session's id is reported only after the gate (the sending socket may be gone by then).
      return (async function* () { await gate; yield { kind: 'init' as const, sessionId: '77777777-7777-4777-8777-777777777778', model: 'm' }; yield okResult('77777777-7777-4777-8777-777777777778', 'later'); })();
    }
    if (req.prompt === 'edited') {
      const id = req.forkAt ? '88888888-8888-4888-8888-888888888881' : '88888888-8888-4888-8888-888888888880';
      return [{ kind: 'init', sessionId: id, model: 'm' }, okResult(id, `fork=${req.forkAt ?? 'none'} resume=${req.resumeSessionId ?? 'none'}`)];
    }
    if (req.prompt === 'throw') throw new Error('engine exploded');
    if (req.prompt === 'hold') await gate;
    const sid = req.resumeSessionId ?? 'sess-1';
    return [{ kind: 'init', sessionId: sid, model: 'm' }, { kind: 'delta', text: 'o' }, { kind: 'delta', text: 'k' }, okResult(sid, 'ok')];
  });
  store2 = new AttachmentStore(path.join(base, 'att'));
  await store2.init();
  const runner = new TurnRunner({ accounts: testRegistry(), attachments: store2, engine: stub, usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots), codex: null, codexSessionsRoot: path.join(base, 'codex-sessions') });
  pins = new PinStore(path.join(base, 'pins.json'));
  await pins.load();
  settings = new SettingsStore(path.join(base, 'settings.json'));
  await settings.load();
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  wsApi = attachWebSocket([server], { accounts: testRegistry(), token: TOKEN, devOrigins: ['http://dev.local'], runner, index, usage, store, codexAvailable: false, cwdRoots: [path.dirname(work)], pins, settings, notify: (m) => notified.push(m), attachments: store2, meta, acceptedRefs: new AcceptedRefs(null) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  origin = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});
afterAll(async () => { wsApi.close(); server.close(); await fs.rm(base, { recursive: true, force: true }); await fs.rm(work, { recursive: true, force: true }); });

// Deviation (evidence-based fix, not a plan/review item): the HTTP
// upgrade response and the server's first WS frame (sent synchronously on 'connection')
// can be coalesced into a single client-side read, so 'open' and 'message' fire
// back-to-back in one synchronous turn — before the `await connect()` continuation
// below gets a chance to attach collect()'s listener, silently dropping the message
// (confirmed by attaching a raw 'message' listener at socket-creation time and seeing
// it fire while collect() still timed out). Buffering from connection time and
// draining that buffer in collect() removes the race without changing any assertion.
function connect(headers: Record<string, string>): Promise<{ ok: boolean; ws: WebSocket; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers });
    const buffered: unknown[] = [];
    (ws as WebSocket & { _buffered: unknown[] })._buffered = buffered;
    ws.on('message', (d) => buffered.push(d));
    ws.once('open', () => resolve({ ok: true, ws }));
    ws.once('unexpected-response', (_req, res) => resolve({ ok: false, ws, status: res.statusCode }));
    ws.once('error', () => resolve({ ok: false, ws }));
  });
}

/** Everything that arrives within `ms` (for asserting that something is NOT sent). */
function quiet(ws: WebSocket, ms: number): Promise<ServerMessage[]> {
  return new Promise((resolve) => {
    const out: ServerMessage[] = [];
    const on = (d: unknown) => out.push(JSON.parse(String(d)) as ServerMessage);
    ws.on('message', on);
    setTimeout(() => { ws.off('message', on); resolve(out); }, ms);
  });
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

function collect(ws: WebSocket, until: (m: ServerMessage) => boolean, timeoutMs = 5000): Promise<ServerMessage[]> {
  return new Promise((resolve, reject) => {
    const out: ServerMessage[] = [];
    let done = false;
    let t: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (t) clearTimeout(t);
      ws.off('message', onMessage);
      resolve(out);
    };
    const consume = (d: unknown) => {
      if (done) return;
      const m = JSON.parse(String(d)) as ServerMessage;
      out.push(m);
      if (until(m)) finish();
    };
    const onMessage = (d: unknown) => consume(d);
    const buffered = (ws as WebSocket & { _buffered?: unknown[] })._buffered ?? [];
    (ws as WebSocket & { _buffered?: unknown[] })._buffered = [];
    for (const d of buffered) consume(d);
    if (!done) {
      t = setTimeout(() => { ws.off('message', onMessage); reject(new Error(`timeout; got ${JSON.stringify(out)}`)); }, timeoutMs);
      ws.on('message', onMessage);
    }
  });
}

describe('ws', () => {
  it('refuses upgrades without a cookie, with a bad cookie, or with a foreign origin', async () => {
    expect((await connect({ Origin: origin })).status).toBe(401);
    expect((await connect({ Origin: origin, Cookie: 'deck_session=bad' })).status).toBe(401);
    expect((await connect({ Origin: 'http://evil.example', Cookie: COOKIE })).status).toBe(403);
  });

  it('accepts cookie + own origin (and a dev origin), sends hello', async () => {
    const c = await connect({ Origin: origin, Cookie: COOKIE });
    expect(c.ok).toBe(true);
    const [hello] = await collect(c.ws, (m) => m.type === 'hello');
    expect(hello).toMatchObject({ type: 'hello', projects: [] });
    c.ws.close();
    const d = await connect({ Origin: 'http://dev.local', Cookie: COOKIE });
    expect(d.ok).toBe(true);
    d.ws.close();
  });

  it('runs a turn: turn_started, deltas, turn_result, then index refresh', async () => {
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p = collect(ws, (m) => m.type === 'index');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'hello' }));
    const msgs = (await p).filter((m) => m.type !== 'activity');
    expect(msgs.map((m) => m.type)).toEqual(['turn_started', 'delta', 'delta', 'turn_result', 'index']);
    expect(msgs[3]).toMatchObject({ type: 'turn_result', ok: true, text: 'ok', sessionId: 'sess-1', badge: { model: 'opus' } });
    ws.close();
  });

  it('a rejected run ends with a terminal turn_result, not a bare error', async () => {
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p = collect(ws, (m) => m.type === 'turn_result' || m.type === 'error');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'throw' }));
    const last = (await p).at(-1);
    expect(last).toMatchObject({ type: 'turn_result', ok: false, errorText: expect.stringContaining('engine exploded') });
    ws.close();
  });

  it('relays permission requests and resumes after the answer', async () => {
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p1 = collect(ws, (m) => m.type === 'permission_request');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'ask' }));
    const req = (await p1).at(-1) as Extract<ServerMessage, { type: 'permission_request' }>;
    expect(req).toMatchObject({ toolName: 'Write', input: { file_path: '/x' }, cwd: work, title: null, allowSession: false, sessionLabel: null });
    const p2 = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'permission_response', requestId: req.requestId, decision: 'session' }));
    const msgs = await p2;
    expect(msgs.find((m) => m.type === 'permission_resolved')).toMatchObject({ requestId: req.requestId, decision: 'session' });
    expect(msgs.at(-1)).toMatchObject({ type: 'turn_result', text: 'decision=session' });
    // Web Push hook saw the card and the finished turn.
    expect(notified.some((m) => m.type === 'permission_request' && m.requestId === req.requestId)).toBe(true);
    expect(notified.some((m) => m.type === 'turn_result' && m.text === 'decision=session')).toBe(true);
    ws.close();
  });

  it('permission_request relays title, reason, blocked path, defaultToNo, and offers 이 세션 when a scoped rule was suggested', async () => {
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p1 = collect(ws, (m) => m.type === 'permission_request');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'ask-scoped' }));
    const req = (await p1).at(-1) as Extract<ServerMessage, { type: 'permission_request' }>;
    expect(req).toMatchObject({ title: 'Claude wants to run ls', decisionReason: 'r', blockedPath: '/b', defaultToNo: true, allowSession: true, sessionLabel: '이 세션 동안 `Bash(ls)` 허용' });
    const p2 = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'permission_response', requestId: req.requestId, decision: 'deny' }));
    await p2;
    ws.close();
  });

  it('an answer to a permission card already resolved names the card in its error', async () => {
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const err = collect(ws, (m) => m.type === 'error');
    ws.send(JSON.stringify({ type: 'permission_response', requestId: 'gone1', decision: 'once' }));
    expect((await err).at(-1)).toEqual({ type: 'error', turnId: null, message: '이미 처리된 권한 요청입니다', requestId: 'gone1' });
    ws.close();
  });

  it('an interrupted turn leaves no pending prompt, and a reconnecting client gets no stale card', async () => {
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p1 = collect(ws, (m) => m.type === 'permission_request');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'ask' }));
    const req = (await p1).at(-1) as Extract<ServerMessage, { type: 'permission_request' }>;
    const p2 = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'interrupt', turnId: req.turnId }));
    const msgs = await p2;
    expect(msgs.find((m) => m.type === 'permission_resolved')).toMatchObject({ requestId: req.requestId, decision: 'deny' });
    ws.close();
    const again = await connect({ Origin: origin, Cookie: COOKIE });
    const seen = await collect(again.ws, () => false, 300).catch((e: Error) => e.message);
    expect(String(JSON.stringify(seen))).not.toContain('permission_request');
    again.ws.close();
  });

  it('a second send for a busy session is rejected; hello lists the running turn; the lock is released after', async () => {
    const SX = '22222222-2222-4222-8222-222222222222';
    const cwd = await seed(SX, 'lock');
    hold();
    const a = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(a.ws, (m) => m.type === 'hello');
    const started = collect(a.ws, (m) => m.type === 'turn_started');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd, text: 'hold' }));
    const ts = (await started).at(-1) as Extract<ServerMessage, { type: 'turn_started' }>;

    const b = await connect({ Origin: origin, Cookie: COOKIE });
    const [hello] = await collect(b.ws, (m) => m.type === 'hello');
    expect((hello as Extract<ServerMessage, { type: 'hello' }>).running).toContainEqual({ turnId: ts.turnId, sessionId: SX, cwd });
    const pe = collect(b.ws, (m) => m.type === 'error');
    b.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd, text: 'second' }));
    expect((await pe).at(-1)).toMatchObject({ type: 'error', message: '이 세션은 이미 실행 중입니다' });

    const done = collect(a.ws, (m) => m.type === 'turn_result');
    release();
    await done;
    const again = collect(b.ws, (m) => m.type === 'turn_result' || m.type === 'error');
    b.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd, text: 'third' }));
    expect((await again).at(-1)).toMatchObject({ type: 'turn_result', ok: true });
    a.ws.close();
    b.ws.close();
  });

  it('a send right after a turn_result, while the process is still closing, runs once the lock is released (queued message not lost)', async () => {
    const SX = '66666666-6666-4666-8666-666666666666';
    const cwd = await seed(SX, 'linger');
    const a = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(a.ws, (m) => m.type === 'hello');
    const first = collect(a.ws, (m) => m.type === 'turn_result');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd, text: 'linger' }));
    expect((await first).at(-1)).toMatchObject({ type: 'turn_result', ok: true, text: 'first' });
    // The UI's queue fires on turn_result: the server still holds the session lock here.
    const next = collect(a.ws, (m) => m.type === 'turn_result' || m.type === 'error');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd, text: 'second', clientRef: 'p0-2' }));
    await new Promise((r) => setTimeout(r, 50));
    lingerEnd();
    const msgs = await next;
    expect(msgs.find((m) => m.type === 'error')).toBeUndefined();
    expect(msgs.find((m) => m.type === 'turn_started')).toMatchObject({ sessionId: SX, clientRef: 'p0-2' });
    expect(msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: true, text: 'ok' });
    a.ws.close();
  });

  it('a started send\'s clientRef is recorded for its session and rides history.acceptedRefs (M1: dedupe after a lost answer)', async () => {
    const SX = 'abababab-abab-4bab-8bab-abababababab';
    const cwd = await seed(SX, 'accepted');
    const a = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(a.ws, (m) => m.type === 'hello');
    const h0 = collect(a.ws, (m) => m.type === 'history');
    a.ws.send(JSON.stringify({ type: 'open_session', sessionId: SX }));
    expect((await h0).at(-1)).toMatchObject({ type: 'history', acceptedRefs: [] });
    const done = collect(a.ws, (m) => m.type === 'turn_result');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd, text: 'went in', clientRef: 'acc-1' }));
    await done;
    const h1 = collect(a.ws, (m) => m.type === 'history');
    a.ws.send(JSON.stringify({ type: 'open_session', sessionId: SX }));
    expect((await h1).at(-1)).toMatchObject({ type: 'history', acceptedRefs: ['acc-1'] });
    a.ws.close();
  });

  it('clientRef is echoed on the send\'s turn_started and on errors refusing a send (busy, missing attachment, schema)', async () => {
    const SX = '55555555-5555-4555-8555-555555555555';
    const cwd = await seed(SX, 'ref');
    hold();
    const a = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(a.ws, (m) => m.type === 'hello');
    const started = collect(a.ws, (m) => m.type === 'turn_started');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd, text: 'hold', clientRef: 'p0-1' }));
    expect((await started).at(-1)).toMatchObject({ type: 'turn_started', sessionId: SX, clientRef: 'p0-1' });

    const busyErr = collect(a.ws, (m) => m.type === 'error');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd, text: 'second', clientRef: 'p1-1' }));
    expect((await busyErr).at(-1)).toMatchObject({ type: 'error', message: '이 세션은 이미 실행 중입니다', clientRef: 'p1-1' });

    const schemaErr = collect(a.ws, (m) => m.type === 'error');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: 'relative', text: 'x', clientRef: 'p2-1' }));
    expect((await schemaErr).at(-1)).toMatchObject({ type: 'error', clientRef: 'p2-1' });
    const tooLong = collect(a.ws, (m) => m.type === 'error');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: 'relative', text: 'x', clientRef: 'r'.repeat(65) }));
    expect((await tooLong).at(-1)).not.toHaveProperty('clientRef');

    const done = collect(a.ws, (m) => m.type === 'turn_result');
    release();
    await done;
    const attErr = collect(a.ws, (m) => m.type === 'error' || m.type === 'turn_started');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd, text: 'x', attachments: ['99999999-9999-4999-8999-999999999999'], clientRef: 'p3-1' }));
    expect((await attErr).at(-1)).toMatchObject({ type: 'error', clientRef: 'p3-1' });
    a.ws.close();
  });

  it('handoff: the note turn runs the fixed prompt with tools denied; new or busy sessions are refused', async () => {
    const SX = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    const cwd = await seed(SX, 'handoff');
    const a = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(a.ws, (m) => m.type === 'hello');
    const done = collect(a.ws, (m) => m.type === 'turn_result' || m.type === 'error');
    // The client's text is ignored (and attachments dropped): the server always sends HANDOFF_PROMPT.
    a.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd, text: 'anything', handoff: true, clientRef: 'h-1' }));
    const msgs = await done;
    expect(msgs.find((m) => m.type === 'turn_started')).toMatchObject({ sessionId: SX, clientRef: 'h-1', prompt: { text: HANDOFF_PROMPT } });
    expect(msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: true, text: 'note noTools=true' });

    const fresh = collect(a.ws, (m) => m.type === 'error');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd, text: 'x', handoff: true, clientRef: 'h-2' }));
    expect((await fresh).at(-1)).toMatchObject({ type: 'error', clientRef: 'h-2', message: '새 세션은 넘길 대화가 없습니다' });

    hold();
    const started = collect(a.ws, (m) => m.type === 'turn_started');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd, text: 'hold' }));
    await started;
    const busyErr = collect(a.ws, (m) => m.type === 'error');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd, text: 'x', handoff: true, clientRef: 'h-3' }));
    expect((await busyErr).at(-1)).toMatchObject({ type: 'error', clientRef: 'h-3' });
    const end = collect(a.ws, (m) => m.type === 'turn_result');
    release();
    await end;
    a.ws.close();
  });

  it('handoff: a new session sent with handoffFrom is linked and titled in session meta once it has an id', async () => {
    const SX = '99999999-9999-4999-8999-999999999990';
    const cwd = await seed(SX, 'handoff-from');
    const a = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(a.ws, (m) => m.type === 'hello');
    const done = collect(a.ws, (m) => m.type === 'turn_result');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd, text: 'continued', handoffFrom: SX }));
    // An ordinary turn: tools are not denied in the continued session.
    expect((await done).at(-1)).toMatchObject({ type: 'turn_result', ok: true, text: 'noTools=false' });
    const NEW = '77777777-7777-4777-8777-777777777777';
    await vi.waitFor(() => expect(meta.next(SX)).toBe(NEW));
    expect(meta.prev(NEW)).toBe(SX);
    expect(meta.title(NEW)).toBe('seed (이어서)');
    await vi.waitFor(() => expect(index.projects().flatMap((p) => p.sessions).find((e) => e.sessionId === SX)?.nextSession).toBe(NEW));
    a.ws.close();
  });

  it('handoff: a first send that ends without an id links nothing; its retry links once the id arrives, even after the sender disconnected', async () => {
    const SX = '99999999-9999-4999-8999-999999999992';
    const cwd = await seed(SX, 'handoff-retry');
    const a = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(a.ws, (m) => m.type === 'hello');
    const failed = collect(a.ws, (m) => m.type === 'turn_result');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd, text: 'throw', handoffFrom: SX }));
    expect((await failed).at(-1)).toMatchObject({ type: 'turn_result', ok: false, sessionId: null });
    expect(meta.next(SX)).toBeNull();

    hold();
    const started = collect(a.ws, (m) => m.type === 'turn_started');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd, text: 'continued-later', handoffFrom: SX }));
    await started;
    a.ws.close();
    release();
    const NEW = '77777777-7777-4777-8777-777777777778';
    await vi.waitFor(() => expect(meta.next(SX)).toBe(NEW));
    expect(meta.prev(NEW)).toBe(SX);
  });

  it('메시지 편집 갈래: a send with branch forks the parent at the edited message and links the new session in meta', async () => {
    const SX = '99999999-9999-4999-8999-999999999991';
    const cwd = await seed(SX, 'branch-from');
    const file = path.join(base, 'b', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SX}.jsonl`);
    const lines = [
      { type: 'user', uuid: 'u0', parentUuid: null, cwd, message: { role: 'user', content: 'seed' } },
      { type: 'assistant', uuid: 'a0', parentUuid: 'u0', message: { id: 'm0', role: 'assistant', content: [{ type: 'text', text: '답 0' }] } },
      { type: 'user', uuid: 'u1', parentUuid: 'a0', message: { role: 'user', content: '두 번째' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '답 1' }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n';
    await fs.writeFile(file, lines);
    const a = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(a.ws, (m) => m.type === 'hello');

    let done = collect(a.ws, (m) => m.type === 'turn_result');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd, text: 'edited', branch: { from: SX, n: 1, expect: '두 번째' } }));
    expect((await done).at(-1)).toMatchObject({ type: 'turn_result', ok: true, text: `fork=a0 resume=${SX}`, sessionId: '88888888-8888-4888-8888-888888888881' });
    await vi.waitFor(() => expect(meta.branchOf('88888888-8888-4888-8888-888888888881')).toEqual({ parent: SX, n: 1 }));
    expect(await fs.readFile(file, 'utf8')).toBe(lines);

    // The first message: a fresh session (same cwd), still a version of message 0.
    done = collect(a.ws, (m) => m.type === 'turn_result');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd, text: 'edited', branch: { from: SX, n: 0, expect: 'seed' } }));
    expect((await done).at(-1)).toMatchObject({ ok: true, text: 'fork=none resume=none' });
    await vi.waitFor(() => expect(meta.branchOf('88888888-8888-4888-8888-888888888880')).toEqual({ parent: SX, n: 0 }));

    // A message that is not in the transcript: refused before any turn, with the pane's clientRef.
    const err = collect(a.ws, (m) => m.type === 'error');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd, text: 'edited', clientRef: 'r-x', branch: { from: SX, n: 1, expect: '없는 말' } }));
    expect((await err).at(-1)).toMatchObject({ type: 'error', clientRef: 'r-x', message: expect.stringContaining('편집할 메시지') });
    a.ws.close();
  });

  it('turn events go to the originating socket and sockets viewing that session only', async () => {
    const SX = '33333333-3333-4333-8333-333333333333';
    const SY = '44444444-4444-4444-8444-444444444444';
    const cwdX = await seed(SX, 'route-x');
    await seed(SY, 'route-y');
    const viewerY = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(viewerY.ws, (m) => m.type === 'hello');
    const hy = collect(viewerY.ws, (m) => m.type === 'history');
    viewerY.ws.send(JSON.stringify({ type: 'open_session', sessionId: SY }));
    await hy;
    const viewerX = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(viewerX.ws, (m) => m.type === 'hello');
    const hx = collect(viewerX.ws, (m) => m.type === 'history');
    viewerX.ws.send(JSON.stringify({ type: 'open_session', sessionId: SX }));
    await hx;

    const sender = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(sender.ws, (m) => m.type === 'hello');
    const onY = quiet(viewerY.ws, 400);
    const onX = collect(viewerX.ws, (m) => m.type === 'turn_result');
    const own = collect(sender.ws, (m) => m.type === 'turn_result');
    sender.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd: cwdX, text: 'hello' }));
    const mine = await own;
    expect(mine.filter((m) => m.type === 'delta')).toHaveLength(2);
    expect(mine.find((m) => m.type === 'delta')).toMatchObject({ sessionId: SX, cwd: cwdX });
    expect((await onX).filter((m) => m.type === 'delta')).toHaveLength(2);
    expect((await onY).filter((m) => m.type === 'delta' || m.type === 'turn_started' || m.type === 'turn_result')).toEqual([]);
    for (const c of [viewerX, viewerY, sender]) c.ws.close();
  });

  it('cross-device: a second client viewing the session gets the prompt (text, attachment metadata, clientRef) and the whole turn', async () => {
    const SZ = '12121212-1212-4121-8121-121212121212';
    const cwd = await seed(SZ, 'sync-two');
    const img = await store2.save('shot.png', Buffer.from('89504e470d0a1a0a00', 'hex'));
    const phone = await connect({ Origin: origin, Cookie: COOKIE });
    const desk = await connect({ Origin: origin, Cookie: COOKIE });
    for (const c of [phone, desk]) {
      await collect(c.ws, (m) => m.type === 'hello');
      const h = collect(c.ws, (m) => m.type === 'history');
      c.ws.send(JSON.stringify({ type: 'open_session', sessionId: SZ }));
      await h;
    }
    const onDesk = collect(desk.ws, (m) => m.type === 'turn_result');
    const onPhone = collect(phone.ws, (m) => m.type === 'turn_result');
    phone.ws.send(JSON.stringify({ type: 'send', sessionId: SZ, cwd, text: '1+1만 답해', attachments: [img.id], clientRef: 'tabP-1' }));
    const d = await onDesk;
    expect(d.find((m) => m.type === 'turn_started')).toMatchObject({ sessionId: SZ, clientRef: 'tabP-1', prompt: { text: '1+1만 답해', attachments: [{ id: img.id, name: 'shot.png', isImage: true }] } });
    expect(d.filter((m) => m.type === 'delta').map((m) => (m as { text: string }).text).join('')).toBe('ok');
    expect(d.at(-1)).toMatchObject({ type: 'turn_result', ok: true, sessionId: SZ });
    expect((await onPhone).find((m) => m.type === 'turn_started')).toMatchObject({ clientRef: 'tabP-1', prompt: { text: '1+1만 답해' } });
    for (const c of [phone, desk]) c.ws.close();
  });

  it('cross-device: a client opening the session mid-turn gets the running prompt with its history', async () => {
    const SZ = '13131313-1313-4131-8131-131313131313';
    const cwd = await seed(SZ, 'sync-mid');
    hold();
    const a = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(a.ws, (m) => m.type === 'hello');
    const started = collect(a.ws, (m) => m.type === 'turn_started');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: SZ, cwd, text: 'hold' }));
    const ts = (await started).at(-1) as Extract<ServerMessage, { type: 'turn_started' }>;
    const b = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(b.ws, (m) => m.type === 'hello');
    const h = collect(b.ws, (m) => m.type === 'history');
    b.ws.send(JSON.stringify({ type: 'open_session', sessionId: SZ }));
    expect((await h).at(-1)).toMatchObject({ type: 'history', runningTurnId: ts.turnId, runningPrompt: { text: 'hold', attachments: [] } });
    const done = collect(b.ws, (m) => m.type === 'turn_result');
    release();
    expect((await done).at(-1)).toMatchObject({ type: 'turn_result', turnId: ts.turnId, ok: true });
    const h2 = collect(b.ws, (m) => m.type === 'history');
    b.ws.send(JSON.stringify({ type: 'open_session', sessionId: SZ }));
    expect((await h2).at(-1)).toMatchObject({ runningTurnId: null, runningPrompt: null });
    for (const c of [a, b]) c.ws.close();
  });

  it('cross-device: a new session appears in every client\'s sidebar as soon as its id is known, before the turn ends', async () => {
    const cwd = path.join(work, 'announce');
    await fs.mkdir(cwd, { recursive: true });
    const dir = path.join(base, 'b', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '14141414-1414-4141-8141-141414141414.jsonl'), JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'announce' } }) + '\n');
    hold();
    const phone = await connect({ Origin: origin, Cookie: COOKIE });
    const desk = await connect({ Origin: origin, Cookie: COOKIE });
    for (const c of [phone, desk]) await collect(c.ws, (m) => m.type === 'hello');
    const listed = collect(desk.ws, (m) => m.type === 'index' && m.projects.some((p) => p.sessions.some((s) => s.sessionId === '14141414-1414-4141-8141-141414141414')));
    phone.ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd, text: 'announce' }));
    const got = await listed;
    expect(got.some((m) => m.type === 'turn_result')).toBe(false);
    const done = collect(phone.ws, (m) => m.type === 'turn_result');
    release();
    expect((await done).at(-1)).toMatchObject({ ok: true, sessionId: '14141414-1414-4141-8141-141414141414' });
    for (const c of [phone, desk]) c.ws.close();
  });

  it('a reconnected tab can watch its in-flight new-session turn and gets the result', async () => {
    hold();
    const a = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(a.ws, (m) => m.type === 'hello');
    const started = collect(a.ws, (m) => m.type === 'turn_started');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'hold' }));
    const ts = (await started).at(-1) as Extract<ServerMessage, { type: 'turn_started' }>;
    a.ws.close();
    const b = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(b.ws, (m) => m.type === 'hello');
    const done = collect(b.ws, (m) => m.type === 'turn_result');
    b.ws.send(JSON.stringify({ type: 'watch_turn', turnId: ts.turnId }));
    await new Promise((r) => setTimeout(r, 50));
    release();
    expect((await done).at(-1)).toMatchObject({ type: 'turn_result', turnId: ts.turnId, ok: true });
    b.ws.close();
  });

  it('cwd must be an absolute, existing directory', async () => {
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p1 = collect(ws, (m) => m.type === 'error');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: 'relative/dir', text: 'x' }));
    expect((await p1).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('cwd') });
    const p2 = collect(ws, (m) => m.type === 'error');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: '/' + 'x'.repeat(4100), text: 'x' }));
    expect((await p2).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('cwd') });
    const p3 = collect(ws, (m) => m.type === 'error' || m.type === 'turn_started');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: path.join(work, 'does-not-exist'), text: 'x' }));
    expect((await p3).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('작업 폴더') });
    ws.close();
  });

  it('a new session\'s cwd must lie under the allowed roots (home), symlink escapes included (F1)', async () => {
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p1 = collect(ws, (m) => m.type === 'error' || m.type === 'turn_started');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: '/usr', text: 'x', clientRef: 'out-1' }));
    expect((await p1).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('홈 폴더'), clientRef: 'out-1' });
    await fs.symlink('/usr', path.join(work, 'usr-link')).catch(() => {});
    const p2 = collect(ws, (m) => m.type === 'error' || m.type === 'turn_started');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: path.join(work, 'usr-link'), text: 'x' }));
    expect((await p2).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('홈 폴더') });
    ws.close();
  });

  it('a new session runs in the validated real path, not the raw (symlinked) cwd it was sent (review fix 3)', async () => {
    await fs.mkdir(path.join(work, 'real-dir'), { recursive: true });
    await fs.symlink(path.join(work, 'real-dir'), path.join(work, 'alias-dir')).catch(() => {});
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: path.join(work, 'alias-dir'), text: 'whereami' }));
    expect((await p).at(-1)).toMatchObject({ type: 'turn_result', ok: true, text: `cwd=${path.join(work, 'real-dir')}` });
    ws.close();
  });

  it('broadcastIndex sends the project index and the pins to every client; hello carries the pins (F2)', async () => {
    await pins.set('pinned-1', true);
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    expect((await collect(ws, (m) => m.type === 'hello')).at(-1)).toMatchObject({ type: 'hello', pins: ['pinned-1'] });
    await pins.set('pinned-1', false);
    const p = collect(ws, (m) => m.type === 'index');
    wsApi.broadcastIndex();
    expect((await p).at(-1)).toMatchObject({ type: 'index', projects: expect.any(Array), pins: [] });
    ws.close();
  });

  it('hello carries 자동 승인 (default off); set_settings persists it and broadcasts to every client', async () => {
    const a = await connect({ Origin: origin, Cookie: COOKIE });
    const b = await connect({ Origin: origin, Cookie: COOKIE });
    expect((await collect(a.ws, (m) => m.type === 'hello')).at(-1)).toMatchObject({ type: 'hello', settings: { autoApprove: false, defaultPermissionMode: 'default' } });
    await collect(b.ws, (m) => m.type === 'hello');
    const pa = collect(a.ws, (m) => m.type === 'settings');
    const pb = collect(b.ws, (m) => m.type === 'settings');
    a.ws.send(JSON.stringify({ type: 'set_settings', autoApprove: true }));
    expect((await pa).at(-1)).toEqual({ type: 'settings', settings: { autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance' } });
    expect((await pb).at(-1)).toEqual({ type: 'settings', settings: { autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance' } });
    expect(JSON.parse(await fs.readFile(path.join(base, 'settings.json'), 'utf8'))).toEqual({ autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance' });
    const pc = collect(a.ws, (m) => m.type === 'settings');
    a.ws.send(JSON.stringify({ type: 'set_settings', autoApprove: false }));
    expect((await pc).at(-1)).toMatchObject({ settings: { autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'balance' } });
    const pd = collect(a.ws, (m) => m.type === 'settings');
    a.ws.send(JSON.stringify({ type: 'set_settings', defaultPermissionMode: 'plan' }));
    expect((await pd).at(-1)).toEqual({ type: 'settings', settings: { autoApprove: false, defaultPermissionMode: 'plan', routingPolicy: 'balance' } });
    const pe = collect(a.ws, (m) => m.type === 'settings');
    a.ws.send(JSON.stringify({ type: 'set_settings', routingPolicy: 'drain' }));
    expect((await pe).at(-1)).toEqual({ type: 'settings', settings: { autoApprove: false, defaultPermissionMode: 'plan', routingPolicy: 'drain' } });
    expect(JSON.parse(await fs.readFile(path.join(base, 'settings.json'), 'utf8')).routingPolicy).toBe('drain');
    a.ws.close(); b.ws.close();
  });

  it('rejects invalid messages with an error and keeps the socket open', async () => {
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p = collect(ws, (m) => m.type === 'error');
    ws.send('not json');
    expect((await p).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('메시지') });
    const p2 = collect(ws, (m) => m.type === 'error');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: '/w', text: 'x', model: 'haiku' }));
    expect((await p2).at(-1)).toMatchObject({ type: 'error' });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('open_session returns history for a stored session and an error for an unknown one', async () => {
    const dir = path.join(base, 'c', '-w-y');
    await fs.mkdir(dir, { recursive: true });
    const SID = '99999999-9999-4999-8999-999999999999';
    await fs.writeFile(path.join(dir, `${SID}.jsonl`), JSON.stringify({ type: 'user', cwd: '/w/y', message: { role: 'user', content: 'first' } }) + '\n' + JSON.stringify({ type: 'assistant', message: { id: 'm', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'reply' }] } }) + '\n');
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const pi = collect(ws, (m) => m.type === 'index');
    ws.send(JSON.stringify({ type: 'refresh_index' }));
    await pi;
    const p = collect(ws, (m) => m.type === 'history');
    ws.send(JSON.stringify({ type: 'open_session', sessionId: SID }));
    const h = (await p).at(-1) as Extract<ServerMessage, { type: 'history' }>;
    expect(h).toMatchObject({ sessionId: SID, cwd: '/w/y', account: 'c' });
    expect(h.messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
    const pe = collect(ws, (m) => m.type === 'error');
    ws.send(JSON.stringify({ type: 'open_session', sessionId: 'nope' }));
    expect((await pe).at(-1)).toMatchObject({ type: 'error' });
    ws.close();
  });

  it('open_session shows the A copy when Claude Desktop extended the session deck last ran on B', async () => {
    const SID = '77777777-7777-4777-8777-777777777777';
    const cwd = await seed(SID, 'desk');
    const dirName = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const bFile = path.join(base, 'b', dirName, `${SID}.jsonl`);
    const aDir = path.join(base, 'a', dirName);
    await fs.mkdir(aDir, { recursive: true });
    await fs.writeFile(path.join(aDir, `${SID}.jsonl`), (await fs.readFile(bFile, 'utf8')) + JSON.stringify({ type: 'user', uuid: 'u-desktop', cwd, message: { role: 'user', content: 'from desktop' } }) + '\n');
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p = collect(ws, (m) => m.type === 'history');
    ws.send(JSON.stringify({ type: 'open_session', sessionId: SID }));
    const h = (await p).at(-1) as Extract<ServerMessage, { type: 'history' }>;
    expect(h.messages.map((m) => m.kind)).toEqual(['user', 'user']);
    expect(h.account).toBe('b');
    ws.close();
  });

  it('open_session on a Gemini session: engine, pinned account and sandbox, empty history (no transcript reader)', async () => {
    const GID = '4f1c2b9e-1111-4222-8333-944455556666';
    await store.set({ engine: 'gemini', account: 'g2', sessionId: GID, cwd: '/w/g', lastTurnAtMs: 1, justCompacted: false, defaultModel: 'gemini-pro', sandbox: 'read-only', createdAtMs: 1 });
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    const [hello] = await collect(ws, (m) => m.type === 'hello');
    // No geminiStatus dep → hello carries no gemini field (the UI hides the option).
    expect(hello).not.toHaveProperty('gemini');
    const p = collect(ws, (m) => m.type === 'history');
    ws.send(JSON.stringify({ type: 'open_session', sessionId: GID }));
    expect((await p).at(-1)).toMatchObject({ sessionId: GID, cwd: '/w/g', account: 'g2', engine: 'gemini', sandbox: 'read-only', messages: [] });
    ws.close();
  });

  // Regression: a session written after the server's initial index scan (e.g. by Claude
  // Desktop) is not yet in the in-memory index. open_session must rescan once and still
  // find it, without the client ever triggering refresh_index itself.
  it('open_session rescans the index once for a session written after the initial scan', async () => {
    const dir = path.join(base, 'c', '-w-z');
    await fs.mkdir(dir, { recursive: true });
    const SID = '88888888-8888-4888-8888-888888888888';
    await fs.writeFile(path.join(dir, `${SID}.jsonl`), JSON.stringify({ type: 'user', cwd: '/w/z', message: { role: 'user', content: 'first' } }) + '\n' + JSON.stringify({ type: 'assistant', message: { id: 'm', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'reply' }] } }) + '\n');
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p = collect(ws, (m) => m.type === 'history');
    ws.send(JSON.stringify({ type: 'open_session', sessionId: SID }));
    const h = (await p).at(-1) as Extract<ServerMessage, { type: 'history' }>;
    expect(h).toMatchObject({ sessionId: SID, cwd: '/w/z', account: 'c' });
    expect(h.messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
    ws.close();
  });

  it('survives an invalid-UTF-8 frame and an oversized frame, then serves another client', async () => {
    const { port } = server.address() as { port: number };
    const rawFrame = (frame: Buffer) => new Promise<void>((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nCookie: ${COOKIE}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let upgraded = false;
      s.on('data', (d) => { if (!upgraded && String(d).startsWith('HTTP/1.1 101')) { upgraded = true; s.write(frame); } });
      s.on('error', () => {});
      s.on('close', () => resolve());
      setTimeout(() => { s.destroy(); resolve(); }, 1500);
    });
    const mask = Buffer.from([1, 2, 3, 4]);
    // masked FIN text frame whose single payload byte is 0xff (invalid UTF-8)
    await rawFrame(Buffer.concat([Buffer.from([0x81, 0x80 | 1]), mask, Buffer.from([0xff ^ 1])]));
    // masked FIN text frame header announcing a 2 MiB payload (over maxPayload)
    const len = Buffer.alloc(8); len.writeBigUInt64BE(2n * 1024n * 1024n);
    await rawFrame(Buffer.concat([Buffer.from([0x81, 0x80 | 127]), len, mask, Buffer.alloc(1024)]));
    const c = await connect({ Origin: origin, Cookie: COOKIE });
    expect(c.ok).toBe(true);
    const [hello] = await collect(c.ws, (m) => m.type === 'hello');
    expect(hello?.type).toBe('hello');
    c.ws.close();
  });

  it('send.attachments ids reach the engine as Attachment objects', async () => {
    const a = await store2.save('p.png', Buffer.from('89504e470d0a1a0a00', 'hex'));
    const { ws } = await connect({ Cookie: COOKIE, Origin: origin });
    await collect(ws, (m) => m.type === 'hello');
    const r = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'att', attachments: [a.id] }));
    expect((await r).at(-1)).toMatchObject({ type: 'turn_result', ok: true, text: 'n=1' });
    ws.close();
  });

  it('send.effort reaches the engine', async () => {
    const { ws } = await connect({ Cookie: COOKIE, Origin: origin });
    await collect(ws, (m) => m.type === 'hello');
    const r = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'effort', model: 'opus', effort: 'xhigh' }));
    expect((await r).at(-1)).toMatchObject({ type: 'turn_result', ok: true, text: 'effort=xhigh' });
    ws.close();
  });
});

describe('PermissionBroker', () => {
  const req = (requestId: string, turnId = 't1') => ({ type: 'permission_request' as const, turnId, sessionId: null, cwd: '/w', requestId, toolName: 'Bash', input: {}, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: '이 세션 동안 `Bash(ls)` 허용' });

  it('an aborted signal resolves deny, drops the prompt and tells every client', async () => {
    const sent: ServerMessage[] = [];
    const b = new PermissionBroker((m) => sent.push(m));
    const ac = new AbortController();
    const p = b.ask(req('r1'), ac.signal);
    expect(b.pending()).toHaveLength(1);
    ac.abort();
    expect(await p).toBe('deny');
    expect(b.pending()).toEqual([]);
    expect(sent.at(-1)).toEqual({ type: 'permission_resolved', requestId: 'r1', decision: 'deny' });
  });

  it('cancelTurn denies only that turn\'s prompts', async () => {
    const sent: ServerMessage[] = [];
    const b = new PermissionBroker((m) => sent.push(m));
    const p1 = b.ask(req('r1', 't1'));
    void b.ask(req('r2', 't2'));
    b.cancelTurn('t1');
    expect(await p1).toBe('deny');
    expect(b.pending().map((m) => (m as { requestId: string }).requestId)).toEqual(['r2']);
  });

  it('an unanswered prompt is auto-denied after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const b = new PermissionBroker(() => {}, { timeoutMs: 1000 });
      const p = b.ask(req('r1'));
      vi.advanceTimersByTime(1001);
      expect(await p).toBe('deny');
      expect(b.pending()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('multi-session viewing and Codex sessions (D4, D6)', () => {
  it('hello reports codex availability', async () => {
    const { ws } = await connect({ Cookie: COOKIE, Origin: origin });
    const [hello] = await collect(ws, (m) => m.type === 'hello');
    expect(hello).toMatchObject({ type: 'hello', codex: { available: false } });
    ws.close();
  });

  it('one socket can view two sessions; close_session stops the events for that session only', async () => {
    const sidA = '66666666-6666-4666-8666-666666666666';
    const sidB = '77777777-7777-4777-8777-777777777777';
    const cwdA = await seed(sidA, 'view-a');
    const cwdB = await seed(sidB, 'view-b');
    const viewer = (await connect({ Cookie: COOKIE, Origin: origin })).ws;
    await collect(viewer, (m) => m.type === 'hello');
    viewer.send(JSON.stringify({ type: 'open_session', sessionId: sidA }));
    await collect(viewer, (m) => m.type === 'history');
    viewer.send(JSON.stringify({ type: 'open_session', sessionId: sidB }));
    await collect(viewer, (m) => m.type === 'history');
    const sender = (await connect({ Cookie: COOKIE, Origin: origin })).ws;
    await collect(sender, (m) => m.type === 'hello');
    const seenA = collect(viewer, (m) => m.type === 'turn_result' && m.sessionId === sidA);
    sender.send(JSON.stringify({ type: 'send', sessionId: sidA, cwd: cwdA, text: 'hi' }));
    expect((await seenA).some((m) => m.type === 'delta')).toBe(true);
    const seenB = collect(viewer, (m) => m.type === 'turn_result' && m.sessionId === sidB);
    sender.send(JSON.stringify({ type: 'send', sessionId: sidB, cwd: cwdB, text: 'hi' }));
    await seenB;
    viewer.send(JSON.stringify({ type: 'close_session', sessionId: sidB }));
    await new Promise((r) => setTimeout(r, 50));
    const q = quiet(viewer, 400);
    sender.send(JSON.stringify({ type: 'send', sessionId: sidB, cwd: cwdB, text: 'hi' }));
    expect((await q).filter((m) => 'sessionId' in m && m.sessionId === sidB)).toEqual([]);
    const stillA = collect(viewer, (m) => m.type === 'turn_result' && m.sessionId === sidA);
    sender.send(JSON.stringify({ type: 'send', sessionId: sidA, cwd: cwdA, text: 'hi' }));
    await stillA;
    viewer.close(); sender.close();
  });

  it('open_session on a Codex session reads its rollout file and reports engine codex', async () => {
    const tid = '01a0f2d3-0000-7c92-aeea-000000000009';
    const rollout = path.join(base, `rollout-2026-09-30T23-59-26-${tid}.jsonl`);
    await fs.writeFile(rollout, [
      JSON.stringify({ type: 'session_meta', payload: { id: tid, cwd: work } }),
      JSON.stringify({ timestamp: '2026-09-30T14:59:28.268Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: ok' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }),
    ].join('\n') + '\n');
    await store.set({ engine: 'codex', sessionId: tid, cwd: work, lastTurnAtMs: 5, justCompacted: false, defaultModel: 'gpt-6-sol', sandbox: 'read-only', rolloutFile: rollout, createdAtMs: 1, title: 'Reply with exactly: ok' });
    const { ws } = await connect({ Cookie: COOKIE, Origin: origin });
    const [hello] = await collect(ws, (m) => m.type === 'hello');
    expect(hello?.type === 'hello' && hello.projects.flatMap((p) => p.sessions).find((s) => s.sessionId === tid)).toMatchObject({ account: 'gpt', engine: 'codex' });
    ws.send(JSON.stringify({ type: 'open_session', sessionId: tid }));
    const h = (await collect(ws, (m) => m.type === 'history')).at(-1);
    expect(h).toMatchObject({ type: 'history', sessionId: tid, cwd: work, account: 'gpt', engine: 'codex', sandbox: 'read-only', runningTurnId: null });
    expect(h && h.type === 'history' ? h.messages : []).toEqual([
      { kind: 'user', text: 'Reply with exactly: ok', ts: '2026-09-30T14:59:28.268Z' },
      { kind: 'assistant', text: 'ok', model: null, toolCalls: [], ts: null },
    ]);
    ws.close();
  });
});

describe('AskUserQuestion over the socket (D8)', () => {
  it('broadcasts question_request, a question_response answers it, question_resolved closes it everywhere', async () => {
    const asker = (await connect({ Cookie: COOKIE, Origin: origin })).ws;
    await collect(asker, (m) => m.type === 'hello');
    const other = (await connect({ Cookie: COOKIE, Origin: origin })).ws;
    await collect(other, (m) => m.type === 'hello');
    const q = collect(other, (m) => m.type === 'question_request');
    asker.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'question' }));
    const reqMsg = (await q).at(-1);
    expect(reqMsg).toMatchObject({ type: 'question_request', cwd: work, questions: [{ question: 'Which color?', options: [{ label: 'red' }, { label: 'blue' }] }] });
    const requestId = reqMsg && reqMsg.type === 'question_request' ? reqMsg.requestId : '';
    // a late socket sees the pending question replayed
    const late = (await connect({ Cookie: COOKIE, Origin: origin })).ws;
    const replay = await collect(late, (m) => m.type === 'question_request');
    expect(replay.at(-1)).toMatchObject({ requestId });
    const resolved = collect(asker, (m) => m.type === 'question_resolved');
    const result = collect(asker, (m) => m.type === 'turn_result');
    other.send(JSON.stringify({ type: 'question_response', requestId, answers: { 'Which color?': 'blue' } }));
    expect((await resolved).at(-1)).toMatchObject({ type: 'question_resolved', requestId, answers: { 'Which color?': 'blue' } });
    expect((await result).at(-1)).toMatchObject({ type: 'turn_result', ok: true, text: 'answer=blue' });
    const dup = collect(other, (m) => m.type === 'error');
    other.send(JSON.stringify({ type: 'question_response', requestId, answers: {} }));
    expect((await dup).at(-1)).toMatchObject({ type: 'error', message: '이미 처리된 질문입니다', requestId });
    asker.close(); other.close(); late.close();
  });

  it('interrupt closes an open question as unanswered', async () => {
    const ws = (await connect({ Cookie: COOKIE, Origin: origin })).ws;
    await collect(ws, (m) => m.type === 'hello');
    const q = collect(ws, (m) => m.type === 'question_request');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'question' }));
    const reqMsg = (await q).at(-1);
    const resolved = collect(ws, (m) => m.type === 'question_resolved');
    ws.send(JSON.stringify({ type: 'interrupt', turnId: reqMsg && reqMsg.type === 'question_request' ? reqMsg.turnId : '' }));
    expect((await resolved).at(-1)).toMatchObject({ type: 'question_resolved', answers: null });
    await collect(ws, (m) => m.type === 'turn_result');
    ws.close();
  });
});

describe('QuestionBroker answer validation (D8)', () => {
  const Q = { type: 'question_request' as const, turnId: 't', sessionId: null, cwd: '/w', requestId: 'r1', questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'red', description: '' }, { label: 'blue', description: '' }], multiSelect: false }] };

  it('keeps only answers to the questions that were asked', async () => {
    const sent: ServerMessage[] = [];
    const b = new QuestionBroker((m) => sent.push(m));
    const p = b.ask(Q);
    expect(b.resolve('r1', { 'Which color?': 'blue', injected: 'x' })).toBe(true);
    expect(await p).toEqual({ 'Which color?': 'blue' });
    expect(sent.at(-1)).toEqual({ type: 'question_resolved', requestId: 'r1', answers: { 'Which color?': 'blue' } });
  });

  it('an answer set with no asked question counts as unanswered (null)', async () => {
    const sent: ServerMessage[] = [];
    const b = new QuestionBroker((m) => sent.push(m));
    const p = b.ask(Q);
    expect(b.resolve('r1', { other: 'x' })).toBe(true);
    expect(await p).toBeNull();
    expect(sent.at(-1)).toEqual({ type: 'question_resolved', requestId: 'r1', answers: null });
  });
});
