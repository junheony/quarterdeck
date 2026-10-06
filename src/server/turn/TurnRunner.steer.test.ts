import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Account } from '../../shared/accounts';
import type { ServerMessage } from '../../shared/protocol';
import { ClaudeEngine } from '../engine/ClaudeEngine';
import type { CodexEngine } from '../engine/CodexEngine';
import type { EngineEvent } from '../engine/Engine';
import { fakeSdk, sdk } from '../engine/fakeSdk';
import { SessionIndex } from '../sessions/SessionIndex';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore } from './SessionState';
import { TurnRunner, type TurnRunnerDeps, type TurnSink } from './TurnRunner';
import { rootsOf, testRegistry } from '../../shared/accounts.testkit';

const NOW = Date.parse('2026-09-30T12:30:00Z');

/** Every account usable (a retry needs somewhere to go). */
async function usableAccounts(): Promise<UsageService> {
  const resetsAt = new Date(NOW + 3_600_000).toISOString();
  const card = (id: string) => ({ id, status: 'ok', fetchedAt: new Date(NOW - 10_000).toISOString(), rows: [
    { label: 'Session (5h)', used: 5, resetsAt }, { label: 'Weekly (7d)', used: 5, resetsAt }, { label: 'Fable (7d)', used: 5, resetsAt }] });
  const state = { cards: [card('claude:main'), card('claude:second'), card('claude:third')] };
  const u = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => state }), now: () => new Date(NOW) });
  await u.pollOnce();
  return u;
}

async function setup(over: Partial<TurnRunnerDeps> = {}) {
  const f = fakeSdk();
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-trsteer-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') } as Record<Account, string>;
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }), now: () => new Date(NOW) });
  const deps: TurnRunnerDeps = {
    accounts: testRegistry(),
    engine: new ClaudeEngine({ accounts: testRegistry(), queryFn: f.queryFn, readFile: async () => Buffer.from('') }),
    usage,
    index: new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'projects.json') }),
    store,
    cooldownDir: path.join(base, 'cooldown'),
    protectedAccount: 'a',
    auditFile: path.join(base, 'audit.log'),
    projectsRoots: rootsOf(roots),
    codex: null,
    attachments: null,
    codexSessionsRoot: path.join(base, 'codex-sessions'),
    move: async (o) => ({ ok: true, targetDir: path.join(o.targetProjectsRoot, path.basename(o.sourceProjectDir)), targetFile: '', copied: [] }),
    now: () => NOW,
    maxRetries: 0,
    ...over,
  };
  const msgs: ServerMessage[] = [];
  const ac = new AbortController();
  const sink: TurnSink = { emit: (m) => msgs.push(m), askPermission: async () => 'once', askQuestion: async () => null, signal: ac.signal };
  return { f, msgs, sink, ac, runner: new TurnRunner(deps) };
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const of = (msgs: ServerMessage[], type: ServerMessage['type']) => msgs.filter((m) => m.type === type) as (ServerMessage & Record<string, unknown>)[];
const textOf = (m: SDKUserMessage) => (typeof m.message.content === 'string' ? m.message.content : '');
/** The CLI's --replay-user-messages echo of a consumed user message. */
const replay = (m: SDKUserMessage) => ({ type: 'user', isReplay: true, uuid: m.uuid, parent_tool_use_id: null, message: m.message, session_id: 's1' });
const resultFor = (text: string, uuids: (string | undefined)[]) => ({ ...sdk.result(text), user_message_uuid: uuids.at(-1), user_message_uuids: uuids });
const toolCall = (id: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] }, session_id: 's1' });
const toolResult = (id: string) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'a' }] }, session_id: 's1' });
const prompt = (text: string) => ({ text, attachments: [] });

