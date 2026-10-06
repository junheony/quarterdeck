import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Account } from '../../shared/accounts';
import type { ServerMessage } from '../../shared/protocol';
import type { Attachment, AttachmentStore } from '../attachments/AttachmentStore';
import { ClaudeEngine } from '../engine/ClaudeEngine';
import { fakeSdk, sdk } from '../engine/fakeSdk';
import { SessionIndex } from '../sessions/SessionIndex';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore } from './SessionState';
import { TurnRunner, type TurnRunnerDeps, type TurnSink } from './TurnRunner';
import { rootsOf, testRegistry } from '../../shared/accounts.testkit';

const NOW = Date.parse('2026-09-30T12:30:00Z');

async function setup(over: Partial<Pick<TurnRunnerDeps, 'attachments'>> & { readFile?: (p: string) => Promise<Buffer> } = {}) {
  const f = fakeSdk();
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-trbg-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') } as Record<Account, string>;
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }), now: () => new Date(NOW) });
  const deps: TurnRunnerDeps = {
    accounts: testRegistry(),
    engine: new ClaudeEngine({ accounts: testRegistry(), queryFn: f.queryFn, readFile: over.readFile ?? (async () => Buffer.from('')) }),
    usage,
    index: new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'projects.json') }),
    store,
    cooldownDir: path.join(base, 'cooldown'),
    protectedAccount: 'a',
    auditFile: path.join(base, 'audit.log'),
    projectsRoots: rootsOf(roots),
    codex: null,
    attachments: over.attachments ?? null,
    codexSessionsRoot: path.join(base, 'codex-sessions'),
    now: () => NOW,
    maxRetries: 0,
  };
  const msgs: ServerMessage[] = [];
  const ac = new AbortController();
  const sink: TurnSink = { emit: (m) => msgs.push(m), askPermission: async () => 'once', askQuestion: async () => null, signal: ac.signal };
  const runner = new TurnRunner(deps);
  return { f, msgs, sink, ac, runner, store };
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const of = (msgs: ServerMessage[], type: ServerMessage['type']) => msgs.filter((m) => m.type === type) as (ServerMessage & Record<string, unknown>)[];

