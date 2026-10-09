import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Account } from '../../shared/accounts';
import { AttachmentStore } from '../attachments/AttachmentStore';
import type { ServerMessage } from '../../shared/protocol';
import { StubEngine, failResult, okResult } from '../engine/StubEngine';
import type { CodexEngine, CodexTurnRequest } from '../engine/CodexEngine';
import type { GeminiTurnRequest } from '../engine/GeminiEngine';
import type { GeminiAccount } from '../../shared/accounts';
import type { EngineEvent } from '../engine/Engine';
import { readCooldownUntilMs } from '../routing/cooldown';
import { CODEX_ARCHIVED_NOTICE } from '../sessions/CodexImports';
import { SessionIndex } from '../sessions/SessionIndex';
import { projectSlug } from '../sessions/slug';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore, type ClaudeSessionState } from './SessionState';
import { SHUTDOWN_ABORT, SHUTDOWN_ABORTED, TurnRunner, type TurnRunnerDeps, type TurnSink } from './TurnRunner';
import { rootsOf, testRegistry } from '../../shared/accounts.testkit';

const NOW = Date.parse('2026-09-30T12:30:00Z');
const SID = '11111111-1111-4111-8111-111111111111';

function card(id: string, s: number, w: number, f: number, resetH: number) {
  const resetsAt = new Date(NOW + resetH * 3_600_000).toISOString();
  return { id, status: 'ok', fetchedAt: new Date(NOW - 10_000).toISOString(), rows: [
    { label: 'Session (5h)', used: s, resetsAt }, { label: 'Weekly (7d)', used: w, resetsAt }, { label: 'Fable (7d)', used: f, resetsAt } ] };
}

async function usageWith(a: [number, number, number], b: [number, number, number], c: [number, number, number]) {
  const state = { cards: [card('claude:main', ...a, 154), card('claude:second', ...b, 84), card('claude:third', ...c, 36)] };
  const u = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => state }), now: () => new Date(NOW) });
  await u.pollOnce();
  return u;
}

type Ctx = { deps: TurnRunnerDeps; base: string; msgs: ServerMessage[]; sink: TurnSink; roots: Record<Account, string>; moves: unknown[] };

async function ctx(engine: StubEngine, over: Partial<TurnRunnerDeps> = {}, usage?: UsageService): Promise<Ctx> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-tr-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') } as Record<Account, string>;
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'projects.json') });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const moves: unknown[] = [];
  const deps: TurnRunnerDeps = {
    accounts: testRegistry(),
    engine,
    usage: usage ?? (await usageWith([13, 7, 0], [2, 3, 4], [0, 91, 27])),
    index,
    store,
    cooldownDir: path.join(base, 'cooldown'),
    protectedAccount: 'a',
    auditFile: path.join(base, 'audit.log'),
    projectsRoots: rootsOf(roots),
    codex: null,
    attachments: null,
    codexSessionsRoot: path.join(base, 'codex-sessions'),
    move: async (o) => { moves.push(o); return { ok: true, targetDir: path.join(o.targetProjectsRoot, path.basename(o.sourceProjectDir)), targetFile: '', copied: [] }; },
    now: () => NOW,
    maxRetries: 2,
    ...over,
  };
  const msgs: ServerMessage[] = [];
  const sink: TurnSink = { emit: (m) => msgs.push(m), askPermission: async () => 'once', askQuestion: async () => null, signal: new AbortController().signal };
  return { deps, base, msgs, sink, roots, moves };
}

