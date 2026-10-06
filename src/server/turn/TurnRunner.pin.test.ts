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
import { TurnRunner, type TurnRunnerDeps, type TurnSink } from './TurnRunner';
import { rootsOf, testRegistry } from '../../shared/accounts.testkit';

const NOW = Date.parse('2026-09-30T12:30:00Z');
const SID = '22222222-2222-4222-8222-222222222222';

function card(id: string, s: number, w: number, resetH: number) {
  const resetsAt = new Date(NOW + resetH * 3_600_000).toISOString();
  return { id, status: 'ok', fetchedAt: new Date(NOW - 10_000).toISOString(), rows: [
    { label: 'Session (5h)', used: s, resetsAt }, { label: 'Weekly (7d)', used: w, resetsAt }, { label: 'Fable (7d)', used: 0, resetsAt } ] };
}

async function usageWith(a: [number, number], b: [number, number], c: [number, number]) {
  const state = { cards: [card('claude:main', ...a, 154), card('claude:second', ...b, 84), card('claude:third', ...c, 36)] };
  const u = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => state }), now: () => new Date(NOW) });
  await u.pollOnce();
  return u;
}

async function setup(engine: StubEngine, usage?: UsageService) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-pin-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') } as Record<Account, string>;
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'projects.json') });
  const stateFile = path.join(base, 'state.json');
  const store = new SessionStateStore(stateFile);
  await store.load();
  const moves: { targetProjectsRoot: string }[] = [];
  const deps: TurnRunnerDeps = {
    accounts: testRegistry(),
    engine, index, store, usage: usage ?? (await usageWith([13, 7], [2, 3], [0, 40])),
    cooldownDir: path.join(base, 'cooldown'), protectedAccount: 'a', auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots),
    codex: null, attachments: null, codexSessionsRoot: path.join(base, 'codex'),
    move: async (o) => { moves.push(o); return { ok: true, targetDir: path.join(o.targetProjectsRoot, path.basename(o.sourceProjectDir)), targetFile: '', copied: [] }; },
    now: () => NOW, maxRetries: 2,
  };
  const msgs: ServerMessage[] = [];
  const sink: TurnSink = { emit: (m) => msgs.push(m), askPermission: async () => 'once', askQuestion: async () => null, signal: new AbortController().signal };
  const seed = async (account: Account) => {
    const dir = path.join(roots[account]!, '-w-one');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${SID}.jsonl`), JSON.stringify({ type: 'user', cwd: '/w/one', message: { role: 'user', content: 'seed' } }) + '\n');
    await index.refresh();
    return dir;
  };
  return { deps, store, stateFile, roots, moves, msgs, sink, seed };
}

const ok = (sid: string): EngineEvent[] => [{ kind: 'init', sessionId: sid, model: 'claude-opus-5-5' }, { kind: 'delta', text: 'ok' }, okResult(sid)];
const of = <T extends ServerMessage['type']>(msgs: ServerMessage[], t: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === t);

describe('TurnRunner · 고정 계정 (이 세션은 B 써)', () => {
  it('a pin set on an index-only session persists across a restart; the next turn moves there and the badge says pinned', async () => {
    const eng = new StubEngine(() => ok(SID));
    const c = await setup(eng);
    const dir = await c.seed('b');
    const runner = new TurnRunner(c.deps);
    expect(await runner.setAccountPin(SID, 'c')).toBe(true);
    expect(await runner.setAccountPin('nope', 'c')).toBe(false);
    const reloaded = new SessionStateStore(c.stateFile);
    await reloaded.load();
    expect(reloaded.get(SID)).toMatchObject({ account: 'b', projectDir: dir, accountPin: 'c' });

    // Warm on B (would stay unpinned) → pinned C wins.
    await c.store.set({ ...c.store.get(SID)!, lastTurnAtMs: NOW - 60_000 });
    await runner.run({ turnId: 't1', cwd: '/w/one', sessionId: SID, text: 'go' }, c.sink);
    expect(c.moves.map((m) => m.targetProjectsRoot)).toEqual([c.roots.c]);
    expect(eng.calls[0]).toMatchObject({ account: 'c', resumeSessionId: SID });
    expect(of(c.msgs, 'turn_result')[0]).toMatchObject({ ok: true, badge: { account: 'c', pinned: true, reason: expect.stringContaining('고정 C') } });
    expect(c.store.get(SID)).toMatchObject({ account: 'c', accountPin: 'c' });

    // Back to 자동: warm on C now, so it stays; no pin marker.
    expect(await runner.setAccountPin(SID, null)).toBe(true);
    c.msgs.length = 0;
    await runner.run({ turnId: 't2', cwd: '/w/one', sessionId: SID, text: 'go' }, c.sink);
    expect(eng.calls[1]?.account).toBe('c');
    expect(of(c.msgs, 'turn_result')[0]?.badge?.pinned).toBeUndefined();
    expect(c.store.get(SID)).not.toHaveProperty('accountPin');
  });

  it('pinned account at its limit: the router picks for this turn, a notice says so, the pin stays', async () => {
    const eng = new StubEngine(() => ok(SID));
    const c = await setup(eng, await usageWith([13, 7], [2, 96], [0, 40]));
    const dir = await c.seed('b');
    await c.store.set({ sessionId: SID, cwd: '/w/one', account: 'b', projectDir: dir, lastTurnAtMs: NOW - 60_000, justCompacted: false, defaultModel: 'opus', accountPin: 'b' });
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/one', sessionId: SID, text: 'go' }, c.sink);
    expect(eng.calls[0]?.account).toBe('c');
    expect(of(c.msgs, 'turn_notice').map((m) => m.message)).toContain('B 계정 한도 도달 — 이번 턴은 C 로 (고정은 유지)');
    expect(of(c.msgs, 'turn_result')[0]?.badge).toMatchObject({ account: 'c' });
    expect(of(c.msgs, 'turn_result')[0]?.badge?.pinned).toBeUndefined();
    expect(c.store.get(SID)).toMatchObject({ account: 'c', accountPin: 'b' });
  });

  it('a new session pinned to the protected account (A) opens there and keeps the pin', async () => {
    const eng = new StubEngine(() => ok('new-a'));
    const c = await setup(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi', accountPin: 'a' }, c.sink);
    expect(eng.calls[0]?.account).toBe('a');
    expect(of(c.msgs, 'turn_result')[0]?.badge).toMatchObject({ account: 'a', pinned: true });
    expect(c.store.get('new-a')).toMatchObject({ account: 'a', accountPin: 'a' });
  });

  it('a pin changed while a turn runs is not undone by that turn saving its state', async () => {
    let c!: Awaited<ReturnType<typeof setup>>;
    const eng = new StubEngine(async () => { await c.store.setAccountPin(SID, 'c'); return ok(SID); });
    c = await setup(eng);
    const dir = await c.seed('b');
    await c.store.set({ sessionId: SID, cwd: '/w/one', account: 'b', projectDir: dir, lastTurnAtMs: NOW - 60_000, justCompacted: false, defaultModel: 'opus', accountPin: 'b' });
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/one', sessionId: SID, text: 'go' }, c.sink);
    expect(eng.calls[0]?.account).toBe('b');
    expect(c.store.get(SID)).toMatchObject({ account: 'b', accountPin: 'c' });
  });
});
