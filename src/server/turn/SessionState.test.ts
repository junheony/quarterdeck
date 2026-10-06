import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStateStore, isCodexState } from './SessionState';

describe('SessionStateStore', () => {
  it('persists and reloads states; missing file is empty', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    const s = new SessionStateStore(file);
    await s.load();
    expect(s.get('x')).toBeNull();
    await s.set({ sessionId: 'x', cwd: '/w', account: 'b', projectDir: '/p', lastTurnAtMs: 5, justCompacted: false, defaultModel: 'opus' });
    const s2 = new SessionStateStore(file);
    await s2.load();
    expect(s2.get('x')).toEqual({ sessionId: 'x', cwd: '/w', account: 'b', projectDir: '/p', lastTurnAtMs: 5, justCompacted: false, defaultModel: 'opus' });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('keeps entries whose account or pin is not a configured account (the file is not checked against the registry)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    const gone = { sessionId: 'x', cwd: '/w', account: 'zz', projectDir: '/p', lastTurnAtMs: 5, justCompacted: false, defaultModel: 'opus' as const, accountPin: 'old' };
    const kept = { sessionId: 'y', cwd: '/w', account: 'b', projectDir: '/q', lastTurnAtMs: 6, justCompacted: false, defaultModel: 'opus' as const };
    const s = new SessionStateStore(file);
    await s.load();
    await s.set(gone);
    await s.set(kept);
    const s2 = new SessionStateStore(file);
    await s2.load();
    expect(s2.get('x')).toEqual(gone);
    expect(s2.get('y')).toEqual(kept);
  });

  it('account pin: persisted across reload, kept by later set() calls, cleared with null', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    const s = new SessionStateStore(file);
    await s.load();
    const base = { sessionId: 'x', cwd: '/w', account: 'b' as const, projectDir: '/p', lastTurnAtMs: 5, justCompacted: false, defaultModel: 'opus' as const };
    expect(await s.setAccountPin('x', 'c')).toBe(false);
    await s.set({ ...base, accountPin: 'a' });
    expect(s.get('x')).toMatchObject({ accountPin: 'a' });
    expect(await s.setAccountPin('x', 'c')).toBe(true);
    // A turn writing a state it read before the change (stale pin, or none) does not undo it.
    await s.set({ ...base, lastTurnAtMs: 9, accountPin: 'a' });
    await s.set({ ...base, lastTurnAtMs: 10 });
    const s2 = new SessionStateStore(file);
    await s2.load();
    expect(s2.get('x')).toMatchObject({ lastTurnAtMs: 10, accountPin: 'c' });
    expect(await s2.setAccountPin('x', null)).toBe(true);
    expect(s2.get('x')).not.toHaveProperty('accountPin');
  });

  it('concurrent set() calls on different sessions all persist', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    const s = new SessionStateStore(file);
    await s.load();
    const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
    await Promise.all(ids.map((id) => s.set({ sessionId: id, cwd: '/w', account: 'b', projectDir: '/p', lastTurnAtMs: 1, justCompacted: false, defaultModel: 'opus' })));
    const s2 = new SessionStateStore(file);
    await s2.load();
    for (const id of ids) expect(s2.get(id)?.sessionId).toBe(id);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a corrupt file is preserved as .bad-<ts> and the store starts empty', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    await fs.writeFile(file, '{"x": {"sessionId": "x", tru');
    const s = new SessionStateStore(file);
    await s.load();
    expect(s.get('x')).toBeNull();
    const bad = (await fs.readdir(dir)).filter((f) => f.startsWith('session-state.json.bad-'));
    expect(bad).toHaveLength(1);
    expect(await fs.readFile(path.join(dir, bad[0]!), 'utf8')).toBe('{"x": {"sessionId": "x", tru');
  });
});

describe('Codex session state (D4)', () => {
  it('round-trips a codex state, lists it for the sidebar as account gpt, and Plan 1 states stay claude', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-state-codex-'));
    const file = path.join(base, 'state.json');
    await fs.writeFile(file, JSON.stringify({ old: { sessionId: 'old', cwd: '/w', account: 'b', projectDir: '/p', lastTurnAtMs: 5, justCompacted: false, defaultModel: 'opus' } }));
    const store = new SessionStateStore(file);
    await store.load();
    const old = store.get('old');
    expect(old && isCodexState(old)).toBe(false);
    await store.set({ engine: 'codex', sessionId: 'tid', cwd: '/w/gpt', lastTurnAtMs: null, justCompacted: false, defaultModel: 'gpt-6-astra', sandbox: 'workspace-write', rolloutFile: '/r/2026/09/30/rollout-x-tid.jsonl', createdAtMs: 1000, title: '첫 질문' });
    const again = new SessionStateStore(file);
    await again.load();
    const s = again.get('tid');
    expect(s && isCodexState(s) ? s.sandbox : null).toBe('workspace-write');
    expect(again.list()).toHaveLength(2);
    expect(again.codexEntries()).toEqual([{ sessionId: 'tid', account: 'gpt', engine: 'codex', sandbox: 'workspace-write', cwd: '/w/gpt', projectDir: '/r/2026/09/30', file: '/r/2026/09/30/rollout-x-tid.jsonl', title: '첫 질문', lastModified: 1000, sizeBytes: 0 }]);
    await fs.rm(base, { recursive: true, force: true });
  });
});
