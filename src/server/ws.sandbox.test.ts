import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { cookieValueFor } from './auth';
import { StubEngine } from './engine/StubEngine';
import { createRequestHandler } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket } from './ws';
import { testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'b'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
const GPT = '31313131-3131-4313-8313-313131313131';
const CLAUDE = '32323232-3232-4323-8323-323232323232';
let base: string;
let host: string;
let store: SessionStateStore;
let server: http.Server;
let api: ReturnType<typeof attachWebSocket>;

beforeAll(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-ws-sandbox-')));
  const work = path.join(base, 'work');
  await fs.mkdir(work);
  const accounts = testRegistry(path.join(base, 'home'));
  const roots = accounts.projectsRoots();
  for (const r of roots) await fs.mkdir(r.dir, { recursive: true });
  const index = new SessionIndex({ roots, pinnedFile: path.join(base, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }), accounts });
  store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  await store.set({ engine: 'codex', sessionId: GPT, cwd: work, lastTurnAtMs: 1, justCompacted: false, defaultModel: 'gpt-6-sol', sandbox: 'read-only', rolloutFile: null, createdAtMs: 1 });
  await store.set({ sessionId: CLAUDE, cwd: work, account: 'a', projectDir: path.join(accounts.projectsDir('a'), 'p'), lastTurnAtMs: 1, justCompacted: false, defaultModel: 'opus' });
  const runner = new TurnRunner({ attachments: null, engine: new StubEngine(async () => []), usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: roots, codex: null, codexSessionsRoot: path.join(base, 'codex-sessions'), accounts });
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  api = attachWebSocket([server], { token: TOKEN, devOrigins: [], runner, index, usage, store, codexAvailable: false, cwdRoots: [base], accounts });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  host = `127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { api.close(); server.close(); await fs.rm(base, { recursive: true, force: true }); });

async function client() {
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
  const say = (m: ClientMessage) => ws.send(JSON.stringify(m));
  await until((m) => m.type === 'hello');
  return { ws, got, until, say };
}
type Hello = Extract<ServerMessage, { type: 'hello' }>;
type Err = Extract<ServerMessage, { type: 'error' }>;
type History = Extract<ServerMessage, { type: 'history' }>;

describe('ws: set_sandbox (D2, existing GPT sessions)', () => {
  it('stores it, broadcasts `sandbox` to UIs that accept it (never to an older one), and the next history says it; Claude refused', async () => {
    const a = await client();
    const b = await client();
    const old = await client();
    expect((a.got.find((m) => m.type === 'hello') as Hello).features).toContain('sessionSandbox');
    a.say({ type: 'open_session', sessionId: GPT, accepts: ['sandbox'] });
    b.say({ type: 'open_session', sessionId: GPT, accepts: ['sandbox'] });
    old.say({ type: 'open_session', sessionId: GPT });
    expect((await a.until<History>((m) => m.type === 'history')).sandbox).toBe('read-only');
    await b.until((m) => m.type === 'history');
    await old.until((m) => m.type === 'history');

    a.say({ type: 'set_sandbox', sessionId: GPT, sandbox: 'workspace-write' });
    expect(await b.until((m) => m.type === 'sandbox')).toEqual({ type: 'sandbox', sessionId: GPT, sandbox: 'workspace-write' });
    await a.until((m) => m.type === 'sandbox');
    expect(store.get(GPT)).toMatchObject({ engine: 'codex', sandbox: 'workspace-write' });
    a.got.length = 0;
    a.say({ type: 'open_session', sessionId: GPT, accepts: ['sandbox'] });
    expect((await a.until<History>((m) => m.type === 'history')).sandbox).toBe('workspace-write');

    a.say({ type: 'set_sandbox', sessionId: CLAUDE, sandbox: 'workspace-write' });
    const err = await a.until<Err>((m) => m.type === 'error' && m.sessionId === CLAUDE);
    expect(err.message).toContain('GPT 세션에서만');
    expect(store.get(CLAUDE)).not.toHaveProperty('sandbox');
    await new Promise((r) => setTimeout(r, 50));
    expect(old.got.some((m) => m.type === 'sandbox')).toBe(false);
    expect(b.got.filter((m) => m.type === 'sandbox')).toHaveLength(1);
    for (const c of [a, b, old]) c.ws.close();
  });

  it('danger-full-access is not a sandbox: a schema error, nothing stored', async () => {
    const c = await client();
    c.ws.send(JSON.stringify({ type: 'set_sandbox', sessionId: GPT, sandbox: 'danger-full-access' }));
    await c.until((m) => m.type === 'error');
    expect(store.get(GPT)).toMatchObject({ sandbox: 'workspace-write' });
    c.ws.close();
  });
});