describe('TurnRunner: steering a running Claude turn', () => {
  it('a steer is written with priority next and folded into the same turn: delivered at the tool boundary, one result', async () => {
    const { f, msgs, sink, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    await waitFor(() => f.inputs.length === 1, 'prompt written');
    f.push(sdk.init('s1'), sdk.delta('looking'), toolCall('tu1'));
    await waitFor(() => of(msgs, 'tool_call').length === 1, 'tool call');
    expect(await runner.steer('t1', { steerId: 'k1', text: 'also check b', prompt: prompt('also check b') })).toBe(true);
    await waitFor(() => f.inputs.length === 2, 'steer written');
    const [first, steer] = f.inputs as [SDKUserMessage, SDKUserMessage];
    expect(steer).toMatchObject({ type: 'user', priority: 'next', parent_tool_use_id: null });
    expect(textOf(steer)).toBe('also check b');
    expect(steer.uuid).toBeTruthy();
    expect(first.priority).toBeUndefined();
    expect(first.uuid).toBeTruthy();
    // The CLI folds it in after the tool round (echo), answers, and reports both uuids on the one result.
    f.push(toolResult('tu1'), replay(steer), sdk.delta('b too'), resultFor('b too', [first.uuid, steer.uuid]));
    await done;
    expect(of(msgs, 'steer_delivered')).toEqual([{ type: 'steer_delivered', turnId: 't1', sessionId: 's1', cwd: '/w/new', steerId: 'k1', prompt: prompt('also check b') }]);
    // Delivered between the tool result and the rest of the answer.
    const order = msgs.filter((m) => m.type !== 'turn_progress').map((m) => m.type);
    expect(order.indexOf('steer_delivered')).toBeGreaterThan(order.indexOf('tool_result'));
    expect(order.indexOf('steer_delivered')).toBeLessThan(order.lastIndexOf('delta'));
    expect(of(msgs, 'turn_result')).toHaveLength(1);
    expect(of(msgs, 'turn_result')[0]).toMatchObject({ turnId: 't1', ok: true, text: 'b too' });
    expect(of(msgs, 'turn_started')).toHaveLength(1);
    expect(of(msgs, 'steer_rejected')).toHaveLength(0);
    expect(f.state.inputClosed).toBe(true);
    // The turn is over: no more steering.
    expect(await runner.steer('t1', { steerId: 'k2', text: 'late', prompt: prompt('late') })).toBe(false);
  });

  it('a steer that came after the last tool round runs as its own turn segment right after the result', async () => {
    const { f, msgs, sink, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    await waitFor(() => f.inputs.length === 1, 'prompt written');
    f.push(sdk.init('s1'), sdk.delta('answer'));
    await waitFor(() => of(msgs, 'delta').length === 1, 'delta');
    expect(await runner.steer('t1', { steerId: 'k1', text: 'and then?', prompt: prompt('and then?') })).toBe(true);
    await waitFor(() => f.inputs.length === 2, 'steer written');
    const [first, steer] = f.inputs as [SDKUserMessage, SDKUserMessage];
    f.push(resultFor('answer', [first.uuid]));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    // The process stays open for the steer (it is unanswered), then the CLI runs it as the next turn.
    expect(f.state.inputClosed).toBe(false);
    f.push(replay(steer), sdk.delta('then this'), resultFor('then this', [steer.uuid]));
    await done;
    expect(of(msgs, 'turn_started').map((m) => [m.turnId, m.reason])).toEqual([['t1', expect.any(String)], ['t1:s1', '실행 중 보낸 메시지']]);
    expect(of(msgs, 'steer_delivered')).toMatchObject([{ turnId: 't1:s1', steerId: 'k1', prompt: prompt('and then?') }]);
    expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.text])).toEqual([['t1', 'answer'], ['t1:s1', 'then this']]);
    expect(of(msgs, 'delta').map((m) => [m.turnId, m.text])).toEqual([['t1', 'answer'], ['t1:s1', 'then this']]);
    expect(f.state.calls).toBe(1);
  });

  it('a result naming a steer whose echo never came still reports it delivered (before the result)', async () => {
    const { f, msgs, sink, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    await waitFor(() => f.inputs.length === 1, 'prompt written');
    f.push(sdk.init('s1'));
    expect(await runner.steer('t1', { steerId: 'k1', text: 'x', prompt: prompt('x') })).toBe(true);
    await waitFor(() => f.inputs.length === 2, 'steer written');
    const [first, steer] = f.inputs as [SDKUserMessage, SDKUserMessage];
    f.push(resultFor('done', [first.uuid, steer.uuid]));
    await done;
    const types = msgs.map((m) => m.type);
    expect(types.indexOf('steer_delivered')).toBeLessThan(types.indexOf('turn_result'));
    expect(of(msgs, 'turn_result')).toHaveLength(1);
  });

  it('no running turn or a missing attachment: refused; a repeated id is ignored (null: no second answer)', async () => {
    const { f, msgs, sink, runner } = await setup();
    expect(await runner.steer('nope', { steerId: 'k1', text: 'x', prompt: prompt('x') })).toBe(false);
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    await waitFor(() => f.inputs.length === 1, 'prompt written');
    f.push(sdk.init('s1'));
    expect(await runner.steer('t1', { steerId: 'k1', text: 'x', prompt: prompt('x') })).toBe(true);
    expect(await runner.steer('t1', { steerId: 'k1', text: 'again', prompt: prompt('again') })).toBeNull();
    expect(await runner.steer('t1', { steerId: 'k2', text: 'file', attachments: ['att_missing'], prompt: prompt('file') })).toBe(false);
    f.push(resultFor('done', [f.inputs[0]!.uuid, f.inputs[1]!.uuid]));
    await done;
    expect(f.inputs).toHaveLength(2);
    expect(of(msgs, 'turn_result')).toHaveLength(1);
  });

  it('the process ending with a steer still waiting rejects it (the device sends it after the turn)', async () => {
    const { f, msgs, sink, ac, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    await waitFor(() => f.inputs.length === 1, 'prompt written');
    f.push(sdk.init('s1'), toolCall('tu1'));
    await waitFor(() => of(msgs, 'tool_call').length === 1, 'tool call');
    expect(await runner.steer('t1', { steerId: 'k1', text: 'x', prompt: prompt('x') })).toBe(true);
    ac.abort();
    await done;
    expect(of(msgs, 'steer_rejected')).toMatchObject([{ steerId: 'k1', turnId: 't1' }]);
    expect(of(msgs, 'steer_delivered')).toHaveLength(0);
  });

  it('a retry (limit → next account) resends only the turn prompt and rejects the waiting steer', async () => {
    const { f, msgs, sink, runner } = await setup({ maxRetries: 1, usage: await usableAccounts() });
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    await waitFor(() => f.inputs.length === 1, 'prompt written');
    f.push(sdk.init('s1'));
    expect(await runner.steer('t1', { steerId: 'k1', text: 'steer me', prompt: prompt('steer me') })).toBe(true);
    await waitFor(() => f.inputs.length === 2, 'steer written');
    f.push({ type: 'result', subtype: 'success', is_error: true, result: 'usage limit reached', session_id: 's1', usage: {} });
    await waitFor(() => of(msgs, 'turn_retry').length === 1, 'retry');
    expect(of(msgs, 'steer_rejected')).toMatchObject([{ steerId: 'k1' }]);
    await waitFor(() => f.inputs.length === 3, 'retry prompt written');
    f.push(sdk.init('s1'), resultFor('ok', [f.inputs[2]!.uuid]));
    await done;
    expect(f.inputs.map(textOf)).toEqual(['go', 'steer me', 'go']);
    expect(of(msgs, 'turn_result')).toHaveLength(1);
    expect(of(msgs, 'turn_result')[0]).toMatchObject({ ok: true });
    expect(of(msgs, 'steer_rejected')).toHaveLength(1);
  });

  it('a steer settled while still being written (process ended meanwhile) is answered once: rejected, and steer() says nothing more', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const g = fakeSdk();
    const engine = new ClaudeEngine({ accounts: testRegistry(), queryFn: g.queryFn, readFile: async () => { await gate; return Buffer.from('png'); } });
    const att = { id: 'att_1', name: 'a.png', mediaType: 'image/png', size: 3, path: '/tmp/a.png', isImage: true, createdAtMs: NOW };
    const { msgs, sink, ac, runner } = await setup({ engine, attachments: { resolve: () => ({ found: [att], missing: [] }) } as unknown as TurnRunnerDeps['attachments'] });
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    await waitFor(() => g.inputs.length === 1, 'prompt written');
    g.push(sdk.init('s1'));
    const pending = runner.steer('t1', { steerId: 'k1', text: 'see this', attachments: ['att_1'], prompt: prompt('see this') });
    ac.abort();
    await done;
    expect(of(msgs, 'steer_rejected')).toMatchObject([{ steerId: 'k1' }]);
    release();
    expect(await pending).toBeNull();
    expect(of(msgs, 'steer_rejected')).toHaveLength(1);
  });

  it('DECK_STEER=0 (engine steer: false): no live steer, so steer() refuses; follow-up bookkeeping still closes the process', async () => {
    const g = fakeSdk();
    const { msgs, sink, runner } = await setup({ engine: new ClaudeEngine({ accounts: testRegistry(), queryFn: g.queryFn, readFile: async () => Buffer.from(''), steer: false }) });
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    await waitFor(() => g.inputs.length === 1, 'prompt written');
    g.push(sdk.init('s1'));
    expect(await runner.steer('t1', { steerId: 'k1', text: 'x', prompt: prompt('x') })).toBe(false);
    g.push(resultFor('ok', [g.inputs[0]!.uuid]));
    await done;
    expect(g.inputs).toHaveLength(1);
    expect(g.state.inputClosed).toBe(true);
    expect(of(msgs, 'turn_result')).toHaveLength(1);
  });

  it('a handoff-note turn (no tools) takes no steers', async () => {
    const { f, sink, runner } = await setup();
    const done = runner.run({ turnId: 'h1', cwd: '/w/new', sessionId: null, text: 'write the note', handoff: true }, sink);
    await waitFor(() => f.inputs.length === 1, 'prompt written');
    f.push(sdk.init('s1'));
    expect(await runner.steer('h1', { steerId: 'k1', text: 'x', prompt: prompt('x') })).toBe(false);
    f.push(resultFor('note', [f.inputs[0]!.uuid]));
    await done;
    expect(f.inputs).toHaveLength(1);
  });

  it('a Codex turn has no live input: steer is refused', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const codex: Pick<CodexEngine, 'runTurn'> = {
      async *runTurn() {
        yield { kind: 'init', sessionId: 'th1', model: 'gpt' } as EngineEvent;
        await gate;
        yield { kind: 'result', sessionId: 'th1', ok: true, text: 'ok', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, errorText: null, stderr: null, errorKind: null, terminalReason: 'completed' } as EngineEvent;
      },
    };
    const { msgs, sink, runner } = await setup({ codex: codex as CodexEngine, findRollout: async () => null, readRateLimits: async () => null });
    const done = runner.run({ turnId: 'c1', cwd: '/w/new', sessionId: null, text: 'go', engine: 'codex', model: 'gpt-6-sol' }, sink);
    await waitFor(() => of(msgs, 'turn_started').length === 1, 'codex turn started');
    expect(of(msgs, 'turn_started')[0]).toMatchObject({ engine: 'codex' });
    expect(await runner.steer('c1', { steerId: 'k1', text: 'x', prompt: prompt('x') })).toBe(false);
    release();
    await done;
    expect(of(msgs, 'steer_delivered')).toHaveLength(0);
  });
});
