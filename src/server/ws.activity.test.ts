import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { PinStore } from './sessions/PinStore';
import { SessionIndex } from './sessions/SessionIndex';
import { SettingsStore } from './settings';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket } from './ws';
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
/** Each test installs its own fake CLI process. */
let fake = fakeSdk();
const queryFn: QueryFn = (p) => fake.queryFn(p);

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wsact-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wsact-work-')));
  index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }) });
  store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const runner = new TurnRunner({ accounts: testRegistry(), attachments: null, engine: new ClaudeEngine({ accounts: testRegistry(), queryFn, readFile: async () => Buffer.from('') }), usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots), codex: null, codexSessionsRoot: path.join(base, 'codex') });
  const pins = new PinStore(path.join(base, 'pins.json'));
  await pins.load();
  const settings = new SettingsStore(path.join(base, 'settings.json'));
  await settings.load();
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  wsApi = attachWebSocket([server], { accounts: testRegistry(), token: TOKEN, devOrigins: [], runner, index, usage, store, codexAvailable: false, build: 'build-1', cwdRoots: [path.dirname(work)], pins, settings });
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

describe('ws: activity on every device', () => {
  it('broadcasts session activity, replays a running turn to a late device, and stops one task', async () => {
    const S = '55555555-5555-4555-8555-555555555555';
    const cwd = await seed(S, 'act1');
    fake = fakeSdk();
    const a = await client();
    await a.next('hello');
    const other = await client();
    expect(await other.next('hello')).toMatchObject({ activity: [], build: 'build-1' });

    a.send({ type: 'send', sessionId: S, cwd, text: 'go' });
    const t = await a.next('turn_started');
    // A device that has not opened the session still learns it runs (sidebar dot, tab title).
    expect(await other.next('activity', (m) => m.sessions.length === 1)).toMatchObject({ sessions: [{ sessionId: S, turnId: t.turnId, running: true, bg: 0 }] });

    fake.push(
      sdk.init(S), sdk.messageStart(), sdk.blockStart('tool_use'), sdk.agentCall(), sdk.messageDelta(40),
      sdk.agentStarted(), sdk.subToolCall(), sdk.subToolResult(), sdk.agentProgress(),
      // A patch carries no Agent call id; the replay must keep the one task_started gave.
      { type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'running' }, session_id: S },
    );
    expect(await a.next('turn_progress', (m) => m.outputTokens === 40)).toMatchObject({ turnId: t.turnId, phase: 'tool' });
    expect(await a.next('task_update', (m) => m.usage !== undefined)).toMatchObject({ taskId: 'a1', toolUseId: 'toolu_ag', usage: { totalTokens: 1200 } });
    // The subagent's tool call reaches the pane only as sub_tool_call — never as a main tool_call.
    expect(a.got.filter((m) => m.type === 'tool_call').map((m) => (m as { toolUseId: string }).toolUseId)).toEqual(['toolu_ag']);

    // Opening the session mid-turn: history with the elapsed time, then the replayed task, sub calls and progress.
    const late = await client();
    await late.next('hello');
    late.send({ type: 'open_session', sessionId: S });
    const h = await late.next('history');
    expect(h).toMatchObject({ runningTurnId: t.turnId });
    expect(h.runningForMs).toBeGreaterThanOrEqual(0);
    expect(await late.next('task_update')).toMatchObject({ taskId: 'a1', toolUseId: 'toolu_ag', description: 'count files', status: 'running', subagentType: 'general-purpose', usage: { totalTokens: 1200 }, sessionId: S });
    expect(await late.next('sub_tool_call')).toMatchObject({ parentToolUseId: 'toolu_ag', toolUseId: 'sub1', name: 'Bash' });
    expect(await late.next('sub_tool_result')).toMatchObject({ toolUseId: 'sub1', isError: false });
    expect(await late.next('turn_progress')).toMatchObject({ outputTokens: 40 });

    // A background command outlives the result: activity shows bg, the pill can stop it by id.
    fake.push(
      { type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'toolu_ag', status: 'completed', summary: '42', session_id: S },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'k', task_type: 'local_bash', description: 'sleep 20' }], session_id: S },
      sdk.result('waiting', S),
    );
    expect(await a.next('turn_background', (m) => m.tasks.length === 1)).toMatchObject({ canStop: true, detail: [{ id: 'k', type: 'local_bash', description: 'sleep 20' }] });
    await a.next('turn_result', (m) => m.turnId === t.turnId);
    expect(await other.next('activity', (m) => m.sessions[0]?.running === false)).toMatchObject({ sessions: [{ sessionId: S, running: false, bg: 1 }] });

    a.send({ type: 'stop_task', turnId: t.turnId, taskId: 'k' });
    expect(await a.next('task_done', (m) => m.taskId === 'k')).toMatchObject({ status: 'stopped' });
    expect(fake.stopped).toEqual(['k']);

    fake.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: S });
    fake.end();
    await a.next('turn_background', (m) => m.tasks.length === 0);
    // Activity clears when the process ends — no lingering indicator anywhere.
    expect(await other.next('activity', (m) => m.sessions.length === 0)).toMatchObject({ sessions: [] });
    a.close();
    other.close();
    late.close();
  });
});
