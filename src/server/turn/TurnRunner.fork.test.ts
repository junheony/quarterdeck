import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Account } from '../../shared/accounts';
import type { ServerMessage } from '../../shared/protocol';
import type { EngineEvent } from '../engine/Engine';
import { StubEngine, okResult } from '../engine/StubEngine';
import { SessionIndex } from '../sessions/SessionIndex';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore } from './SessionState';
import { writeCooldown } from '../routing/cooldown';
import { TurnRunner, type TurnRunnerDeps, type TurnSink } from './TurnRunner';
import { rootsOf, testRegistry } from '../../shared/accounts.testkit';

const NOW = Date.parse('2026-09-30T12:30:00Z');
const PARENT = '22222222-2222-4222-8222-222222222222';
const CHILD = '33333333-3333-4333-8333-333333333333';

async function setup(engine: StubEngine, extra: Partial<TurnRunnerDeps> = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-fork-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') } as Record<Account, string>;
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'projects.json') });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }), now: () => new Date(NOW) });
  const runner = new TurnRunner({ accounts: testRegistry(),
    engine, index, store, usage, cooldownDir: path.join(base, 'cooldown'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots),
    codex: null, attachments: null, codexSessionsRoot: path.join(base, 'codex'), now: () => NOW, maxRetries: 0, ...extra,
  });
  const dir = path.join(roots.c!, '-w-one');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${PARENT}.jsonl`);
  await fs.writeFile(file, [{ type: 'user', uuid: 'u0', parentUuid: null, cwd: '/w/one', message: { role: 'user', content: '첫 질문' } }, { type: 'assistant', uuid: 'a0', parentUuid: 'u0', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: '답' }] } }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  await index.refresh();
  const msgs: ServerMessage[] = [];
  const sink: TurnSink = { emit: (m) => msgs.push(m), askPermission: async () => 'once', askQuestion: async () => null, signal: new AbortController().signal };
  return { runner, store, msgs, sink, dir, file };
}

/** Every account known and roomy (the router has real alternatives). */
async function roomyUsage(weekly: Record<string, number> = {}) {
  const resetsAt = new Date(NOW + 3_600_000).toISOString();
  const card = (id: string) => ({ id, status: 'ok', fetchedAt: new Date(NOW - 10_000).toISOString(), rows: [{ label: 'Session (5h)', used: 10, resetsAt }, { label: 'Weekly (7d)', used: weekly[id] ?? 10, resetsAt }, { label: 'Fable (7d)', used: 0, resetsAt }] });
  const u = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [card('claude:main'), card('claude:second'), card('claude:third')] }) }), now: () => new Date(NOW) });
  await u.pollOnce();
  return u;
}

const ok = (sid: string): EngineEvent[] => [{ kind: 'init', sessionId: sid, model: 'claude-opus-5-5' }, { kind: 'delta', text: '새 답' }, okResult(sid)];

describe('TurnRunner · 메시지 편집 갈래', () => {
  it('resumes the parent as a fork at the branch point; the new id is reported and stored with the parent’s pin, model and grants', async () => {
    const eng = new StubEngine(() => ok(CHILD));
    const c = await setup(eng);
    await c.store.set({ sessionId: PARENT, cwd: '/w/one', account: 'c', projectDir: c.dir, lastTurnAtMs: NOW - 3_600_000, justCompacted: false, defaultModel: 'sonnet', accountPin: 'c', allowRules: ['Bash(ls:*)'] });
    const before = await fs.readFile(c.file, 'utf8');
    await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: '고친 질문', fork: { from: PARENT, at: 'a0' } }, c.sink);

    expect(eng.calls).toHaveLength(1);
    expect(eng.calls[0]).toMatchObject({ resumeSessionId: PARENT, forkAt: 'a0', prompt: '고친 질문', account: 'c', model: 'sonnet', allowRules: ['Bash(ls:*)'] });
    const started = c.msgs.find((m) => m.type === 'turn_started');
    expect(started).toMatchObject({ sessionId: null, reason: expect.stringContaining('메시지 편집') });
    // Nothing of the turn is ever addressed to the parent.
    expect(c.msgs.some((m) => 'sessionId' in m && m.sessionId === PARENT)).toBe(false);
    expect(c.msgs.find((m) => m.type === 'turn_result')).toMatchObject({ ok: true, sessionId: CHILD });
    expect(c.store.get(CHILD)).toMatchObject({ account: 'c', accountPin: 'c', defaultModel: 'sonnet', allowRules: ['Bash(ls:*)'], cwd: '/w/one' });
    expect(c.store.get(PARENT)).toMatchObject({ lastTurnAtMs: NOW - 3_600_000 });
    expect(await fs.readFile(c.file, 'utf8')).toBe(before);
  });

  it('the fork inherits the parent’s mode and announces it once the fork has an id', async () => {
    const eng = new StubEngine(() => ok(CHILD));
    const told: [string, string][] = [];
    const c = await setup(eng, { onPermissionMode: (s, m) => told.push([s, m]) });
    await c.store.set({ sessionId: PARENT, cwd: '/w/one', account: 'c', projectDir: c.dir, lastTurnAtMs: null, justCompacted: false, defaultModel: 'sonnet', mode: 'plan' });
    await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: 'x', fork: { from: PARENT, at: 'a0' } }, c.sink);
    expect(eng.calls[0]?.permissionMode).toBe('plan');
    expect(c.store.get(CHILD)).toMatchObject({ mode: 'plan' });
    expect(told).toEqual([[CHILD, 'plan']]);
  });

  it('forks on the parent’s own account even when the router would pick another; nothing is moved', async () => {
    const eng = new StubEngine(() => ok(CHILD));
    const moves: unknown[] = [];
    const c = await setup(eng, { usage: await roomyUsage(), move: async (o) => { moves.push(o); return { ok: false, error: 'no' }; } });
    // b looks better (warm, unpinned), but the parent lives on c.
    await c.store.set({ sessionId: PARENT, cwd: '/w/one', account: 'c', projectDir: c.dir, lastTurnAtMs: null, justCompacted: false, defaultModel: 'sonnet' });
    await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: 'x', fork: { from: PARENT, at: 'a0' } }, c.sink);
    expect(eng.calls[0]).toMatchObject({ account: 'c', resumeSessionId: PARENT });
    expect(moves).toEqual([]);
    expect(c.store.get(PARENT)).toMatchObject({ account: 'c', projectDir: c.dir });
  });

  it('parent’s account unusable: the parent is copied by the safe mover, not relocated, and a notice says so', async () => {
    const eng = new StubEngine(() => ok(CHILD));
    const moves: { targetProjectsRoot: string }[] = [];
    const c = await setup(eng, { usage: await roomyUsage(), move: async (o) => { moves.push(o); return { ok: true, targetDir: path.join(o.targetProjectsRoot, '-w-one'), targetFile: path.join(o.targetProjectsRoot, '-w-one', o.sessionId + '.jsonl') } as never; } });
    writeCooldown(path.join(path.dirname(path.dirname(c.dir)), 'cooldown'), 'c', NOW + 3_600_000);
    await c.store.set({ sessionId: PARENT, cwd: '/w/one', account: 'c', projectDir: c.dir, lastTurnAtMs: null, justCompacted: false, defaultModel: 'sonnet' });
    await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: 'x', fork: { from: PARENT, at: 'a0' } }, c.sink);
    expect(moves).toHaveLength(1);
    expect(eng.calls[0]?.account).not.toBe('c');
    expect(c.store.get(PARENT)).toMatchObject({ account: 'c', projectDir: c.dir });
    expect(c.msgs.some((m) => m.type === 'turn_notice' && m.message.includes('복사해 갈래'))).toBe(true);
  });

  it('a session pinned to another account forks there: the parent is copied (not moved), the fork is stored on the pin', async () => {
    const eng = new StubEngine(() => ok(CHILD));
    const c = await setup(eng, { usage: await roomyUsage() });
    // Pinned to b after its last turn on c (a pin applies from the next turn): the edit-fork is that next turn.
    await c.store.set({ sessionId: PARENT, cwd: '/w/one', account: 'c', projectDir: c.dir, lastTurnAtMs: NOW - 60_000, justCompacted: false, defaultModel: 'sonnet', accountPin: 'b' });
    const before = await fs.readFile(c.file, 'utf8');
    await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: 'x', accountPin: 'b', fork: { from: PARENT, at: 'a0' } }, c.sink);
    expect(eng.calls[0]).toMatchObject({ account: 'b', resumeSessionId: PARENT, forkAt: 'a0' });
    const bDir = path.join(path.dirname(path.dirname(c.dir)), 'b', '-w-one');
    // The fork resumes from the pinned account's copy of the parent; the parent's own file and state are untouched.
    expect(await fs.readFile(path.join(bDir, `${PARENT}.jsonl`), 'utf8')).toBe(before);
    expect(await fs.readFile(c.file, 'utf8')).toBe(before);
    expect(c.store.get(PARENT)).toMatchObject({ account: 'c', projectDir: c.dir, accountPin: 'b', lastTurnAtMs: NOW - 60_000 });
    expect(c.store.get(CHILD)).toMatchObject({ account: 'b', accountPin: 'b', projectDir: bDir });
    expect(c.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ account: 'b', sessionId: null });
    expect(c.msgs.find((m) => m.type === 'turn_result')).toMatchObject({ ok: true, sessionId: CHILD, badge: { account: 'b', pinned: true } });
    const notices = c.msgs.filter((m) => m.type === 'turn_notice').map((m) => (m as { message: string }).message);
    expect(notices.some((n) => n.includes('고정') && n.includes('B'))).toBe(true);
    expect(notices.some((n) => n.includes('쓸 수 없어'))).toBe(false);
  });

  it('pinned account unusable: the fork falls back like a normal turn (parent’s account, no copy) with the same pin notice', async () => {
    const eng = new StubEngine(() => ok(CHILD));
    const moves: unknown[] = [];
    // c (the parent's account) scores worse than a
    const c = await setup(eng, { usage: await roomyUsage({ 'claude:third': 50 }), move: async (o) => { moves.push(o); return { ok: false, error: 'no' }; } });
    writeCooldown(path.join(path.dirname(path.dirname(c.dir)), 'cooldown'), 'b', NOW + 3_600_000);
    // The parent's cache is cold: a normal turn would be free to move to the best-scored account (a) — a fork stays.
    await c.store.set({ sessionId: PARENT, cwd: '/w/one', account: 'c', projectDir: c.dir, lastTurnAtMs: NOW - 3_600_000, justCompacted: false, defaultModel: 'sonnet', accountPin: 'b' });
    await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: 'x', accountPin: 'b', fork: { from: PARENT, at: 'a0' } }, c.sink);
    expect(eng.calls[0]).toMatchObject({ account: 'c', resumeSessionId: PARENT, forkAt: 'a0' });
    expect(moves).toEqual([]);
    expect(c.msgs.some((m) => m.type === 'turn_notice' && /B 계정 .+ — 이번 턴은 C 로 \(고정은 유지\)/.test(m.message))).toBe(true);
    // The pin is kept on the fork, as a normal turn keeps it on its session.
    expect(c.store.get(CHILD)).toMatchObject({ account: 'c', accountPin: 'b' });
  });

  it('pinned account and the parent’s account both unusable: the parent is copied to a third one, the notice names both', async () => {
    const eng = new StubEngine(() => ok(CHILD));
    const moves: { targetProjectsRoot: string }[] = [];
    const c = await setup(eng, { usage: await roomyUsage(), move: async (o) => { moves.push(o); return { ok: true, targetDir: path.join(o.targetProjectsRoot, '-w-one'), targetFile: path.join(o.targetProjectsRoot, '-w-one', o.sessionId + '.jsonl') } as never; } });
    const cd = path.join(path.dirname(path.dirname(c.dir)), 'cooldown');
    writeCooldown(cd, 'b', NOW + 3_600_000);
    writeCooldown(cd, 'c', NOW + 3_600_000);
    await c.store.set({ sessionId: PARENT, cwd: '/w/one', account: 'c', projectDir: c.dir, lastTurnAtMs: NOW - 3_600_000, justCompacted: false, defaultModel: 'sonnet', accountPin: 'b' });
    await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: 'x', accountPin: 'b', fork: { from: PARENT, at: 'a0' } }, c.sink);
    expect(eng.calls[0]).toMatchObject({ account: 'a', resumeSessionId: PARENT, forkAt: 'a0' });
    expect(moves).toHaveLength(1);
    const notices = c.msgs.filter((m) => m.type === 'turn_notice').map((m) => (m as { message: string }).message);
    expect(notices.some((n) => n.includes('B 고정 계정과 C 계정을 지금 쓸 수 없어') && n.includes('A 계정에 복사해 갈래'))).toBe(true);
    expect(c.store.get(CHILD)).toMatchObject({ account: 'a', accountPin: 'b' });
  });

  it('a fork ending does not unmark its parent’s running turn', async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const parentStarted = new Promise<void>((r) => { started = r; });
    const eng = new StubEngine(async (_req, call) => {
      if (call === 0) { started(); await gate; return ok(PARENT); }
      return ok(CHILD);
    });
    const c = await setup(eng);
    await c.store.set({ sessionId: PARENT, cwd: '/w/one', account: 'c', projectDir: c.dir, lastTurnAtMs: null, justCompacted: false, defaultModel: 'sonnet' });
    const parentRun = c.runner.run({ turnId: 'tp', cwd: '/w/one', sessionId: PARENT, text: 'long' }, c.sink);
    await parentStarted;
    await c.runner.run({ turnId: 'tf', cwd: '/w/one', sessionId: null, text: 'x', fork: { from: PARENT, at: 'a0' } }, c.sink);
    expect(await c.runner.trashSession(PARENT)).toMatchObject({ ok: false, error: expect.stringContaining('실행 중') });
    release();
    await parentRun;
  });

  it('works for an index-only parent too', async () => {
    const eng = new StubEngine(() => ok(CHILD));
    const c = await setup(eng);
    await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: 'x', fork: { from: PARENT, at: 'a0' } }, c.sink);
    expect(eng.calls[0]).toMatchObject({ resumeSessionId: PARENT, forkAt: 'a0' });
    expect(c.store.get(CHILD)).toMatchObject({ account: 'c' });
  });

  it('refuses a parent that is no Claude session', async () => {
    const eng = new StubEngine(() => ok(CHILD));
    const c = await setup(eng);
    await c.store.set({ engine: 'codex', sessionId: 'thread-1', cwd: '/w/one', lastTurnAtMs: null, justCompacted: false, defaultModel: 'gpt-6-sol', sandbox: 'read-only', rolloutFile: null, createdAtMs: NOW, title: 't' });
    await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: 'x', fork: { from: 'thread-1', at: 'a0' } }, c.sink);
    expect(eng.calls).toHaveLength(0);
    expect(c.msgs[0]).toMatchObject({ type: 'error', message: expect.stringContaining('편집할 Claude 세션') });
  });
});