async function seedSession(c: Ctx, account: Account, cwd = '/w/one') {
  const dir = path.join(c.roots[account]!, '-w-one');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${SID}.jsonl`), JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'seed' } }) + '\n');
  await c.deps.index.refresh();
  return dir;
}

const ok = (sid: string, extra: EngineEvent[] = []): EngineEvent[] => [{ kind: 'init', sessionId: sid, model: 'claude-opus-5-5' }, { kind: 'delta', text: 'ok' }, ...extra, okResult(sid)];

describe('TurnRunner', () => {
  let msgsOf: (c: Ctx, t: ServerMessage['type']) => ServerMessage[];
  beforeEach(() => { msgsOf = (c, t) => c.msgs.filter((m) => m.type === t); });

  it('new session: routes to the best account, streams, stores state, applies usage', async () => {
    const eng = new StubEngine(() => ok('new1', [{ kind: 'rate_limit', info: { status: 'allowed', fiveHour: { usedPct: 9, resetsAt: null }, weekly: { usedPct: 4, resetsAt: null } } }]));
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect(eng.calls[0]).toMatchObject({ account: 'b', resumeSessionId: null, model: 'fable', cwd: '/w/new', prompt: 'hi' });
    expect(msgsOf(c, 'turn_started')[0]).toMatchObject({ turnId: 't1', account: 'b', model: 'fable', attempt: 0 });
    expect(msgsOf(c, 'delta')).toEqual([{ type: 'delta', turnId: 't1', sessionId: 'new1', cwd: '/w/new', text: 'ok' }]);
    const res = msgsOf(c, 'turn_result')[0];
    expect(res).toMatchObject({ type: 'turn_result', ok: true, sessionId: 'new1', text: 'ok', badge: { account: 'b', model: 'fable', usage: { outputTokens: 4 } } });
    expect(c.deps.store.get('new1')).toMatchObject({ account: 'b', cwd: '/w/new', lastTurnAtMs: NOW, projectDir: path.join(c.roots.b!, '-w-new') });
    expect(c.deps.usage.snapshot().accounts.b!.fiveHour?.usedPct).toBe(9);
  });

  it('자동 routing policy: balance by default, drain from the setting; one route log line; a good turn lifts a down card', async () => {
    // a (protected, a normal candidate): 5h 13 / weekly 7; b: 5h 20 / weekly 3 (resets in 84h); c: 5h 0 / weekly 70
    // (resets in 36h) → balance picks c (runner-up a), drain picks b.
    const usage = await usageWith([13, 7, 0], [20, 3, 4], [0, 70, 27]);
    const lines: string[] = [];
    const eng = new StubEngine(() => ok('new1'));
    const c = await ctx(eng, { routeLog: (l) => lines.push(l) }, usage);
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect(eng.calls[0]).toMatchObject({ account: 'c' });
    expect(msgsOf(c, 'turn_started')[0]).toMatchObject({ reason: '새 세션 · 분산: 5h C 0% < A 13%' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^deck: route 새 세션 → C \(새 세션 · 분산: 5h C 0% < A 13%\) · 후보 /);
    const eng2 = new StubEngine(() => ok('new2'));
    const d = await ctx(eng2, { routingPolicy: () => 'drain' }, usage);
    await new TurnRunner(d.deps).run({ turnId: 't2', cwd: '/w/new', sessionId: null, text: 'hi' }, d.sink);
    expect(eng2.calls[0]).toMatchObject({ account: 'b' });
    // setup_needed card for b (down) — deck's own successful turn on b lifts it for routing.
    const down = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [card('claude:main', 13, 7, 0, 154), { ...card('claude:second', 2, 3, 4, 84), status: 'setup_needed' }, card('claude:third', 0, 91, 27, 36)] }) }), now: () => new Date(NOW) });
    await down.pollOnce();
    expect(down.snapshot().accounts.b!.status).toBe('down');
    // Pinned to b, so the turn runs there even though routing would skip a down card.
    const e = await ctx(new StubEngine(() => ok('new3')), {}, down);
    await new TurnRunner(e.deps).run({ turnId: 't3', cwd: '/w/new', sessionId: null, text: 'hi', accountPin: 'b' }, e.sink);
    expect(msgsOf(e, 'turn_result')[0]).toMatchObject({ ok: true, badge: { account: 'b' } });
    // Routing now takes b; the UI still shows b's real setup_needed (down) status.
    expect(down.routingSnapshot().accounts.b).toMatchObject({ status: 'ok', weekly: { usedPct: 3 } });
    expect(down.snapshot().accounts.b!.status).toBe('down');
    // An unpinned new session now routes to b (lowest 5h among safe: a 13 protected, b 2, c weekly 91 ≥ 85).
    const eng4 = new StubEngine(() => ok('new4'));
    const f = await ctx(eng4, {}, down);
    await new TurnRunner(f.deps).run({ turnId: 't4', cwd: '/w/new', sessionId: null, text: 'hi' }, f.sink);
    expect(eng4.calls[0]).toMatchObject({ account: 'b' });
  });

  it('new session in a symlinked cwd: projectDir comes from the CLI-reported (real) cwd', async () => {
    let c!: Ctx;
    const eng = new StubEngine(async (req) => {
      const real = await fs.realpath(req.cwd); // what the CLI does before slugging
      const dir = path.join(c.roots[req.account]!, projectSlug(real));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'sym1.jsonl'), '{}\n');
      return [{ kind: 'init', sessionId: 'sym1', model: 'm', cwd: real }, okResult('sym1')];
    });
    c = await ctx(eng);
    const realParent = path.join(c.base, 'real');
    await fs.mkdir(path.join(realParent, 'proj'), { recursive: true });
    await fs.symlink(realParent, path.join(c.base, 'link'));
    const linked = path.join(c.base, 'link', 'proj');
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: linked, sessionId: null, text: 'hi' }, c.sink);
    const expected = path.join(c.roots.b!, projectSlug(await fs.realpath(linked)));
    expect(projectSlug(linked)).not.toBe(projectSlug(await fs.realpath(linked)));
    expect((c.deps.store.get('sym1') as ClaudeSessionState | null)?.projectDir).toBe(expected);
  });

  it('new session: when the slugged dir has no jsonl, the account root is searched for it', async () => {
    let c!: Ctx;
    const eng = new StubEngine(async (req) => {
      // e.g. the CLI spelled 작업 in NFD while we hold NFC — simulate with an unrelated dir name
      const dir = path.join(c.roots[req.account]!, '-somewhere-else');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'far1.jsonl'), '{}\n');
      return [{ kind: 'init', sessionId: 'far1', model: 'm' }, okResult('far1')];
    });
    c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect((c.deps.store.get('far1') as ClaudeSessionState | null)?.projectDir).toBe(path.join(c.roots.b!, '-somewhere-else'));
  });

  it('imported session on a (cold) moves to b, then resumes there', async () => {
    const eng = new StubEngine(() => ok(SID));
    const c = await ctx(eng);
    const srcDir = await seedSession(c, 'a');
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/one', sessionId: SID, text: 'go' }, c.sink);
    expect(c.moves).toEqual([{ sessionId: SID, sourceProjectDir: srcDir, targetProjectsRoot: c.roots.b }]);
    expect(eng.calls[0]).toMatchObject({ account: 'b', resumeSessionId: SID });
    expect(c.deps.store.get(SID)).toMatchObject({ account: 'b', projectDir: path.join(c.roots.b!, '-w-one') });
    expect(msgsOf(c, 'turn_started')[0]).toMatchObject({ reason: expect.stringContaining('캐시 식음') });
  });

  it('warm session stays; a failed move cancels the switch', async () => {
    const eng = new StubEngine(() => ok(SID));
    const c = await ctx(eng);
    const srcDir = await seedSession(c, 'a');
    await c.deps.store.set({ sessionId: SID, cwd: '/w/one', account: 'a', projectDir: srcDir, lastTurnAtMs: NOW - 60_000, justCompacted: false, defaultModel: 'opus' });
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/one', sessionId: SID, text: 'go' }, c.sink);
    expect(c.moves).toEqual([]);
    expect(eng.calls[0]?.account).toBe('a');

    const eng2 = new StubEngine(() => ok(SID));
    const c2 = await ctx(eng2, { move: async () => ({ ok: false, error: 'disk full' }) });
    const src2 = await seedSession(c2, 'a');
    await c2.deps.store.set({ sessionId: SID, cwd: '/w/one', account: 'a', projectDir: src2, lastTurnAtMs: null, justCompacted: false, defaultModel: 'opus' });
    await new TurnRunner(c2.deps).run({ turnId: 't', cwd: '/w/one', sessionId: SID, text: 'go' }, c2.sink);
    expect(eng2.calls[0]?.account).toBe('a');
    expect(msgsOf(c2, 'turn_notice')[0]).toMatchObject({ turnId: 't', message: expect.stringContaining('B 계정으로 옮기지 못해 A 계정에서 이어가요') });
    expect(msgsOf(c2, 'error')).toEqual([]);
    expect(msgsOf(c2, 'turn_result')[0]).toMatchObject({ ok: true, badge: { account: 'a' } });
  });

  it('an engine notice carrying a token-shaped string arrives redacted (review finding 1)', async () => {
    const eng = new StubEngine(() => ok('new2', [{ kind: 'notice', message: 'sk-ant-abc123def456ghi789jkl secret leaked' }]));
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    const notice = msgsOf(c, 'turn_notice')[0];
    expect(notice).toMatchObject({ type: 'turn_notice', turnId: 't' });
    expect((notice as { message: string }).message).not.toContain('sk-ant-abc123def456ghi789jkl');
    expect((notice as { message: string }).message).toContain('[redacted]');
  });

  it('a system event (hook feedback…) becomes turn_system on the running turn (redacted), not a user message', async () => {
    const eng = new StubEngine(() => ok('new3', [{ kind: 'system', source: 'Stop', label: 'Stop 훅이 이어서 진행시킴', text: 'Stop hook feedback:\nsk-ant-abc123def456ghi789jkl 계속' }]));
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    const hook = msgsOf(c, 'turn_system')[0];
    expect(hook).toMatchObject({ type: 'turn_system', turnId: 't', source: 'Stop', label: 'Stop 훅이 이어서 진행시킴' });
    expect((hook as { text: string }).text).toContain('[redacted]');
    expect((hook as { text: string }).text).not.toContain('sk-ant-abc123def456ghi789jkl');
  });

  it('a secret split across thinking deltas arrives redacted; held text is flushed before the reply, no empty chunks', async () => {
    const key = 'sk-ant-api03-AbCdEf0123456789_xyzQRST';
    for (let i = 1; i < key.length; i++) {
      const eng = new StubEngine(() => [
        { kind: 'init', sessionId: 'th1', model: 'm' },
        { kind: 'thinking', text: '' },
        { kind: 'thinking', text: `키는 ${key.slice(0, i)}` },
        { kind: 'progress', outputTokens: 3, phase: 'thinking' },
        { kind: 'thinking', text: `${key.slice(i)} 입니다` },
        { kind: 'delta', text: 'ok' },
        okResult('th1'),
      ]);
      const c = await ctx(eng);
      await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
      const th = msgsOf(c, 'thinking') as { text: string }[];
      expect(th[0]?.text).toBe('');
      expect(th.slice(1).every((m) => m.text !== '')).toBe(true);
      expect(th.map((m) => m.text).join('')).toBe('키는 [redacted] 입니다');
      const order = c.msgs.map((m) => m.type).filter((t) => t === 'thinking' || t === 'delta');
      expect(order.lastIndexOf('thinking')).toBeLessThan(order.indexOf('delta'));
    }
  });

  it('an engine stream that throws mid-thinking still delivers the held tail, redacted', async () => {
    const eng = new StubEngine(() => (async function* () {
      yield { kind: 'init', sessionId: 'th2', model: 'm' } as const;
      yield { kind: 'thinking', text: '' } as const;
      yield { kind: 'thinking', text: '마지막 생각 sk-ant-api03-AbCdEf0123456789_xyz' } as const;
      throw new Error('stream broke');
    })());
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink).catch(() => undefined);
    const th = (msgsOf(c, 'thinking') as { text: string }[]).map((m) => m.text);
    expect(th.join('')).toBe('마지막 생각 [redacted]');
    expect(th.join('')).not.toContain('AbCdEf');
  });

  it('limit on first account → cooldown, move, retry on next; auth failure likewise; third failure ends', async () => {
    const eng = new StubEngine((req, call) => {
      if (call === 0) return [{ kind: 'init', sessionId: 'n1', model: 'm' }, { kind: 'rate_limit', info: { status: 'rejected', fiveHour: null, weekly: null } }, failResult('limit', { sessionId: 'n1' })];
      if (call === 1) return [{ kind: 'init', sessionId: 'n1', model: 'm' }, failResult('Failed to authenticate. API Error: 401 OAuth access token has been revoked.', { sessionId: 'n1' })];
      return ok('n1');
    });
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    // b limited → a (protected, but the one account with room; c is at weekly 91) → a's auth fails → c.
    expect(eng.calls.map((r) => r.account)).toEqual(['b', 'a', 'c']);
    expect(readCooldownUntilMs(c.deps.cooldownDir, 'b', NOW)).toBe(NOW + 3_600_000);
    expect(readCooldownUntilMs(c.deps.cooldownDir, 'a', NOW)).toBe(NOW + 6 * 3_600_000);
    expect(msgsOf(c, 'turn_retry')).toMatchObject([{ fromAccount: 'b', toAccount: 'a', attempt: 1 }, { fromAccount: 'a', toAccount: 'c', attempt: 2 }]);
    expect(c.moves.map((m) => (m as { targetProjectsRoot: string }).targetProjectsRoot)).toEqual([c.roots.a, c.roots.c]);
    expect(msgsOf(c, 'turn_result')[0]).toMatchObject({ ok: true, badge: { account: 'c' } });

    const eng3 = new StubEngine(() => [failResult('usage limit reached')]);
    const c3 = await ctx(eng3);
    await new TurnRunner(c3.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c3.sink);
    expect(eng3.calls).toHaveLength(3);
    expect(msgsOf(c3, 'turn_result')[0]).toMatchObject({ ok: false, errorText: expect.stringContaining('usage limit') });
  });

  it('errorText shown to the UI is truncated and has token-shaped strings redacted', async () => {
    const secret = 'sk-ant-oat01-' + 'Ab3'.repeat(20);
    const eng = new StubEngine(() => [failResult(`boom Authorization: Bearer ${secret}`, { stderr: `token=${'9f'.repeat(30)}\n` + 'y'.repeat(10_000) })]);
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    const r = msgsOf(c, 'turn_result')[0] as Extract<ServerMessage, { type: 'turn_result' }>;
    expect(r.errorText).toContain('boom');
    expect(r.errorText).not.toContain(secret);
    expect(r.errorText).not.toContain('9f'.repeat(30));
    expect(r.errorText).toContain('[redacted]');
    expect(r.errorText!.length).toBeLessThan(3000);
  });

  it('retry: when the move to the next account is refused, that account is skipped and the one after is used', async () => {
    const eng = new StubEngine((req) => (req.account === 'a' ? [failResult('API Error: 429 rate limit reached', { sessionId: SID })] : ok(SID)));
    const c = await ctx(eng, {
      move: async (o) => {
        if (o.targetProjectsRoot === c.roots.b) return { ok: false, error: 'target busy' };
        return { ok: true, targetDir: path.join(o.targetProjectsRoot, path.basename(o.sourceProjectDir)), targetFile: '', copied: [] };
      },
    });
    const srcDir = await seedSession(c, 'a');
    await c.deps.store.set({ sessionId: SID, cwd: '/w/one', account: 'a', projectDir: srcDir, lastTurnAtMs: NOW - 60_000, justCompacted: false, defaultModel: 'opus' });
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/one', sessionId: SID, text: 'go' }, c.sink);
    expect(eng.calls.map((r) => r.account)).toEqual(['a', 'c']);
    expect(msgsOf(c, 'turn_retry')).toMatchObject([{ fromAccount: 'a', toAccount: 'c', attempt: 1 }]);
    expect(msgsOf(c, 'turn_result')[0]).toMatchObject({ ok: true, badge: { account: 'c' } });
    expect(c.deps.store.get(SID)).toMatchObject({ account: 'c' });
  });

  it('other failures do not retry', async () => {
    const eng = new StubEngine(() => [failResult('error_max_turns: too many')]);
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect(eng.calls).toHaveLength(1);
    expect(msgsOf(c, 'turn_result')[0]).toMatchObject({ ok: false });
    expect(msgsOf(c, 'turn_retry')).toEqual([]);
  });

  it('relays permission requests to the sink and audits them without the input', async () => {
    const eng = new StubEngine(async (req) => {
      const d = await req.onPermission({ toolName: 'Write', input: { file_path: '/secret', content: 'TOKEN=abc' }, toolUseId: 'tu1' });
      return ok('p1', [{ kind: 'delta', text: d }]);
    });
    const c = await ctx(eng);
    const asked: unknown[] = [];
    c.sink.askPermission = async (r) => { asked.push(r); return 'deny'; };
    await new TurnRunner(c.deps).run({ turnId: 't9', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect(asked).toEqual([{ turnId: 't9', sessionId: null, cwd: '/w/new', toolName: 'Write', input: { file_path: '/secret', content: 'TOKEN=abc' }, toolUseId: 'tu1' }]);
    expect(msgsOf(c, 'delta').map((m) => (m as { text: string }).text)).toEqual(['ok', 'deny']);
    const audit = await fs.readFile(c.deps.auditFile, 'utf8');
    expect(audit).toContain('"toolName":"Write"');
    expect(audit).toContain('"decision":"deny"');
    expect(audit).not.toContain('TOKEN=abc');
  });

  it('a failing audit write does not lose the permission decision', async () => {
    const eng = new StubEngine(async (req) => ok('p2', [{ kind: 'delta', text: await req.onPermission({ toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'tu', signal: new AbortController().signal }) }]));
    const c = await ctx(eng);
    await fs.mkdir(c.deps.auditFile, { recursive: true }); // appendFile on a directory → EISDIR
    c.sink.askPermission = async () => 'once';
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect(msgsOf(c, 'delta').map((m) => (m as { text: string }).text)).toEqual(['ok', 'once']);
    expect(msgsOf(c, 'turn_result')[0]).toMatchObject({ ok: true });
  });

  it('an already-aborted turn never reaches the engine', async () => {
    const eng = new StubEngine(() => ok('x'));
    const c = await ctx(eng);
    const ac = new AbortController();
    ac.abort();
    c.sink.signal = ac.signal;
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect(eng.calls).toHaveLength(0);
    expect(msgsOf(c, 'turn_result')[0]).toMatchObject({ ok: false, errorText: expect.stringContaining('중단') });
  });

  it('allow-for-session on turn 1 pre-allows the same scoped action on turn 2; a different command still prompts', async () => {
    const ruleOf = (cmd: string) => `Bash(${cmd})`;
    // Emulates the CLI: prompt unless a pre-allowed rule matches this exact command.
    const eng = new StubEngine(async (req) => {
      const cmd = req.prompt;
      let d = 'preallowed';
      if (!(req.allowRules ?? []).includes(ruleOf(cmd))) {
        d = await req.onPermission({ toolName: 'Bash', input: { command: cmd }, toolUseId: 'tu', suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: cmd }], behavior: 'allow', destination: 'session' }] });
      }
      return ok('perm1', [{ kind: 'delta', text: d }]);
    });
    const c = await ctx(eng);
    const asked: string[] = [];
    c.sink.askPermission = async (r) => { asked.push(String(r.input.command)); return 'session'; };
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'git status' }, c.sink);
    expect((c.deps.store.get('perm1') as ClaudeSessionState | null)?.allowRules).toEqual(['Bash(git status)']);
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: 'perm1', text: 'git status' }, c.sink);
    expect(asked).toEqual(['git status']);
    expect(eng.calls[1]?.allowRules).toEqual(['Bash(git status)']);
    await runner.run({ turnId: 't3', cwd: '/w/new', sessionId: 'perm1', text: 'rm -rf build' }, c.sink);
    expect(asked).toEqual(['git status', 'rm -rf build']);
  });

  it('once, deny, or a suppressed session allow store nothing', async () => {
    const eng = new StubEngine(async (req) => {
      await req.onPermission({ toolName: 'Bash', input: { command: 'x' }, toolUseId: 'tu', suppressAlwaysAllowRule: true, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] });
      return ok('perm2');
    });
    const c = await ctx(eng);
    c.sink.askPermission = async () => 'session';
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'x' }, c.sink);
    expect((c.deps.store.get('perm2') as ClaudeSessionState | null)?.allowRules ?? []).toEqual([]);
  });

  // Real CLI suggestion shapes (captured on account b with deck's buildOptions).
  const REAL_WRITE = [{ type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const }];
  const realBash = (cmd: string) => [
    { type: 'addRules' as const, rules: [{ toolName: 'Bash', ruleContent: cmd }], behavior: 'allow' as const, destination: 'localSettings' as const },
    { type: 'addDirectories' as const, directories: ['/w/new/sub'], destination: 'session' as const },
    { type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const },
  ];

  it('Write → 이 세션 (real setMode suggestion): stored as mode acceptEdits, later turns run in acceptEdits and do not prompt', async () => {
    // Emulates the CLI: Write prompts unless the session runs in acceptEdits.
    const eng = new StubEngine(async (req) => {
      if (req.permissionMode !== 'acceptEdits') await req.onPermission({ toolName: 'Write', input: { file_path: '/w/new/p.txt' }, toolUseId: 'tu', suggestions: REAL_WRITE });
      return ok('permW');
    });
    const c = await ctx(eng);
    let asked = 0;
    c.sink.askPermission = async () => { asked++; return 'session'; };
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'write' }, c.sink);
    expect(eng.calls[0]?.permissionMode).toBeUndefined();
    expect(c.deps.store.get('permW')).toMatchObject({ mode: 'acceptEdits' });
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: 'permW', text: 'write' }, c.sink);
    expect(eng.calls[1]?.permissionMode).toBe('acceptEdits');
    expect(asked).toBe(1);
  });

  it('Bash → 이 세션 (real addRules localSettings + addDirectories + setMode): rule, directory and mode are kept for later turns', async () => {
    let n = 0;
    const eng = new StubEngine(async (req) => {
      if (n++ === 0) await req.onPermission({ toolName: 'Bash', input: { command: 'touch s3.txt' }, toolUseId: 'tu', suggestions: realBash('touch s3.txt') });
      return ok('permB');
    });
    const c = await ctx(eng);
    c.sink.askPermission = async () => 'session';
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'x' }, c.sink);
    expect(c.deps.store.get('permB')).toMatchObject({ allowRules: ['Bash(touch s3.txt)'], allowDirs: ['/w/new/sub'], mode: 'acceptEdits' });
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: 'permB', text: 'x' }, c.sink);
    expect(eng.calls[1]).toMatchObject({ allowRules: ['Bash(touch s3.txt)'], allowDirs: ['/w/new/sub'], permissionMode: 'acceptEdits' });
  });

  it('bypassPermissions and unknown suggestion kinds are never persisted', async () => {
    const eng = new StubEngine(async (req) => {
      await req.onPermission({ toolName: 'Bash', input: { command: 'x' }, toolUseId: 'tu', suggestions: [
        { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        { type: 'removeDirectories', directories: ['/'], destination: 'session' },
        { type: 'somethingNew', destination: 'userSettings' } as never,
      ] });
      return ok('permX');
    });
    const c = await ctx(eng);
    c.sink.askPermission = async () => 'session';
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'x' }, c.sink);
    const st = c.deps.store.get('permX') as ClaudeSessionState | null;
    expect(st?.mode).toBe('default');
    expect(st?.allowRules).toBeUndefined();
    expect(st?.allowDirs).toBeUndefined();
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: 'permX', text: 'x' }, c.sink);
    expect(eng.calls[1]?.permissionMode).toBeUndefined();
  });

  it('fable with no account having room is downgraded to opus with a note', async () => {
    const eng = new StubEngine(() => ok('f1'));
    const c = await ctx(eng, {}, await usageWith([13, 7, 85], [2, 3, 90], [0, 50, 80]));
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi', model: 'fable' }, c.sink);
    expect(eng.calls[0]?.model).toBe('opus');
    expect(msgsOf(c, 'turn_result')[0]).toMatchObject({ badge: { model: 'opus', modelNote: expect.stringContaining('Fable') } });
  });

  it('a turn cut by the server shutting down says so (not 중단됨, which the UI hides) — mid-run and before its first attempt', async () => {
    const ac = new AbortController();
    const eng = new StubEngine(() => { ac.abort(SHUTDOWN_ABORT); return [{ kind: 'init', sessionId: 'y1', model: 'm' }, failResult('Claude Code process aborted by user', { sessionId: 'y1' })]; });
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, { ...c.sink, signal: ac.signal });
    expect(msgsOf(c, 'turn_result')).toMatchObject([{ ok: false, errorText: SHUTDOWN_ABORTED }]);
    const ac2 = new AbortController();
    ac2.abort(SHUTDOWN_ABORT);
    const eng2 = new StubEngine(() => ok('y2'));
    const c2 = await ctx(eng2);
    await new TurnRunner(c2.deps).run({ turnId: 't2', cwd: '/w/new', sessionId: null, text: 'hi' }, { ...c2.sink, signal: ac2.signal });
    expect(eng2.calls).toHaveLength(0);
    expect(msgsOf(c2, 'turn_result')).toMatchObject([{ ok: false, errorText: SHUTDOWN_ABORTED }]);
    expect(SHUTDOWN_ABORTED).not.toBe('중단됨');
  });

  it('a turn the user stopped reports 중단됨 (no SDK text, no stderr tail); a real failure keeps its error', async () => {
    const ac = new AbortController();
    const eng = new StubEngine(() => { ac.abort(); return [{ kind: 'init', sessionId: 'x1', model: 'm' }, failResult('Claude Code process aborted by user', { sessionId: 'x1', stderr: 'at Query.readMessages (sdk.mjs:1)\nError: aborted' })]; });
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, { ...c.sink, signal: ac.signal });
    expect(msgsOf(c, 'turn_result')).toMatchObject([{ ok: false, errorText: '중단됨' }]);
    const eng2 = new StubEngine(() => [{ kind: 'init', sessionId: 'x2', model: 'm' }, failResult('boom', { sessionId: 'x2' })]);
    const c2 = await ctx(eng2);
    await new TurnRunner(c2.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c2.sink);
    expect(msgsOf(c2, 'turn_result')).toMatchObject([{ ok: false, errorText: 'boom' }]);
  });

  it('default model: a new session with no model runs on Fable; Fable ≥80% everywhere → Opus, never a failure', async () => {
    const eng = new StubEngine(() => ok('d1'));
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect(eng.calls[0]?.model).toBe('fable');
    expect(c.deps.store.get('d1')).toMatchObject({ defaultModel: 'fable' });
    const eng2 = new StubEngine(() => ok('d2'));
    const c2 = await ctx(eng2, {}, await usageWith([13, 7, 85], [2, 3, 90], [0, 50, 80]));
    await new TurnRunner(c2.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c2.sink);
    expect(eng2.calls[0]?.model).toBe('opus');
    expect(msgsOf(c2, 'turn_result')[0]).toMatchObject({ ok: true, badge: { model: 'opus', modelNote: expect.stringContaining('Fable') } });
    // The router still picked a usable account (not the protected one) though no account is Fable-eligible.
    expect(eng2.calls[0]?.account).toBe('b');
  });

  it('a session deck did not start (index only) defaults to Fable, like a new one', async () => {
    const eng = new StubEngine(() => ok(SID));
    const c = await ctx(eng);
    await seedSession(c, 'b');
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/one', sessionId: SID, text: 'hi' }, c.sink);
    expect(eng.calls[0]?.model).toBe('fable');
    expect(c.deps.store.get(SID)).toMatchObject({ defaultModel: 'fable' });
  });

  it('the picker\'s model sticks: a send with a model makes it the session\'s default; 자동 later keeps it', async () => {
    const eng = new StubEngine(() => ok(SID));
    const c = await ctx(eng);
    const srcDir = await seedSession(c, 'b');
    await c.deps.store.set({ sessionId: SID, cwd: '/w/one', account: 'b', projectDir: srcDir, lastTurnAtMs: null, justCompacted: false, defaultModel: 'opus' });
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w/one', sessionId: SID, text: 'hi', model: 'fable' }, c.sink);
    expect(eng.calls[0]?.model).toBe('fable');
    expect(c.deps.store.get(SID)).toMatchObject({ defaultModel: 'fable' });
    // Other panes and devices learn the new default from turn_started.
    expect(msgsOf(c, 'turn_started')[0]).toMatchObject({ model: 'fable', sessionModel: 'fable' });
    await new TurnRunner(c.deps).run({ turnId: 't2', cwd: '/w/one', sessionId: SID, text: 'hi', model: 'auto' }, c.sink);
    expect(eng.calls[1]?.model).toBe('fable');
    expect(c.deps.store.get(SID)).toMatchObject({ defaultModel: 'fable' });
  });

  it('a Fable pick downgraded for one turn (Fable ≥80%) still sticks as Fable', async () => {
    const eng = new StubEngine(() => ok(SID));
    const c = await ctx(eng, {}, await usageWith([13, 7, 85], [2, 3, 90], [0, 50, 80]));
    const srcDir = await seedSession(c, 'b');
    await c.deps.store.set({ sessionId: SID, cwd: '/w/one', account: 'b', projectDir: srcDir, lastTurnAtMs: null, justCompacted: false, defaultModel: 'opus' });
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/one', sessionId: SID, text: 'hi', model: 'fable' }, c.sink);
    expect(eng.calls[0]?.model).toBe('opus');
    expect(c.deps.store.get(SID)).toMatchObject({ defaultModel: 'fable' });
  });

  it('a send without a model runs on the session\'s stored default (the pane picked none)', async () => {
    const eng = new StubEngine(() => ok(SID));
    const c = await ctx(eng);
    const srcDir = await seedSession(c, 'b');
    await c.deps.store.set({ sessionId: SID, cwd: '/w/one', account: 'b', projectDir: srcDir, lastTurnAtMs: null, justCompacted: false, defaultModel: 'sonnet' });
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/one', sessionId: SID, text: 'hi' }, c.sink);
    expect(eng.calls[0]?.model).toBe('sonnet');
  });

  it('audits every tool call once with its decision source (rule / user / auto)', async () => {
    const eng = new StubEngine(async (req) => {
      await req.onToolAudit?.({ toolName: 'Read', input: { file_path: '/x', secret: 'TOKEN=abc' }, toolUseId: 'r1', decision: 'allow', source: 'cli' });
      await req.onToolAudit?.({ toolName: 'Bash', input: { command: 'rm' }, toolUseId: 'r2', decision: 'deny', source: 'rule' });
      await req.onPermission({ toolName: 'Write', input: { file_path: '/y' }, toolUseId: 'u1' });
      return ok('au1');
    });
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 'tA', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    const raw = await fs.readFile(c.deps.auditFile, 'utf8');
    expect(raw).not.toContain('TOKEN=abc');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as { toolName: string; decision: string; source: string; turnId: string });
    expect(lines.map((l) => [l.toolName, l.decision, l.source, l.turnId])).toEqual([['Read', 'allow', 'cli', 'tA'], ['Bash', 'deny', 'rule', 'tA'], ['Write', 'once', 'user', 'tA']]);
  });

  it('effort travels to the Claude engine and survives a Fable → Opus downgrade; absent → no effort', async () => {
    const eng = new StubEngine(() => ok('e1'));
    const c = await ctx(eng, {}, await usageWith([13, 7, 85], [2, 3, 90], [0, 50, 80]));
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi', model: 'fable', effort: 'xhigh' }, c.sink);
    expect(eng.calls[0]).toMatchObject({ model: 'opus', effort: 'xhigh' });
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: null, text: 'hi', model: 'sonnet' }, c.sink);
    expect(eng.calls[1]).not.toHaveProperty('effort');
  });

  it('자동: the first turn picks the model and effort from the prompt; later 자동 turns keep the session model', async () => {
    const eng = new StubEngine(() => ok('auto1'));
    const c = await ctx(eng);
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: '이 함수 이름 뭐야?', model: 'auto' }, c.sink);
    expect(eng.calls[0]).toMatchObject({ model: 'sonnet', effort: 'medium' });
    expect(msgsOf(c, 'turn_started')[0]).toMatchObject({ model: 'sonnet', reason: expect.stringMatching(/^자동 → Sonnet 5\.5 · 짧은 조회/) });
    expect(c.deps.store.get('auto1')).toMatchObject({ defaultModel: 'sonnet' });
    // A later 자동 turn with a "hard" prompt does not switch models mid-session.
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: 'auto1', text: '보안 취약점 검토해줘', model: 'auto' }, c.sink);
    expect(eng.calls[1]).toMatchObject({ model: 'sonnet', effort: 'medium' });
    // An explicit effort wins over the automatic one.
    await runner.run({ turnId: 't3', cwd: '/w/new', sessionId: null, text: '버그 고쳐줘', model: 'auto', effort: 'low' }, c.sink);
    expect(eng.calls[2]).toMatchObject({ model: 'opus', effort: 'low' });
  });

  it('unknown session id → error, no engine call', async () => {
    const eng = new StubEngine(() => ok('x'));
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w', sessionId: 'nope', text: 'hi' }, c.sink);
    expect(eng.calls).toHaveLength(0);
    expect(msgsOf(c, 'error')[0]).toMatchObject({ turnId: 't', message: expect.stringContaining('세션') });
  });
});

function fakeCodex(events: EngineEvent[] | ((req: CodexTurnRequest) => EngineEvent[])): { engine: Pick<CodexEngine, 'runTurn'>; calls: CodexTurnRequest[] } {
  const calls: CodexTurnRequest[] = [];
  return { calls, engine: { async *runTurn(req) { calls.push(req); for (const e of typeof events === 'function' ? events(req) : events) yield e; } } };
}

const codexOk = (tid: string, text = 'ok'): EngineEvent[] => [
  { kind: 'init', sessionId: tid, model: 'gpt-6-sol' },
  { kind: 'notice', message: '`[features].codex_hooks` is deprecated.' },
  { kind: 'delta', text },
  { kind: 'result', sessionId: tid, ok: true, text, usage: { inputTokens: 15447, outputTokens: 5, cacheReadTokens: 11264, cacheCreationTokens: 0 }, errorText: null, stderr: null, errorKind: null, terminalReason: 'completed' },
];

async function usageWithGpt(gptWeekly: number | null) {
  const cards: unknown[] = [card('claude:main', 13, 70, 0, 154), card('claude:second', 2, 60, 4, 84), card('claude:third', 0, 91, 27, 36)];
  if (gptWeekly !== null) cards.push({ id: 'codex', status: 'ok', fetchedAt: new Date(NOW - 10_000).toISOString(), rows: [{ label: 'Weekly (7d)', used: gptWeekly }] });
  const u = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards }) }), now: () => new Date(NOW) });
  await u.pollOnce();
  return u;
}

describe('TurnRunner: Codex sessions (D2–D5)', () => {
  it('engine codex: runs the codex engine sandboxed, stores a codex state with the rollout file, corrects GPT usage, badge says gpt', async () => {
    const codex = fakeCodex(codexOk('tid-1'));
    const c = await ctx(new StubEngine(async () => []), {
      codex: codex.engine,
      findRollout: async (root, tid) => path.join(root, '2026/09/30', `rollout-x-${tid}.jsonl`),
      readRateLimits: async () => ({ weekly: { usedPct: 40, resetsAt: null } }),
    }, await usageWithGpt(null));
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w', sessionId: null, text: 'hello codex\nsecond line', engine: 'codex', sandbox: 'workspace-write' }, c.sink);
    expect(codex.calls[0]).toMatchObject({ cwd: '/w', resumeThreadId: null, model: 'gpt-6-sol', sandbox: 'workspace-write', prompt: 'hello codex\nsecond line' });
    expect(c.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ account: 'gpt', engine: 'codex', model: 'gpt-6-sol', reason: 'GPT 지정', sessionId: null });
    expect(c.msgs.find((m) => m.type === 'turn_notice')).toMatchObject({ sessionId: 'tid-1', message: expect.stringContaining('deprecated') });
    expect(c.msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: true, text: 'ok', sessionId: 'tid-1', badge: { account: 'gpt', model: 'gpt-6-sol', usage: { cacheReadTokens: 11264 } } });
    const st = c.deps.store.get('tid-1');
    expect(st).toMatchObject({ engine: 'codex', cwd: '/w', sandbox: 'workspace-write', defaultModel: 'gpt-6-sol', title: 'hello codex', rolloutFile: path.join(c.deps.codexSessionsRoot, '2026/09/30', 'rollout-x-tid-1.jsonl'), lastTurnAtMs: NOW });
    expect(c.deps.usage.snapshot().gpt?.weekly?.usedPct).toBe(40);
    expect(c.deps.store.codexEntries()[0]).toMatchObject({ sessionId: 'tid-1', account: 'gpt', title: 'hello codex' });
    expect((c.deps.engine as StubEngine).calls).toHaveLength(0);
  });

  it('a new codex thread is recorded at init, so its `codex exec` rollout never shows as an import mid-turn', async () => {
    const tid = '01a0f2d3-0000-7c92-aeea-0000000000f1';
    const c = await ctx(new StubEngine(async () => []), { findRollout: async () => null, readRateLimits: async () => null });
    const work = path.join(c.base, 'work');
    const root = path.join(c.base, 'codex-root');
    await fs.mkdir(work);
    await fs.mkdir(path.join(root, '2026', '10', '04'), { recursive: true });
    // What `codex exec --json` writes while deck's first turn runs.
    await fs.writeFile(path.join(root, '2026', '10', '04', `rollout-2026-10-04T00-00-00-${tid}.jsonl`),
      [{ type: 'session_meta', payload: { id: tid, cwd: work, originator: 'codex_exec', source: 'exec', thread_source: 'user' } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi deck' }] } }].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const index = new SessionIndex({ roots: rootsOf(c.roots), pinnedFile: path.join(c.base, 'p2.json'), codexRoot: root });
    let midTurn: { sessionId: string; imported?: boolean; codexExec?: boolean }[] = [];
    c.deps.codex = {
      async *runTurn() {
        yield { kind: 'init', sessionId: tid, model: 'gpt-6-sol' };
        await index.refresh();
        midTurn = index.projects(c.deps.store.codexEntries()).flatMap((p) => p.sessions).filter((e) => e.sessionId === tid);
        yield* codexOk(tid).slice(1);
      },
    };
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: work, sessionId: null, text: 'hi deck', engine: 'codex' }, c.sink);
    expect(midTurn).toHaveLength(1);
    expect(midTurn[0]?.imported).toBeUndefined();
    expect(midTurn[0]?.codexExec).toBeUndefined();
    expect(c.deps.store.get(tid)).toMatchObject({ engine: 'codex', cwd: work, title: 'hi deck', createdAtMs: NOW, lastTurnAtMs: NOW });
  });

  it('a deck Codex thread that Codex has since archived is refused (view only); nothing is spawned', async () => {
    const tid = '01a0f2d3-0000-7c92-aeea-0000000000f2';
    const codex = fakeCodex((req) => codexOk(req.resumeThreadId ?? 'x'));
    const c = await ctx(new StubEngine(async () => []), { codex: codex.engine, findRollout: async () => null });
    const work = path.join(c.base, 'work');
    const arch = path.join(c.base, 'archived_sessions');
    await fs.mkdir(work);
    await fs.mkdir(arch);
    await fs.writeFile(path.join(arch, `rollout-2026-10-04T00-00-00-${tid}.jsonl`), [{ type: 'session_meta', payload: { id: tid, cwd: work, originator: 'codex_exec', source: 'exec', thread_source: 'user' } }].map((l) => JSON.stringify(l)).join('\n') + '\n');
    c.deps.index = new SessionIndex({ roots: rootsOf(c.roots), pinnedFile: path.join(c.base, 'p2.json'), codexRoot: path.join(c.base, 'codex-root'), codexArchivedRoot: arch });
    await c.deps.index.refresh();
    await c.deps.store.set({ engine: 'codex', sessionId: tid, cwd: work, lastTurnAtMs: 1, justCompacted: false, defaultModel: 'gpt-6-sol', sandbox: 'read-only', rolloutFile: path.join(c.base, 'codex-root', 'gone.jsonl'), createdAtMs: 1 });
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: work, sessionId: tid, text: 'again' }, c.sink);
    expect(c.msgs).toEqual([expect.objectContaining({ type: 'error', message: CODEX_ARCHIVED_NOTICE })]);
    expect(codex.calls).toHaveLength(0);
  });

  it('resuming a codex session honours a per-turn Codex model; the badge shows it; the stored default is unchanged', async () => {
    const codex = fakeCodex((req) => codexOk(req.resumeThreadId ?? 'x'));
    const c = await ctx(new StubEngine(async () => []), { codex: codex.engine, findRollout: async () => null });
    await c.deps.store.set({ engine: 'codex', sessionId: 'tid-2', cwd: '/w2', lastTurnAtMs: 1, justCompacted: false, defaultModel: 'gpt-6-astra', sandbox: 'read-only', rolloutFile: null, createdAtMs: 1 });
    await new TurnRunner(c.deps).run({ turnId: 't2', cwd: '/w2', sessionId: 'tid-2', text: 'again', model: 'gpt-6-sol' }, c.sink);
    expect(codex.calls[0]).toMatchObject({ resumeThreadId: 'tid-2', model: 'gpt-6-sol', sandbox: 'read-only' });
    expect(c.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ model: 'gpt-6-sol' });
    expect(c.msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: true, badge: { account: 'gpt', model: 'gpt-6-sol' } });
    expect(c.deps.store.get('tid-2')).toMatchObject({ defaultModel: 'gpt-6-astra' });
  });

  it('a per-turn effort reaches the codex engine', async () => {
    const codex = fakeCodex((req) => codexOk(req.resumeThreadId ?? 'x'));
    const c = await ctx(new StubEngine(async () => []), { codex: codex.engine, findRollout: async () => null });
    await c.deps.store.set({ engine: 'codex', sessionId: 'tid-2', cwd: '/w2', lastTurnAtMs: 1, justCompacted: false, defaultModel: 'gpt-6-astra', sandbox: 'read-only', rolloutFile: null, createdAtMs: 1 });
    await new TurnRunner(c.deps).run({ turnId: 't2', cwd: '/w2', sessionId: 'tid-2', text: 'again', model: 'gpt-6-sol', effort: 'high' }, c.sink);
    expect(codex.calls[0]).toMatchObject({ model: 'gpt-6-sol', effort: 'high' });
  });

  it('resuming a codex session keeps its engine, model and sandbox; the sent sandbox and a non-Codex model are ignored', async () => {
    const codex = fakeCodex((req) => codexOk(req.resumeThreadId ?? 'x'));
    const c = await ctx(new StubEngine(async () => []), { codex: codex.engine, findRollout: async () => null });
    await c.deps.store.set({ engine: 'codex', sessionId: 'tid-2', cwd: '/w2', lastTurnAtMs: 1, justCompacted: false, defaultModel: 'gpt-6-astra', sandbox: 'read-only', rolloutFile: null, createdAtMs: 1 });
    await new TurnRunner(c.deps).run({ turnId: 't2', cwd: '/other', sessionId: 'tid-2', text: 'again', sandbox: 'workspace-write', model: 'opus', engine: 'claude' }, c.sink);
    expect(codex.calls[0]).toMatchObject({ cwd: '/w2', resumeThreadId: 'tid-2', model: 'gpt-6-astra', sandbox: 'read-only' });
    expect(c.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ account: 'gpt', reason: 'GPT 세션', sessionId: 'tid-2' });
    expect(c.msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: true, sessionId: 'tid-2' });
  });

  it('weekly 100% with credits: an explicit GPT turn still runs and sets no cooldown; auto stays on Claude', async () => {
    const codex = fakeCodex(codexOk('tid-cr'));
    const u = await usageWithGpt(100);
    u.applyTurn('gpt', { weekly: { usedPct: 100, resetsAt: null }, credits: { hasCredits: true, unlimited: false, balance: 49563.32 } });
    const c = await ctx(new StubEngine(async () => [{ kind: 'init', sessionId: SID, model: 'm' }, okResult(SID)]), {
      codex: codex.engine, findRollout: async () => null,
    }, u);
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 'tc1', cwd: '/w', sessionId: null, text: 'x', engine: 'codex' }, c.sink);
    expect(codex.calls).toHaveLength(1);
    expect(c.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ account: 'gpt', reason: 'GPT 지정' });
    expect(c.msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: true });
    expect(runner.gptCooldownUntilMs()).toBeNull();
    c.msgs.length = 0;
    await runner.run({ turnId: 'tc2', cwd: '/w', sessionId: null, text: 'y', engine: 'auto' }, c.sink);
    expect(codex.calls).toHaveLength(1);
    expect(c.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ reason: expect.stringContaining('GPT 주간 100%') });
  });

  it('a Codex turn.failed JSON blob with status 429 / usage_limit_reached sets the GPT cooldown', async () => {
    const blob = '{"type":"error","status":429,"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":3600}}';
    const codex = fakeCodex([{ kind: 'init', sessionId: 'tid-9', model: 'gpt-6-sol' }, failResult(blob, { sessionId: 'tid-9' })]);
    const c = await ctx(new StubEngine(async () => []), { codex: codex.engine, findRollout: async () => null }, await usageWithGpt(10));
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't9', cwd: '/w', sessionId: null, text: 'x', engine: 'codex' }, c.sink);
    expect(runner.gptCooldownUntilMs()).toBe(NOW + 60 * 60_000);
  });

  it('a Codex limit failure sets a 1 h in-memory GPT cooldown that auto then honours; no retry, no account cooldown files', async () => {
    const codex = fakeCodex([{ kind: 'init', sessionId: 'tid-3', model: 'gpt-6-sol' }, failResult('usage limit reached for this week', { sessionId: 'tid-3' })]);
    const c = await ctx(new StubEngine(async () => [{ kind: 'init', sessionId: SID, model: 'm' }, okResult(SID)]), { codex: codex.engine, findRollout: async () => null }, await usageWithGpt(10));
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't3', cwd: '/w', sessionId: null, text: 'x', engine: 'codex' }, c.sink);
    expect(c.msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: false, badge: { account: 'gpt' }, errorText: expect.stringContaining('usage limit') });
    expect(c.msgs.filter((m) => m.type === 'turn_retry')).toHaveLength(0);
    expect(runner.gptCooldownUntilMs()).toBe(NOW + 60 * 60_000);
    expect(readCooldownUntilMs(c.deps.cooldownDir, 'b', NOW)).toBeNull();
    c.msgs.length = 0;
    await runner.run({ turnId: 't4', cwd: '/w', sessionId: null, text: 'y', engine: 'auto' }, c.sink);
    expect(c.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ account: 'b', reason: expect.stringContaining('GPT 쿨다운') });
  });

  it('auto opens on GPT when it has the headroom; codex requested without a binary falls back to Claude with the reason', async () => {
    const codex = fakeCodex(codexOk('tid-5'));
    const c = await ctx(new StubEngine(async () => [{ kind: 'init', sessionId: SID, model: 'm' }, okResult(SID)]), { codex: codex.engine, findRollout: async () => null }, await usageWithGpt(10));
    await new TurnRunner(c.deps).run({ turnId: 't5', cwd: '/w', sessionId: null, text: 'x', engine: 'auto' }, c.sink);
    expect(c.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ account: 'gpt', reason: expect.stringContaining('→ GPT') });
    const d = await ctx(new StubEngine(async () => [{ kind: 'init', sessionId: SID, model: 'm' }, okResult(SID)]), { codex: null });
    await new TurnRunner(d.deps).run({ turnId: 't6', cwd: '/w', sessionId: null, text: 'x', engine: 'codex', model: 'gpt-6-astra' }, d.sink);
    expect(d.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ account: 'b', engine: 'claude', model: 'fable', reason: expect.stringContaining('codex CLI 없음 → Claude') });
  });
});

describe('TurnRunner: Codex session ids', () => {
  it('persists only a thread id the CLI reported (init), never a result-only id', async () => {
    const codex = fakeCodex([failResult('잘못된 세션 ID 형식', { sessionId: '--dangerously-bypass-approvals-and-sandbox' })]);
    const c = await ctx(new StubEngine(async () => []), { codex: codex.engine, findRollout: async () => null });
    await new TurnRunner(c.deps).run({ turnId: 't7', cwd: '/w', sessionId: null, text: 'x', engine: 'codex' }, c.sink);
    expect(c.msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: false, sessionId: null });
    expect(c.deps.store.get('--dangerously-bypass-approvals-and-sandbox')).toBeNull();
    expect(c.deps.store.codexEntries()).toEqual([]);
  });
});

describe('TurnRunner: attachments (D7)', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

  it('resolves ids to Attachment objects for Claude, and to imagePaths + path lines for Codex; unknown ids fail the turn before any engine runs', async () => {
    const stub = new StubEngine(async () => [{ kind: 'init', sessionId: SID, model: 'm' }, okResult(SID)]);
    const c = await ctx(stub);
    const store = new AttachmentStore(path.join(c.base, 'att'));
    await store.init();
    const img = await store.save('a.png', PNG);
    const doc = await store.save('notes.md', Buffer.from('# n'));
    c.deps.attachments = store;
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w', sessionId: null, text: 'look', attachments: [img.id, doc.id] }, c.sink);
    expect(stub.calls[0]?.attachments?.map((a) => a.id)).toEqual([img.id, doc.id]);
    expect(stub.calls[0]?.prompt).toBe('look');
    const codex = fakeCodex(codexOk('tid-a'));
    c.deps.codex = codex.engine; c.deps.findRollout = async () => null;
    await new TurnRunner(c.deps).run({ turnId: 't2', cwd: '/w', sessionId: null, text: 'look', engine: 'codex', attachments: [img.id, doc.id] }, c.sink);
    expect(codex.calls[0]).toMatchObject({ imagePaths: [img.path], prompt: `look\n\n첨부 파일: ${doc.path}` });
    c.msgs.length = 0;
    await new TurnRunner(c.deps).run({ turnId: 't3', cwd: '/w', sessionId: null, text: 'x', attachments: ['11111111-1111-4111-8111-111111111111'] }, c.sink);
    expect(c.msgs).toEqual([{ type: 'error', turnId: 't3', message: expect.stringContaining('첨부를 찾을 수 없습니다') }]);
    expect(stub.calls).toHaveLength(1);
  });

  it('duplicate ids reach the engine once; with no store every id is missing (no crash)', async () => {
    const stub = new StubEngine(async () => [{ kind: 'init', sessionId: SID, model: 'm' }, okResult(SID)]);
    const c = await ctx(stub);
    const store = new AttachmentStore(path.join(c.base, 'att'));
    await store.init();
    const img = await store.save('a.png', PNG);
    const doc = await store.save('notes.md', Buffer.from('# n'));
    c.deps.attachments = store;
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w', sessionId: null, text: 'look', attachments: [img.id, doc.id, img.id, doc.id] }, c.sink);
    expect(stub.calls[0]?.attachments?.map((a) => a.id)).toEqual([img.id, doc.id]);
    c.deps.attachments = null;
    c.msgs.length = 0;
    await new TurnRunner(c.deps).run({ turnId: 't2', cwd: '/w', sessionId: null, text: 'x', attachments: [img.id, img.id] }, c.sink);
    expect(c.msgs).toEqual([{ type: 'error', turnId: 't2', message: `첨부를 찾을 수 없습니다: ${img.id}` }]);
    expect(stub.calls).toHaveLength(1);
  });
});

describe('TurnRunner: questions (D8)', () => {
  it('relays onQuestion to the sink with turn scope and audits it as answered / deny', async () => {
    const stub = new StubEngine(async (req) => {
      const a = await req.onQuestion?.({ toolUseId: 'tu1', questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'red', description: '' }, { label: 'blue', description: '' }], multiSelect: false }] });
      return [{ kind: 'init', sessionId: SID, model: 'm' }, okResult(SID, `answer=${a ? a['Which color?'] : 'none'}`)];
    });
    const c = await ctx(stub);
    const seen: unknown[] = [];
    c.sink.askQuestion = async (q) => { seen.push(q); return { 'Which color?': 'blue' }; };
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w', sessionId: null, text: 'ask' }, c.sink);
    expect(seen[0]).toMatchObject({ turnId: 't1', cwd: '/w', toolUseId: 'tu1', questions: [{ header: 'Color' }] });
    expect(c.msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: true, text: 'answer=blue' });
    const audit = (await fs.readFile(c.deps.auditFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { toolName: string; decision: string });
    expect(audit.at(-1)).toMatchObject({ toolName: 'AskUserQuestion', decision: 'answered' });
    c.sink.askQuestion = async () => null;
    await new TurnRunner(c.deps).run({ turnId: 't2', cwd: '/w', sessionId: null, text: 'ask' }, c.sink);
    expect(c.msgs.at(-1)).toMatchObject({ type: 'turn_result', text: 'answer=none' });
  });

  it('a malformed AskUserQuestion is never shown but still leaves a deny audit line', async () => {
    const stub = new StubEngine(async (req) => {
      await req.onQuestionMalformed?.({ questions: [{ question: 'dup' }, { question: 'dup' }] });
      return [{ kind: 'init', sessionId: SID, model: 'm' }, okResult(SID)];
    });
    const c = await ctx(stub);
    let asked = 0;
    c.sink.askQuestion = async () => { asked++; return null; };
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w', sessionId: null, text: 'ask' }, c.sink);
    expect(asked).toBe(0);
    const audit = (await fs.readFile(c.deps.auditFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { toolName: string; decision: string; turnId: string; inputSha256: string });
    expect(audit.at(-1)).toMatchObject({ toolName: 'AskUserQuestion', decision: 'deny', turnId: 't1', inputSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});

describe('TurnRunner: 자동 승인', () => {
  it('on: tool calls skip the card and are audited as auto', async () => {
    const eng = new StubEngine(async (req) => {
      expect(req.autoApprove?.()).toBe(true);
      await req.onAutoApproved?.({ toolName: 'Bash', input: { command: 'rm -rf build' }, toolUseId: 'tu1' });
      return ok('aa1');
    });
    const c = await ctx(eng, { defaultPermissionMode: () => 'bypassPermissions' });
    let asked = 0;
    c.sink.askPermission = async () => { asked++; return 'deny'; };
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect(asked).toBe(0);
    const audit = (await fs.readFile(c.deps.auditFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { toolName: string; decision: string });
    expect(audit).toEqual([expect.objectContaining({ toolName: 'Bash', decision: 'auto' })]);
  });

  it('new GPT session without an explicit sandbox: workspace-write whatever the Claude default (다 붙여); an explicit choice wins', async () => {
    for (const [auto, sent, want] of [[true, undefined, 'workspace-write'], [false, undefined, 'workspace-write'], [false, 'read-only', 'read-only']] as const) {
      const codex = fakeCodex(codexOk('tid-aa'));
      const c = await ctx(new StubEngine(async () => []), { codex: codex.engine, defaultPermissionMode: () => (auto ? 'bypassPermissions' : 'default'), findRollout: async () => null }, await usageWithGpt(null));
      await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w', sessionId: null, text: 'x', engine: 'codex', ...(sent ? { sandbox: sent } : {}) }, c.sink);
      expect(codex.calls[0]?.sandbox).toBe(want);
    }
  });

  it('setSandbox: a GPT session\'s next turn runs in the new sandbox; a change during a turn survives its end; Claude / Gemini / unknown refused', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    const codex = { calls: [] as CodexTurnRequest[], engine: { async *runTurn(req: CodexTurnRequest) { codex.calls.push(req); if (n++ === 0) await gate; for (const e of codexOk('tid-sb')) yield e; } } };
    const c = await ctx(new StubEngine(async () => []), { codex: codex.engine, findRollout: async () => null }, await usageWithGpt(null));
    const runner = new TurnRunner(c.deps);
    await c.deps.store.set({ engine: 'codex', sessionId: 'tid-sb', cwd: '/w', lastTurnAtMs: 1, justCompacted: false, defaultModel: 'gpt-6-sol', sandbox: 'read-only', rolloutFile: null, createdAtMs: 1 });
    const running = runner.run({ turnId: 't1', cwd: '/w', sessionId: 'tid-sb', text: 'a' }, c.sink);
    await new Promise((r) => setTimeout(r, 10));
    expect(codex.calls[0]?.sandbox).toBe('read-only');
    expect(await runner.setSandbox('tid-sb', 'workspace-write')).toBe(true);
    release();
    await running;
    expect(c.deps.store.get('tid-sb')).toMatchObject({ engine: 'codex', sandbox: 'workspace-write' });
    await runner.run({ turnId: 't2', cwd: '/w', sessionId: 'tid-sb', text: 'b' }, c.sink);
    expect(codex.calls[1]?.sandbox).toBe('workspace-write');
    expect(await runner.setSandbox('tid-sb', 'read-only')).toBe(true);
    expect(c.deps.store.get('tid-sb')).toMatchObject({ sandbox: 'read-only' });
    await c.deps.store.set({ sessionId: 'claude-1', cwd: '/w', account: 'a', projectDir: '/p', lastTurnAtMs: 1, justCompacted: false, defaultModel: 'opus' });
    await c.deps.store.set({ engine: 'gemini', account: 'g1', sessionId: 'gem-1', cwd: '/w', lastTurnAtMs: 1, justCompacted: false, defaultModel: 'gemini-pro', sandbox: 'read-only', createdAtMs: 1 });
    expect(await runner.setSandbox('claude-1', 'workspace-write')).toBe(false);
    expect(await runner.setSandbox('gem-1', 'workspace-write')).toBe(false);
    expect(await runner.setSandbox('nope', 'workspace-write')).toBe(false);
    expect(c.deps.store.get('gem-1')).toMatchObject({ sandbox: 'read-only' });
  });
});

const GSID = '4f1c2b9e-1111-4222-8333-944455556666';
const GSID2 = '4f1c2b9e-1111-4222-8333-944455550002';

function fakeGemini(loggedIn: GeminiAccount[], events: (req: GeminiTurnRequest) => EngineEvent[]) {
  const calls: GeminiTurnRequest[] = [];
  return { calls, dep: { loggedIn: (a: GeminiAccount) => loggedIn.includes(a), engine: { async *runTurn(req: GeminiTurnRequest) { calls.push(req); for (const e of events(req)) yield e; } } } };
}

const geminiOk = (sid: string, text = 'ok'): EngineEvent[] => [
  { kind: 'init', sessionId: sid, model: 'gemini-2.5-pro' },
  { kind: 'delta', text },
  { kind: 'result', sessionId: sid, ok: true, text, usage: { inputTokens: 60, outputTokens: 30, cacheReadTokens: 40, cacheCreationTokens: 0 }, errorText: null, stderr: null, errorKind: null, terminalReason: 'completed' },
];
const geminiQuota = (sid: string): EngineEvent[] => [
  { kind: 'init', sessionId: sid, model: 'gemini-2.5-pro' },
  { kind: 'result', sessionId: sid, ok: false, text: '', usage: ZERO, errorText: 'You have exhausted your daily quota on this model.', stderr: null, errorKind: null, terminalReason: null },
];
const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

describe('TurnRunner: Gemini sessions (explicit only)', () => {
  it('engine gemini: first logged-in account, read-only by default, stores a pinned gemini state and a sidebar entry', async () => {
    const g = fakeGemini(['g1', 'g2'], () => geminiOk(GSID));
    const c = await ctx(new StubEngine(async () => []), { gemini: g.dep });
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w', sessionId: null, text: 'hello gemini\nmore', engine: 'gemini', model: 'gemini-flash', effort: 'high' }, c.sink);
    expect(g.calls[0]).toMatchObject({ account: 'g1', cwd: '/w', resumeSessionId: null, model: 'gemini-flash', sandbox: 'read-only', prompt: 'hello gemini\nmore' });
    expect(g.calls[0]).not.toHaveProperty('effort');
    expect(c.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ account: 'g1', engine: 'gemini', model: 'gemini-flash', reason: 'Gemini 지정 · G1' });
    expect(c.msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: true, text: 'ok', sessionId: GSID, badge: { account: 'g1', model: 'gemini-flash', usage: { cacheReadTokens: 40 } } });
    expect(c.deps.store.get(GSID)).toMatchObject({ engine: 'gemini', account: 'g1', cwd: '/w', sandbox: 'read-only', defaultModel: 'gemini-flash', title: 'hello gemini', lastTurnAtMs: NOW });
    expect(c.deps.store.codexEntries()).toEqual([expect.objectContaining({ sessionId: GSID, account: 'g1', engine: 'gemini', title: 'hello gemini' })]);
    expect((c.deps.engine as StubEngine).calls).toHaveLength(0);
  });

  it('g1 not logged in → g2; none logged in → 로그인 필요 without running; no CLI → error', async () => {
    const g = fakeGemini(['g2'], () => geminiOk(GSID));
    const c = await ctx(new StubEngine(async () => []), { gemini: g.dep });
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w', sessionId: null, text: 'x', engine: 'gemini' }, c.sink);
    expect(g.calls[0]).toMatchObject({ account: 'g2', model: 'gemini-pro' });

    const none = fakeGemini([], () => geminiOk(GSID));
    const c2 = await ctx(new StubEngine(async () => []), { gemini: none.dep });
    await new TurnRunner(c2.deps).run({ turnId: 't1', cwd: '/w', sessionId: null, text: 'x', engine: 'gemini' }, c2.sink);
    expect(none.calls).toHaveLength(0);
    expect(c2.msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: false, errorText: expect.stringContaining('로그인 필요') });

    const c3 = await ctx(new StubEngine(async () => []), { gemini: null });
    await new TurnRunner(c3.deps).run({ turnId: 't1', cwd: '/w', sessionId: null, text: 'x', engine: 'gemini' }, c3.sink);
    expect(c3.msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: false, errorText: 'gemini CLI 를 찾을 수 없습니다' });
  });

  it('resume stays on the pinned account, cwd and sandbox; a Claude model is ignored', async () => {
    const g = fakeGemini(['g1', 'g2'], (req) => geminiOk(req.resumeSessionId ?? GSID));
    const c = await ctx(new StubEngine(async () => []), { gemini: g.dep });
    await c.deps.store.set({ engine: 'gemini', account: 'g2', sessionId: GSID, cwd: '/w2', lastTurnAtMs: 1, justCompacted: false, defaultModel: 'gemini-flash', sandbox: 'workspace-write', createdAtMs: 1, title: 't' });
    await new TurnRunner(c.deps).run({ turnId: 't2', cwd: '/elsewhere', sessionId: GSID, text: 'again', model: 'opus', sandbox: 'read-only' }, c.sink);
    expect(g.calls[0]).toMatchObject({ account: 'g2', cwd: '/w2', resumeSessionId: GSID, model: 'gemini-flash', sandbox: 'workspace-write' });
    expect(c.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ account: 'g2', reason: 'Gemini 세션 · G2' });
    expect(c.deps.store.get(GSID)).toMatchObject({ account: 'g2', title: 't', createdAtMs: 1, lastTurnAtMs: NOW });
  });

  it('a pinned account that lost its login fails the turn instead of switching accounts', async () => {
    const g = fakeGemini(['g1'], () => geminiOk(GSID));
    const c = await ctx(new StubEngine(async () => []), { gemini: g.dep });
    await c.deps.store.set({ engine: 'gemini', account: 'g2', sessionId: GSID, cwd: '/w2', lastTurnAtMs: 1, justCompacted: false, defaultModel: 'gemini-pro', sandbox: 'read-only', createdAtMs: 1 });
    await new TurnRunner(c.deps).run({ turnId: 't2', cwd: '/w2', sessionId: GSID, text: 'x' }, c.sink);
    expect(g.calls).toHaveLength(0);
    expect(c.msgs.at(-1)).toMatchObject({ ok: false, errorText: 'Gemini G2 로그인 필요' });
  });

  it('a quota failure cools that account down: the next new Gemini session opens on the other one', async () => {
    const g = fakeGemini(['g1', 'g2'], (req) => (req.account === 'g1' ? geminiQuota(GSID) : geminiOk(GSID2)));
    const c = await ctx(new StubEngine(async () => []), { gemini: g.dep });
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't1', cwd: '/w', sessionId: null, text: 'x', engine: 'gemini' }, c.sink);
    expect(c.msgs.at(-1)).toMatchObject({ ok: false, errorText: expect.stringContaining('quota') });
    await runner.run({ turnId: 't2', cwd: '/w', sessionId: null, text: 'x', engine: 'gemini' }, c.sink);
    expect(g.calls.map((r) => r.account)).toEqual(['g1', 'g2']);
  });

  it('자동 (engine and model) never opens on Gemini', async () => {
    const g = fakeGemini(['g1', 'g2'], () => geminiOk(GSID));
    const eng = new StubEngine(() => ok('c1'));
    const c = await ctx(eng, { gemini: g.dep });
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w', sessionId: null, text: '보안 취약점 검토해줘', engine: 'auto', model: 'auto' }, c.sink);
    expect(g.calls).toHaveLength(0);
    expect(eng.calls).toHaveLength(1);
  });
});

describe('TurnRunner: permission modes', () => {
  it('a new session starts in the mode its first send names, keeps it, and the default applies when absent', async () => {
    const sids = ['pmA', 'pmA', 'pmB'];
    let n = 0;
    const eng = new StubEngine(async () => ok(sids[n++]!));
    const c = await ctx(eng, { defaultPermissionMode: () => 'bypassPermissions' });
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'x', permissionMode: 'plan' }, c.sink);
    expect(eng.calls[0]?.permissionMode).toBe('plan');
    expect(eng.calls[0]?.autoApprove?.()).toBe(false);
    expect(c.deps.store.get('pmA')).toMatchObject({ mode: 'plan' });
    expect(runner.permissionModeOf('pmA')).toBe('plan');
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: 'pmA', text: 'x', permissionMode: 'default' }, c.sink);
    expect(eng.calls[1]?.permissionMode).toBe('plan');
    // No mode named: the global default (모두 자동 승인 → canUseTool auto-allow, SDK mode stays default).
    await runner.run({ turnId: 't3', cwd: '/w/new', sessionId: null, text: 'x' }, c.sink);
    expect(eng.calls[2]?.permissionMode).toBeUndefined();
    expect(eng.calls[2]?.autoApprove?.()).toBe(true);
    expect(c.deps.store.get('pmB')).toMatchObject({ mode: 'bypassPermissions' });
  });

  it('setPermissionMode reaches a running turn at once (tool calls and Query.setPermissionMode) and is stored', async () => {
    const live: string[] = [];
    const auto: boolean[] = [];
    let runner!: TurnRunner;
    const eng = new StubEngine(async (req) => {
      req.onLive?.({ send: async () => true, setPermissionMode: async (m) => { live.push(m); return true; } });
      auto.push(req.autoApprove!());
      expect(await runner.setPermissionMode(SID, 'plan')).toBe(true);
      auto.push(req.autoApprove!());
      expect(runner.permissionModeOf(SID)).toBe('plan');
      await runner.setPermissionMode(SID, 'bypassPermissions');
      auto.push(req.autoApprove!());
      return ok(SID);
    });
    const c = await ctx(eng);
    await seedSession(c, 'b');
    runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't1', cwd: '/w/one', sessionId: SID, text: 'x' }, c.sink);
    expect(auto).toEqual([false, false, true]);
    expect(live).toEqual(['plan', 'default']);
    expect(c.deps.store.get(SID)).toMatchObject({ mode: 'bypassPermissions' });
    expect(runner.permissionModeOf(SID)).toBe('bypassPermissions');
  });

  it('the plan card: 승인 · 편집 자동 승인 stores acceptEdits and tells the clients; 계속 계획 stays in plan', async () => {
    const sids = ['plA', 'plB'];
    let n = 0;
    const eng = new StubEngine(async (req) => {
      await req.onPermission({ toolName: 'ExitPlanMode', input: { plan: '1. a' }, toolUseId: 'tu' });
      return ok(sids[n++] ?? SID);
    });
    const told: [string, string][] = [];
    const c = await ctx(eng, { onPermissionMode: (s, m) => told.push([s, m]) });
    const runner = new TurnRunner(c.deps);
    c.sink.askPermission = async () => 'session';
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'x', permissionMode: 'plan' }, c.sink);
    expect(c.deps.store.get('plA')).toMatchObject({ mode: 'acceptEdits' });
    c.sink.askPermission = async () => 'deny';
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: null, text: 'x', permissionMode: 'plan' }, c.sink);
    expect(c.deps.store.get('plB')).toMatchObject({ mode: 'plan' });
    // An existing session: the approval is broadcast at once; 승인 · 수동 승인 → back to 매번 묻기.
    await seedSession(c, 'b');
    await runner.setPermissionMode(SID, 'plan');
    c.sink.askPermission = async () => 'once';
    await runner.run({ turnId: 't3', cwd: '/w/one', sessionId: SID, text: 'x' }, c.sink);
    expect(eng.calls[2]?.permissionMode).toBe('plan');
    // New sessions: their mode follows their turn_result (the pane adopts the id then).
    expect(told).toEqual([['plA', 'acceptEdits'], ['plB', 'plan'], [SID, 'default']]);
    expect(c.deps.store.get(SID)).toMatchObject({ mode: 'default' });
  });

  it('a new session announces its mode right after the turn_result that names it', async () => {
    const eng = new StubEngine(async () => ok('newM'));
    const order: string[] = [];
    const c = await ctx(eng, { onPermissionMode: (s, m) => order.push(`mode ${s} ${m}`) });
    const emit = c.sink.emit;
    c.sink.emit = (m) => { if (m.type === 'turn_result') order.push(`result ${m.sessionId}`); emit(m); };
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'x', permissionMode: 'acceptEdits' }, c.sink);
    expect(order).toEqual(['result newM', 'mode newM acceptEdits']);
  });

  it('a new session takes a mode and a pin set once init named it (before it has stored state)', async () => {
    const live: string[] = [];
    let runner!: TurnRunner;
    let during: [boolean, boolean] | null = null;
    const eng = new StubEngine((req) => (async function* () {
      req.onLive?.({ send: async () => true, setPermissionMode: async (m) => { live.push(m); return true; } });
      yield { kind: 'init' as const, sessionId: 'bornM', model: 'claude-opus-5-5' };
      during = [await runner.setPermissionMode('bornM', 'plan'), await runner.setAccountPin('bornM', 'c')];
      expect(runner.permissionModeOf('bornM')).toBe('plan');
      yield okResult('bornM');
    })());
    const told: [string, string][] = [];
    const c = await ctx(eng, { onPermissionMode: (s, m) => told.push([s, m]) });
    runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'x', permissionMode: 'default' }, c.sink);
    expect(during).toEqual([true, true]);
    expect(live).toEqual(['plan']);
    expect(c.deps.store.get('bornM')).toMatchObject({ mode: 'plan', accountPin: 'c' });
    // The turn_result's re-announcement carries the new mode, not the one the turn started in.
    expect(told).toEqual([['bornM', 'plan']]);
  });

  it('이 세션 with a setMode acceptEdits suggestion while in plan: deck follows the SDK into acceptEdits and says so', async () => {
    const eng = new StubEngine(async (req) => {
      await req.onPermission({ toolName: 'Write', input: { file_path: '/w/one/p.txt' }, toolUseId: 'tu', suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
      return ok(SID);
    });
    const told: [string, string][] = [];
    const c = await ctx(eng, { onPermissionMode: (s, m) => told.push([s, m]) });
    await seedSession(c, 'b');
    const runner = new TurnRunner(c.deps);
    await runner.setPermissionMode(SID, 'plan');
    c.sink.askPermission = async () => 'session';
    await runner.run({ turnId: 't1', cwd: '/w/one', sessionId: SID, text: 'x' }, c.sink);
    expect(told).toEqual([[SID, 'acceptEdits']]);
    expect(c.deps.store.get(SID)).toMatchObject({ mode: 'acceptEdits' });
    expect(runner.permissionModeOf(SID)).toBe('acceptEdits');
  });

  it('a handoff-note turn is run without tools in every mode', async () => {
    const eng = new StubEngine(async () => ok(SID));
    const c = await ctx(eng);
    await seedSession(c, 'b');
    const runner = new TurnRunner(c.deps);
    for (const mode of ['bypassPermissions', 'acceptEdits', 'plan', 'default'] as const) {
      await runner.setPermissionMode(SID, mode);
      await runner.run({ turnId: `h-${mode}`, cwd: '/w/one', sessionId: SID, text: 'note', handoff: true }, c.sink);
      expect(eng.calls.at(-1)?.noTools).toBe(true);
    }
  });

  it('GPT sessions have no Claude mode', async () => {
    const c = await ctx(new StubEngine(async () => ok(SID)));
    await c.deps.store.set({ engine: 'codex', sessionId: 'gpt1', cwd: '/w', sandbox: 'read-only' } as never);
    expect(await new TurnRunner(c.deps).setPermissionMode('gpt1', 'plan')).toBe(false);
  });
});
