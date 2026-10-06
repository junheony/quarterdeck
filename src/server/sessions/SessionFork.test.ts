import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FORK_SUFFIX, backupDivergedAndMove, forkDivergedAndMove } from './SessionFork';
import { KEEP_MARKER } from './backupPrune';
import { scanProfile } from './SessionIndex';
import { moveSession, sha256File } from './SessionMover';
import { readHead } from './transcript';

const ID = '66666666-6666-4666-8666-666666666666';
const NEW = '77777777-7777-4777-8777-777777777777';
const line = (o: object) => `${JSON.stringify(o)}\n`;
const user = (text: string) => line({ type: 'user', uuid: `u-${text}`, cwd: '/w/one', sessionId: ID, message: { role: 'user', content: text } });

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-fork-'));
  const srcRoot = path.join(base, 'c', 'projects');
  const dstRoot = path.join(base, 'b', 'projects');
  const srcDir = path.join(srcRoot, '-w-one');
  const dstDir = path.join(dstRoot, '-w-one');
  await fs.mkdir(path.join(srcDir, ID), { recursive: true });
  await fs.mkdir(path.join(dstDir, ID, 'subagents'), { recursive: true });
  const shared = user('first question') + line({ type: 'assistant', sessionId: ID, message: { role: 'assistant', content: 'answer' } });
  // The same id continued in two places: C (the source) and B (the target) share a prefix, then differ.
  await fs.writeFile(path.join(srcDir, `${ID}.jsonl`), shared + user('continued on C'));
  await fs.writeFile(path.join(srcDir, ID, 'custom-title.json'), '{"customTitle":"Src"}');
  await fs.writeFile(path.join(dstDir, `${ID}.jsonl`), shared + user('continued on B') + line({ type: 'summary', summary: 'no id here' }));
  await fs.writeFile(path.join(dstDir, ID, 'subagents', 'agent-1.jsonl'), line({ sessionId: ID, a: 1 }));
  await fs.writeFile(path.join(dstDir, ID, 'tool-result.txt'), 'big output');
  const old = new Date(Date.now() - 10 * 60_000);
  await fs.utimes(path.join(dstDir, `${ID}.jsonl`), old, old);
  return { base, homeRoot: path.join(base, 'a', 'projects'), srcRoot, dstRoot, srcDir, dstDir, srcFile: path.join(srcDir, `${ID}.jsonl`), dstFile: path.join(dstDir, `${ID}.jsonl`) };
}

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out[path.relative(dir, path.join(e.parentPath, e.name))] = await sha256File(path.join(e.parentPath, e.name));
  }
  return out;
}

