import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ServerMessage } from '../../shared/protocol';
import type { CodexEngine, CodexTurnRequest } from '../engine/CodexEngine';
import type { EngineEvent } from '../engine/Engine';
import { StubEngine } from '../engine/StubEngine';
import { liveRolloutNotice } from '../sessions/CodexImports';
import { SessionIndex } from '../sessions/SessionIndex';
import { DESKTOP_ID, writeFixtures } from '../sessions/codexFixtures';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore } from './SessionState';
import { TurnRunner, type TurnSink } from './TurnRunner';
import { rootsOf, testRegistry } from '../../shared/accounts.testkit';

let base: string;
let work: string;
let root: string;
let files: { desktop: string; cli: string };
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-tr-import-'));
  work = path.join(base, 'work');
  root = path.join(base, 'codex-sessions');
  await fs.mkdir(work);
  files = await writeFixtures(root, work);
});
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

async function setup(opts: { autoApprove?: boolean } = {}) {
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json'), codexRoot: root });
  await index.refresh();
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const calls: CodexTurnRequest[] = [];
  const codex: Pick<CodexEngine, 'runTurn'> = {
    async *runTurn(req) {
      calls.push(req);
      const tid = req.resumeThreadId ?? 'new';
      const evs: EngineEvent[] = [{ kind: 'delta', text: 'ok' }, { kind: 'result', sessionId: tid, ok: true, text: 'ok', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, errorText: null, stderr: null, errorKind: null, terminalReason: 'completed' }];
      for (const e of evs) yield e;
    },
  };
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }) });
  const runner = new TurnRunner({ accounts: testRegistry(),
    engine: new StubEngine(async () => []), codex, attachments: null, usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null,
    auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots), codexSessionsRoot: root, defaultPermissionMode: () => (opts.autoApprove ? 'bypassPermissions' : 'default'),
    findRollout: async () => { throw new Error('the imported rollout is already known'); }, readRateLimits: async () => null,
  });
  const msgs: ServerMessage[] = [];
  const sink: TurnSink = { emit: (m) => msgs.push(m), askPermission: async () => 'once', askQuestion: async () => null, signal: new AbortController().signal };
  return { runner, store, index, calls, msgs, sink };
}

describe('TurnRunner: continuing an imported Codex thread', () => {
  it('resumes the thread in its cwd under deck\'s sandbox, then stores it as a deck Codex session', async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(files.desktop, old, old);
    const c = await setup();
    await c.runner.run({ turnId: 't1', cwd: '/elsewhere', sessionId: DESKTOP_ID, text: '이어서 해줘', model: 'gpt-6-sol' }, c.sink);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]).toMatchObject({ resumeThreadId: DESKTOP_ID, cwd: work, model: 'gpt-6-sol', sandbox: 'workspace-write', prompt: '이어서 해줘' });
    expect(c.msgs.find((m) => m.type === 'turn_result')).toMatchObject({ ok: true, sessionId: DESKTOP_ID });
    expect(c.msgs.some((m) => m.type === 'turn_notice')).toBe(false);
    expect(c.store.get(DESKTOP_ID)).toMatchObject({ engine: 'codex', cwd: work, sandbox: 'workspace-write', rolloutFile: files.desktop, title: '스크린샷의 버그 고쳐줘', defaultModel: 'gpt-6-sol' });
    // From now on it is listed once, as deck's own session.
    const listed = c.index.projects(c.store.codexEntries()).flatMap((p) => p.sessions).filter((s) => s.sessionId === DESKTOP_ID);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.imported).toBeUndefined();
  });

  it('setSandbox before its first deck turn: kept in memory, used and stored by that turn', async () => {
    const c = await setup();
    expect(await c.runner.setSandbox(DESKTOP_ID, 'read-only')).toBe(true);
    expect(c.runner.importSandboxOf(DESKTOP_ID)).toBe('read-only');
    await c.runner.run({ turnId: 't1', cwd: work, sessionId: DESKTOP_ID, text: 'go' }, c.sink);
    expect(c.calls[0]).toMatchObject({ resumeThreadId: DESKTOP_ID, sandbox: 'read-only' });
    expect(c.store.get(DESKTOP_ID)).toMatchObject({ engine: 'codex', sandbox: 'read-only' });
    expect(c.runner.importSandboxOf(DESKTOP_ID)).toBeNull();
  });

  it('setSandbox racing the first turn: if that turn stores the session during the import check, the pick goes to the store', async () => {
    const c = await setup();
    const fresh = c.index.freshCodexImport.bind(c.index);
    c.index.freshCodexImport = async (id: string) => {
      c.index.freshCodexImport = fresh; // the turn itself checks the import too
      const r = await fresh(id);
      await c.runner.run({ turnId: 't1', cwd: work, sessionId: DESKTOP_ID, text: 'go' }, c.sink);
      return r;
    };
    expect(await c.runner.setSandbox(DESKTOP_ID, 'read-only')).toBe(true);
    expect(c.store.get(DESKTOP_ID)).toMatchObject({ engine: 'codex', sandbox: 'read-only' });
    expect(c.runner.importSandboxOf(DESKTOP_ID)).toBeNull();
  });

  it('warns (without blocking) when the rollout changed in the last 2 minutes; the write sandbox is the default', async () => {
    const c = await setup();
    await c.runner.run({ turnId: 't1', cwd: work, sessionId: DESKTOP_ID, text: 'go' }, c.sink);
    expect(c.calls[0]).toMatchObject({ resumeThreadId: DESKTOP_ID, sandbox: 'workspace-write' });
    expect(c.msgs.find((m) => m.type === 'turn_notice')).toMatchObject({ message: expect.stringContaining('「스크린샷의 버그 고쳐줘」 GPT 대화의 기록 파일이'), sessionId: DESKTOP_ID });
    expect((c.msgs.find((m) => m.type === 'turn_notice') as { message: string }).message).toBe(liveRolloutNotice('스크린샷의 버그 고쳐줘', 0));
    expect(c.msgs.find((m) => m.type === 'turn_result')).toMatchObject({ ok: true });
  });
});
