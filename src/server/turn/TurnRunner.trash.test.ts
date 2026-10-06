import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Account } from '../../shared/accounts';
import { StubEngine } from '../engine/StubEngine';
import { SessionIndex } from '../sessions/SessionIndex';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore } from './SessionState';
import { TurnRunner } from './TurnRunner';
import { rootsOf, testRegistry } from '../../shared/accounts.testkit';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const SID = '44444444-4444-4444-8444-444444444444';
const DIR = '-w-one';
const line = JSON.stringify({ type: 'user', cwd: '/w/one', message: { role: 'user', content: 'hi' } }) + '\n';

/** Profiles a/b/c share one config dir here (base), so their copies share one trash entry. */
async function setup() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-trash-runner-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') } as Record<Account, string>;
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json') });
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
  const runner = new TurnRunner({ accounts: testRegistry(),
    engine: new StubEngine(async () => []), usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: 'a', auditFile: path.join(base, 'audit.log'),
    projectsRoots: rootsOf(roots), codex: null, attachments: null, codexSessionsRoot: path.join(base, 'codex'), homeAccount: 'a', now: () => NOW,
  });
  const put = async (a: Account, mtimeMs: number) => {
    const f = path.join(roots[a]!, DIR, `${SID}.jsonl`);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, line);
    await fs.utimes(f, mtimeMs / 1000, mtimeMs / 1000);
    return f;
  };
  return { base, roots, index, runner, put };
}

const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

describe('TurnRunner: 삭제 (session-trash)', () => {
  it('moves both profile copies to the trash and puts them back on undo', async () => {
    const c = await setup();
    const fa = await c.put('a', NOW - 3_600_000);
    const fb = await c.put('b', NOW - 3_600_000);
    await c.index.refresh();
    const r = await c.runner.trashSession(SID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await exists(fa)).toBe(false);
    expect(await exists(fb)).toBe(false);
    const entry = path.join(c.base, 'session-trash', r.trashId);
    expect((await fs.readdir(entry)).sort()).toEqual([`${SID}.jsonl`, 'copy-1', 'manifest.json']);
    const back = await c.runner.restoreSession(r.trashId);
    expect(back).toEqual({ ok: true, sessionId: SID });
    expect(await fs.readFile(fa, 'utf8')).toBe(line);
    expect(await fs.readFile(fb, 'utf8')).toBe(line);
    expect(await exists(entry)).toBe(false);
  });

  it('refuses a session another program wrote moments ago (Desktop live) and unknown sessions', async () => {
    const c = await setup();
    const fa = await c.put('a', NOW - 10_000);
    await c.index.refresh();
    const r = await c.runner.trashSession(SID);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/다른 곳/) });
    expect(await exists(fa)).toBe(true);
    expect((await c.runner.trashSession('99999999-9999-4999-8999-999999999999')).ok).toBe(false);
  });
});
