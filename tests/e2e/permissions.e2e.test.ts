import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '../../src/shared/protocol';
import type { PermissionDecision } from '../../src/shared/turn-types';
import { cookieValueFor } from '../../src/server/auth';
import { projectSlug } from '../../src/server/sessions/slug';

// 이 세션 against the real CLI: an edit allowed for the session stays allowed on the next turn,
// a Bash command still prompts, and no settings file is ever written into the project.
// Account a is excluded (it stands in for the protected Desktop account):
// CLAUDE_PROTECT=a plus a long cooldown on a in the temp cooldown dir.

const PORT = 9500 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess;
let cfgDir: string;
let workDir: string;
let cookie: string;
let sessionId = '';
const home = os.homedir();
const roots = [path.join(home, '.claude/projects'), path.join(home, '.claude-b/projects'), path.join(home, '.claude-c/projects')];
type TurnResult = Extract<ServerMessage, { type: 'turn_result' }>;
type PermReq = Extract<ServerMessage, { type: 'permission_request' }>;

async function waitFor(fn: () => Promise<boolean>, ms: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('timeout');
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);

/** One turn on a fresh socket; every permission_request is answered with `answer`. */
async function turn(text: string, answer: PermissionDecision): Promise<{ result: TurnResult; asks: PermReq[] }> {
  // Messages are buffered from connection time (see turn.e2e.test.ts for the open/message race).
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookie, Origin: BASE } });
  const asks: PermReq[] = [];
  const result = await new Promise<TurnResult>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('turn timeout')), 150_000);
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      if (m.type === 'hello') ws.send(JSON.stringify({ type: 'send', sessionId: sessionId || null, cwd: workDir, text, model: 'sonnet' }));
      if (m.type === 'permission_request') {
        asks.push(m);
        ws.send(JSON.stringify({ type: 'permission_response', requestId: m.requestId, decision: answer }));
      }
      if (m.type === 'error') { clearTimeout(t); reject(new Error(m.message)); }
      if (m.type === 'turn_result') { clearTimeout(t); resolve(m); }
    });
    ws.once('error', reject);
  });
  ws.close();
  return { result, asks };
}

function report(n: number, r: { result: TurnResult; asks: PermReq[] }): void {
  const a = r.result.badge?.account.toUpperCase() ?? '?';
  const asked = r.asks.map((q) => `${q.toolName} allowSession=${q.allowSession} label=${JSON.stringify(q.sessionLabel)}`).join('; ');
  console.log(`permissions e2e turn ${n}: account ${a} · ${r.asks.length ? `prompted (${asked})` : 'no prompt'} · ok=${r.result.ok}`);
}

beforeAll(async () => {
  cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-e2e-perm-cfg-'));
  workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-e2e-perm-work-')));
  const cooldownDir = path.join(cfgDir, 'cooldown');
  await fs.mkdir(cooldownDir, { recursive: true });
  await fs.writeFile(path.join(cooldownDir, 'a'), String(Date.now() / 1000 + 86_400));
  // D13 (Plan 2): e2e runs Claude on B only — c is near its weekly limit.
  await fs.writeFile(path.join(cooldownDir, 'c'), String(Date.now() / 1000 + 86_400));
  child = spawn('npx', ['tsx', 'src/server/main.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, DECK_CONFIG_DIR: cfgDir, DECK_PORT: String(PORT), DECK_LOOPBACK_ONLY: '1', DECK_UI_DIR: cfgDir, DECK_EXTRA_CWD_ROOTS: path.dirname(workDir), CLAUDE_PICK_COOLDOWN_DIR: cooldownDir, CLAUDE_PROTECT: 'a' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitFor(async () => (await fetch(`${BASE}/api/me`)).status === 401, 30_000);
  const token = (await fs.readFile(path.join(cfgDir, 'token'), 'utf8')).trim();
  const res = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ token }) });
  expect(res.status).toBe(200);
  cookie = `deck_session=${cookieValueFor(token)}`;
});

afterAll(async () => {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10_000))]);
  }
  // Only the session this test created, by exact id; the project dir only if that leaves it empty.
  if (sessionId) {
    for (const r of roots) {
      const dir = path.join(r, projectSlug(workDir));
      await fs.rm(path.join(dir, `${sessionId}.jsonl`), { force: true });
      await fs.rm(path.join(dir, sessionId), { recursive: true, force: true });
      await fs.rmdir(dir).catch(() => {});
    }
  }
  await fs.rm(cfgDir, { recursive: true, force: true });
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('deck e2e: 이 세션 permissions (real accounts b/c)', () => {
  it('Write → 이 세션 carries over; Bash still prompts; no settings file is written', async () => {
    const t1 = await turn('Use the Write tool to create probe1.txt in the current directory with the content: one. Use no other tool. Then reply: done', 'session');
    sessionId = t1.result.sessionId ?? '';
    report(1, t1);
    expect(t1.result.ok).toBe(true);
    expect(['b', 'c']).toContain(t1.result.badge!.account);
    expect(t1.asks.length).toBeGreaterThan(0);
    expect(t1.asks[0]).toMatchObject({ toolName: 'Write', allowSession: true, sessionLabel: '이 세션 동안 파일 편집 허용' });
    expect(await exists(path.join(workDir, 'probe1.txt'))).toBe(true);
    expect(sessionId).not.toBe('');

    const t2 = await turn('Use the Write tool to create probe2.txt in the current directory with the content: two. Use no other tool. Then reply: done', 'deny');
    report(2, t2);
    expect(t2.result.ok).toBe(true);
    expect(t2.result.sessionId).toBe(sessionId);
    expect(['b', 'c']).toContain(t2.result.badge!.account);
    expect(t2.asks).toEqual([]);
    expect(await exists(path.join(workDir, 'probe2.txt'))).toBe(true);

    // Deviation from `touch probe3.txt` (evidence: the first run of this test): once the session
    // is in acceptEdits — the CLI's own "allow all edits this session", which is what 이 세션 on a
    // Write means — the CLI auto-allows plain filesystem commands like `touch` in the cwd, so that
    // turn never prompted. A Bash command outside acceptEdits' scope checks what this turn is for:
    // the session grant is not a blanket Bash allow, and a deny keeps the file from being made.
    const t3 = await turn(`Run exactly this Bash command: python3 -c "open('probe3.txt','w').close()"  (Bash tool only, no other tool; if it is denied reply: denied)`, 'deny');
    report(3, t3);
    expect(t3.result.sessionId).toBe(sessionId);
    expect(['b', 'c']).toContain(t3.result.badge!.account);
    expect(t3.asks.map((q) => q.toolName)).toContain('Bash');
    expect(await exists(path.join(workDir, 'probe3.txt'))).toBe(false);

    expect(await exists(path.join(workDir, '.claude', 'settings.local.json'))).toBe(false);
    expect(await exists(path.join(workDir, '.claude', 'settings.json'))).toBe(false);
  });
});