describe('forkDivergedAndMove', () => {
  it('backs up the diverged target, forks it under a new id, then moves the source in', async () => {
    const f = await fixture();
    expect((await moveSession({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot })).ok).toBe(false);
    const srcBefore = await tree(f.srcDir);
    const srcMtime = (await fs.stat(f.srcFile)).mtimeMs;
    const dstText = await fs.readFile(f.dstFile, 'utf8');
    const dstComp = await tree(path.join(f.dstDir, ID));

    const r = await forkDivergedAndMove({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot, refuseProjectsRoots: [f.homeRoot], newId: NEW });
    expect(r).toMatchObject({ ok: true, fork: { sessionId: NEW, title: `first question ${FORK_SUFFIX}` }, keptAside: [] });
    if (!r.ok) return;

    // Backup: the old target copy, byte for byte, under <configDir>/session-backups/<stamp>-<id>/.
    expect(path.dirname(r.backupDir)).toBe(path.join(f.base, 'b', 'session-backups'));
    expect(path.basename(r.backupDir)).toMatch(new RegExp(`^\\d{8}-\\d{6}-${ID}$`));
    expect(await fs.readFile(path.join(r.backupDir, `${ID}.jsonl`), 'utf8')).toBe(dstText);
    expect(await tree(path.join(r.backupDir, ID))).toEqual(dstComp);

    // Fork: every line's sessionId rewritten, nothing else changed, title record appended; companions copied.
    const forkLines = (await fs.readFile(path.join(f.dstDir, `${NEW}.jsonl`), 'utf8')).trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const origLines = dstText.trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(forkLines).toHaveLength(origLines.length + 1);
    origLines.forEach((o, i) => expect(forkLines[i]).toEqual('sessionId' in o ? { ...o, sessionId: NEW } : o));
    expect(forkLines.at(-1)).toEqual({ type: 'custom-title', customTitle: `first question ${FORK_SUFFIX}`, sessionId: NEW });
    expect(dstText.includes(NEW)).toBe(false);
    const forkComp = await tree(path.join(f.dstDir, NEW));
    expect(forkComp['subagents/agent-1.jsonl']).toBe(dstComp['subagents/agent-1.jsonl']);
    expect(forkComp['tool-result.txt']).toBe(dstComp['tool-result.txt']);
    expect(JSON.parse(await fs.readFile(path.join(f.dstDir, NEW, 'custom-title.json'), 'utf8'))).toEqual({ customTitle: `first question ${FORK_SUFFIX}` });
    expect((await readHead(path.join(f.dstDir, `${NEW}.jsonl`))).title).toBe(`first question ${FORK_SUFFIX}`);

    // Move: the target now holds the source; no staging left; the source untouched.
    expect(await fs.readFile(f.dstFile, 'utf8')).toBe(await fs.readFile(f.srcFile, 'utf8'));
    expect((await fs.readdir(f.dstDir)).filter((n) => n.includes('deck-'))).toEqual([]);
    expect(await tree(f.srcDir)).toEqual(srcBefore);
    expect((await fs.stat(f.srcFile)).mtimeMs).toBe(srcMtime);

    // Both sessions are listed for B.
    const listed = await scanProfile('b', f.dstRoot);
    expect(listed.map((s) => s.sessionId).sort()).toEqual([ID, NEW]);
    expect(listed.find((s) => s.sessionId === NEW)?.title).toBe(`first question ${FORK_SUFFIX}`);
  });

  it('a failed retry restores the target from the set-aside copy, removes the fork and leaves the source alone', async () => {
    const f = await fixture();
    const srcBefore = await tree(f.srcDir);
    const dstBefore = await tree(f.dstDir);
    let calls = 0;
    const r = await forkDivergedAndMove({
      sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot, refuseProjectsRoots: [f.homeRoot], newId: NEW,
      move: async (o) => { calls++; expect(await fs.stat(f.dstFile).catch(() => null)).toBeNull(); return { ok: false, error: `disk full (${o.sessionId})` }; },
    });
    expect(calls).toBe(1);
    expect(r).toMatchObject({ ok: false, restored: true, error: expect.stringContaining('disk full') });
    expect(await tree(f.dstDir)).toEqual(dstBefore);
    expect(await tree(f.srcDir)).toEqual(srcBefore);
    if (r.ok) return;
    expect(await fs.readFile(path.join(r.backupDir!, `${ID}.jsonl`), 'utf8')).toBe(await fs.readFile(f.dstFile, 'utf8'));
  });

  it('a move that throws after deleting the set-aside copy is restored from the backup', async () => {
    const f = await fixture();
    const dstBefore = await tree(f.dstDir);
    const r = await forkDivergedAndMove({
      sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot, refuseProjectsRoots: [f.homeRoot], newId: NEW,
      move: async () => {
        await fs.rm(`${f.dstFile}.deck-forking`);
        await fs.rm(path.join(f.dstDir, `${ID}.deck-forking`), { recursive: true });
        throw new Error('boom');
      },
    });
    expect(r).toMatchObject({ ok: false, restored: true, error: 'boom' });
    expect(await tree(f.dstDir)).toEqual(dstBefore);
  });

  it('refuses before touching anything when the fork id is taken or the target was just written', async () => {
    const f = await fixture();
    const dstBefore = await tree(f.dstDir);
    await fs.writeFile(path.join(f.dstDir, `${NEW}.jsonl`), 'x\n');
    const taken = await forkDivergedAndMove({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot, refuseProjectsRoots: [f.homeRoot], newId: NEW });
    expect(taken).toMatchObject({ ok: false, restored: true, backupDir: null });
    await fs.rm(path.join(f.dstDir, `${NEW}.jsonl`));
    expect(await tree(f.dstDir)).toEqual(dstBefore);

    const now = new Date();
    await fs.utimes(f.dstFile, now, now);
    const busy = await forkDivergedAndMove({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot, refuseProjectsRoots: [f.homeRoot], newId: NEW });
    expect(busy).toMatchObject({ ok: false, restored: true, backupDir: null, error: expect.stringContaining('열려 있는 것 같음') });
    expect(await tree(f.dstDir)).toEqual(dstBefore);
    expect(await fs.stat(path.join(f.base, 'b', 'session-backups')).catch(() => null)).toBeNull();
  });

  it('does nothing when the target copy is just an older prefix (not diverged)', async () => {
    const f = await fixture();
    await fs.writeFile(f.dstFile, user('first question'));
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(f.dstFile, old, old);
    const r = await forkDivergedAndMove({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot, refuseProjectsRoots: [f.homeRoot], newId: NEW });
    expect(r).toMatchObject({ ok: false, error: '대상 사본이 갈라지지 않음' });
  });

  it('refuses the home/protected profile itself before reading anything (also through another spelling)', async () => {
    const f = await fixture();
    const dstBefore = await tree(f.dstDir);
    const r = await forkDivergedAndMove({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot, refuseProjectsRoots: [path.join(f.dstRoot, '..', 'projects')], newId: NEW });
    expect(r).toMatchObject({ ok: false, restored: true, backupDir: null, error: expect.stringContaining('보호 계정') });
    expect(await tree(f.dstDir)).toEqual(dstBefore);
    expect(await fs.stat(path.join(f.base, 'b', 'session-backups')).catch(() => null)).toBeNull();
  });

  it('does not fork when the target is simply ahead (the source is its byte-prefix)', async () => {
    const f = await fixture();
    await fs.writeFile(f.dstFile, (await fs.readFile(f.srcFile, 'utf8')) + user('later on B'));
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(f.dstFile, old, old);
    const dstBefore = await tree(f.dstDir);
    const r = await forkDivergedAndMove({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot, refuseProjectsRoots: [f.homeRoot], newId: NEW });
    expect(r).toMatchObject({ ok: false, restored: true, backupDir: null, error: expect.stringContaining('더 최신') });
    expect(await tree(f.dstDir)).toEqual(dstBefore);
  });

  it('keeps the set-aside copy (reported) when something appended to it after the backup', async () => {
    const f = await fixture();
    const staged = `${f.dstFile}.deck-forking`;
    const r = await forkDivergedAndMove({
      sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot, refuseProjectsRoots: [f.homeRoot], newId: NEW,
      move: async (o) => { await fs.appendFile(staged, user('a writer still holding it')); return moveSession(o); },
    });
    expect(r).toMatchObject({ ok: true, keptAside: [staged] });
    expect(await fs.readFile(staged, 'utf8')).toContain('a writer still holding it');
    // The companion dir did not change: it is dropped as before.
    expect(await fs.stat(path.join(f.dstDir, `${ID}.deck-forking`)).catch(() => null)).toBeNull();
  });

  it('a restored original that grew meanwhile counts as restored, and the fork is cleaned up', async () => {
    const f = await fixture();
    const staged = `${f.dstFile}.deck-forking`;
    const r = await forkDivergedAndMove({
      sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot, refuseProjectsRoots: [f.homeRoot], newId: NEW,
      move: async () => {
        await fs.appendFile(staged, user('appended while set aside'));
        await fs.appendFile(path.join(f.dstDir, `${ID}.deck-forking`, 'subagents', 'agent-1.jsonl'), line({ sessionId: ID, a: 2 }));
        await fs.writeFile(path.join(f.dstDir, `${ID}.deck-forking`, 'new-file.txt'), 'x');
        return { ok: false, error: 'disk full' };
      },
    });
    expect(r).toMatchObject({ ok: false, restored: true, error: 'disk full' });
    expect(await fs.readFile(f.dstFile, 'utf8')).toContain('appended while set aside');
    expect((await fs.readdir(f.dstDir)).sort()).toEqual([ID, `${ID}.jsonl`]);
  });
});