describe('TurnRunner: background work after the turn result', () => {
  it('streams the continuation as its own turn with a 백그라운드 계속 marker and badge', async () => {
    const { f, msgs, sink, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'explore repo' }]), sdk.delta('launched'), sdk.result('launched', 's1'));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    expect(of(msgs, 'turn_background')).toMatchObject([{ type: 'turn_background', turnId: 't1', sessionId: 's1', cwd: '/w/new', tasks: ['explore repo'] }]);
    expect(runner.backgroundSessions()).toEqual(['s1']);

    f.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('found'), sdk.result('found', 's1'));
    await done;
    const started = of(msgs, 'turn_started');
    expect(started.map((m) => [m.turnId, m.reason])).toEqual([['t1', expect.any(String)], ['t1:bg1', '백그라운드 계속']]);
    expect(of(msgs, 'turn_notice').at(-1)).toMatchObject({ turnId: 't1:bg1', message: expect.stringContaining('백그라운드 계속') });
    expect(of(msgs, 'delta').map((m) => [m.turnId, m.text])).toEqual([['t1', 'launched'], ['t1:bg1', 'found']]);
    const results = of(msgs, 'turn_result');
    expect(results[1]).toMatchObject({ turnId: 't1:bg1', ok: true, text: 'found', badge: { reason: '백그라운드 계속', usage: { outputTokens: 2 } } });
    expect(of(msgs, 'turn_background').at(-1)).toMatchObject({ tasks: [] });
    expect(runner.backgroundSessions()).toEqual([]);
    expect(runner.followUp('s1', { turnId: 'late', text: 'x' })).toBe(false);
    expect(f.state.calls).toBe(1);
  });

  it('a background task settling after the turn result emits task_done (drives the push)', async () => {
    const { f, msgs, sink, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    f.push(sdk.taskDone('x'), sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('built'), sdk.result('built', 's1'));
    await done;
    expect(of(msgs, 'task_done')).toMatchObject([{ type: 'task_done', turnId: 't1', sessionId: 's1', cwd: '/w/new', status: 'completed', summary: 'done' }]);
    expect(of(msgs, 'turn_result').map((m) => m.turnId)).toEqual(['t1', 't1:bg1']);
  });

  it('a follow-up while waiting goes into the same process at once; one during a continuation waits for its result', async () => {
    const { f, msgs, sink, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');

    expect(runner.followUp('s1', { turnId: 'f1', text: 'status?', clientRef: 'r1', model: 'sonnet' })).toBe(true);
    await waitFor(() => f.inputs.length === 2, 'follow-up written');
    expect(of(msgs, 'turn_started').at(-1)).toMatchObject({ turnId: 'f1', clientRef: 'r1', reason: '백그라운드 대기 중 이어 보냄' });
    f.push(sdk.delta('still building'), sdk.result('still building', 's1'));
    await waitFor(() => of(msgs, 'turn_result').length === 2, 'follow-up result');
    expect(of(msgs, 'turn_result')[1]).toMatchObject({ turnId: 'f1', text: 'still building', badge: { modelNote: '백그라운드 대기 중인 프로세스의 모델 유지' } });

    // Background finishes; while its continuation streams, another message arrives and is queued.
    f.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('built'));
    await waitFor(() => of(msgs, 'delta').some((m) => m.text === 'built'), 'continuation output');
    expect(runner.followUp('s1', { turnId: 'f2', text: 'ship it' })).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(f.inputs).toHaveLength(2);
    f.push(sdk.result('built', 's1'));
    await waitFor(() => f.inputs.length === 3, 'queued follow-up written after the continuation');
    expect(of(msgs, 'turn_started').map((m) => m.turnId)).toEqual(['t1', 'f1', 't1:bg1', 'f2']);
    f.push(sdk.result('shipped', 's1'));
    await done;
    expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.text])).toEqual([['t1', 'launched'], ['f1', 'still building'], ['t1:bg1', 'built'], ['f2', 'shipped']]);
  });

  it('stop while a continuation streams ends it as 중단됨 and refuses the queued follow-up with its clientRef', async () => {
    const { f, msgs, sink, ac, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    f.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('working'));
    await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
    expect(runner.followUp('s1', { turnId: 'f1', text: 'next', clientRef: 'r9' })).toBe(true);
    ac.abort();
    await done;
    expect(of(msgs, 'turn_result').at(-1)).toMatchObject({ turnId: 't1:bg1', ok: false, errorText: '중단됨' });
    expect(of(msgs, 'error')).toEqual([expect.objectContaining({ turnId: 'f1', clientRef: 'r9' })]);
    expect(runner.backgroundSessions()).toEqual([]);
  });

  it('a follow-up that could not be written after its turn_started also sends an error with its clientRef (its accepted ref is taken back)', async () => {
    const img: Attachment = { id: 'i1', name: 'a.png', mediaType: 'image/png', size: 1, path: '/gone/a.png', isImage: true, createdAtMs: 0 };
    const attachments = { resolve: () => ({ found: [img], missing: [] }) } as unknown as AttachmentStore;
    const { f, msgs, sink, runner } = await setup({ attachments, readFile: async () => { throw new Error('gone'); } });
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    expect(runner.followUp('s1', { turnId: 'f1', text: 'look', attachments: ['i1'], clientRef: 'r1' })).toBe(true);
    await waitFor(() => of(msgs, 'error').length === 1, 'refusal');
    expect(of(msgs, 'turn_started').at(-1)).toMatchObject({ turnId: 'f1', clientRef: 'r1' });
    expect(of(msgs, 'turn_result').at(-1)).toMatchObject({ turnId: 'f1', ok: false, errorText: '메시지를 보내지 못했습니다' });
    expect(of(msgs, 'error')[0]).toMatchObject({ turnId: 'f1', clientRef: 'r1', message: '메시지를 보내지 못했습니다' });
    f.push(sdk.bgLevel([]));
    f.end();
    await done;
  });

  it('no background work: no follow-up channel, nothing after the result', async () => {
    const { f, msgs, sink, runner } = await setup();
    f.push(sdk.init('s1'), sdk.delta('ok'), sdk.result('ok', 's1'));
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    expect(msgs.map((m) => m.type)).toEqual(['turn_started', 'delta', 'turn_result']);
    expect(runner.followUp('s1', { turnId: 'f', text: 'x' })).toBe(false);
  });
});