describe('backupDivergedAndMove', () => {
  it('backs the diverged target up to session-backups, then overwrites it with the source — no forked session', async () => {
    const f = await fixture();
    const dstText = await fs.readFile(f.dstFile, 'utf8');
    const dstComp = await tree(path.join(f.dstDir, ID));
    const srcBefore = await tree(f.srcDir);
    const r = await backupDivergedAndMove({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot, refuseProjectsRoots: [f.homeRoot] });
    expect(r).toMatchObject({ ok: true, keptAside: [] });
    if (!r.ok) return;
    expect('fork' in r).toBe(false);
    expect(path.dirname(r.backupDir)).toBe(path.join(f.base, 'b', 'session-backups'));
    expect(await fs.readFile(path.join(r.backupDir, `${ID}.jsonl`), 'utf8')).toBe(dstText);
    expect(await tree(path.join(r.backupDir, ID))).toEqual(dstComp);
    // It holds the only copy of the overwritten turns: marked so backup pruning never removes it.
    expect(await fs.stat(path.join(r.backupDir, KEEP_MARKER)).then(() => true)).toBe(true);
    // The target now is the source; only this session's files are in the dir (nothing staged left behind).
    expect(await fs.readFile(f.dstFile, 'utf8')).toBe(await fs.readFile(f.srcFile, 'utf8'));
    expect((await fs.readdir(f.dstDir)).sort()).toEqual([ID, `${ID}.jsonl`]);
    expect(await tree(f.srcDir)).toEqual(srcBefore);
  });

  it('refuses the home/protected profile and a target that is not diverged', async () => {
    const f = await fixture();
    expect(await backupDivergedAndMove({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot, refuseProjectsRoots: [f.dstRoot] })).toMatchObject({ ok: false, error: expect.stringContaining('보호 계정') });
    await fs.writeFile(f.dstFile, user('first question'));
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(f.dstFile, old, old);
    expect(await backupDivergedAndMove({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot, refuseProjectsRoots: [f.homeRoot] })).toMatchObject({ ok: false, error: '대상 사본이 갈라지지 않음' });
  });
});

describe('forkDivergedAndMove backups', () => {
  it('stay prunable (the fork keeps the turns)', async () => {
    const f = await fixture();
    const r = await forkDivergedAndMove({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot, refuseProjectsRoots: [f.homeRoot], newId: NEW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(await fs.stat(path.join(r.backupDir, KEEP_MARKER)).catch(() => null)).toBeNull();
  });
});

