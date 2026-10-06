import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_RECENT_FOLDERS, SessionIndex, groupProjects, readPinned, readRecent, scanProfile } from './SessionIndex';
import type { SessionEntry } from '../../shared/session-types';
import { rootsOf } from '../../shared/accounts.testkit';

const L = (o: unknown) => JSON.stringify(o) + '\n';
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';

async function mkRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'deck-idx-'));
}

async function writeSession(root: string, dir: string, id: string, cwd: string, title: string, mtimeMs: number) {
  const d = path.join(root, dir);
  await fs.mkdir(d, { recursive: true });
  const f = path.join(d, `${id}.jsonl`);
  await fs.writeFile(f, L({ type: 'user', cwd, sessionId: id, message: { role: 'user', content: title } }));
  await fs.utimes(f, mtimeMs / 1000, mtimeMs / 1000);
  return f;
}

describe('scanProfile', () => {
  it('lists uuid.jsonl files with cwd/title and skips other files', async () => {
    const root = await mkRoot();
    await writeSession(root, '-Users-x-proj', ID1, '/Users/x/proj', 'hello', 1_000_000);
    await fs.writeFile(path.join(root, '-Users-x-proj', 'notes.txt'), 'x');
    await fs.mkdir(path.join(root, '-Users-x-proj', ID1, 'subagents'), { recursive: true });
    await fs.writeFile(path.join(root, '-Users-x-proj', ID1, 'subagents', 'agent-1.jsonl'), L({ type: 'user', cwd: '/Users/x/proj', message: { role: 'user', content: 'sub' } }));
    await fs.mkdir(path.join(root, '-Users-x-other'));
    await fs.writeFile(path.join(root, '-Users-x-other', `${ID2}.jsonl`), L({ type: 'queue-operation' }));
    const entries = await scanProfile('b', root);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sessionId: ID1, account: 'b', cwd: '/Users/x/proj', title: 'hello', lastModified: 1_000_000, projectDir: path.join(root, '-Users-x-proj') });
    expect(entries[0]?.file).toBe(path.join(root, '-Users-x-proj', `${ID1}.jsonl`));
  });

  it('returns [] for a missing root', async () => {
    expect(await scanProfile('a', '/nonexistent/deck-root')).toEqual([]);
  });
});

describe('groupProjects', () => {
  const e = (sessionId: string, account: 'a' | 'b' | 'c', cwd: string, lastModified: number): SessionEntry => ({
    sessionId, account, cwd, projectDir: '/p', file: '/p/' + sessionId + '.jsonl', title: 't', lastModified, sizeBytes: 1,
  });

  it('groups by cwd, pinned first in pinned order, sessions newest first, duplicates keep the newest', () => {
    const projects = groupProjects(
      [e(ID1, 'a', '/w/one', 10), e(ID2, 'b', '/w/two', 50), e(ID3, 'c', '/w/one', 30), e(ID1, 'c', '/w/one', 40)],
      [{ cwd: '/w/two', name: 'Two' }, { cwd: '/w/empty' }],
    );
    expect(projects.map((p) => [p.cwd, p.name, p.pinned])).toEqual([
      ['/w/two', 'Two', true],
      ['/w/empty', 'empty', true],
      ['/w/one', 'one', false],
    ]);
    const one = projects[2]!;
    expect(one.sessions.map((s) => [s.sessionId, s.account])).toEqual([[ID1, 'c'], [ID3, 'c']]);
  });

  it('projects(extra) groups extra (Codex) entries under their cwd without touching the cached grouping', async () => {
    const idx = new SessionIndex({ roots: rootsOf({ a: '/nonexistent/a', b: '/nonexistent/b', c: '/nonexistent/c' }), pinnedFile: '/nonexistent/p.json' });
    await idx.refresh();
    expect(idx.projects()).toEqual([]);
    const gpt: SessionEntry = { ...e(ID1, 'a', '/w/gpt', 5), account: 'gpt', engine: 'codex', sandbox: 'read-only' };
    const p = idx.projects([gpt]);
    expect(p).toHaveLength(1);
    expect(p[0]?.sessions[0]).toMatchObject({ sessionId: ID1, account: 'gpt', engine: 'codex' });
    expect(idx.projects()).toEqual([]);
  });
});

describe('readPinned + SessionIndex', () => {
  it('reads projects.json ([] when missing) and lookup prefers the newest copy across profiles', async () => {
    const ra = await mkRoot();
    const rb = await mkRoot();
    const rc = await mkRoot();
    await writeSession(ra, '-w-one', ID1, '/w/one', 'a copy', 1_000);
    await writeSession(rb, '-w-one', ID1, '/w/one', 'b copy', 2_000);
    const pinnedFile = path.join(ra, 'projects.json');
    expect(await readPinned(pinnedFile)).toEqual([]);
    await fs.writeFile(pinnedFile, JSON.stringify([{ cwd: '/w/one', name: 'One' }]));
    const idx = new SessionIndex({ roots: rootsOf({ a: ra, b: rb, c: rc }), pinnedFile });
    await idx.refresh();
    expect(idx.lookup(ID1)?.account).toBe('b');
    expect(idx.lookup('nope')).toBeNull();
    expect(idx.projects()[0]).toMatchObject({ cwd: '/w/one', name: 'One', pinned: true });
    expect(idx.projects()[0]?.sessions).toHaveLength(1);
  });
});

describe('recent folders (F1)', () => {
  it('groupProjects lists recent folders without sessions right after pinned ones, in recent order', () => {
    const s1: SessionEntry = { sessionId: ID1, account: 'a', cwd: '/w/old', projectDir: '/p', file: '/p/1.jsonl', title: 't', lastModified: 10, sizeBytes: 1 };
    const p = groupProjects([s1], [{ cwd: '/w/pin' }], ['/w/new2', '/w/old', '/w/pin', '/w/new1']);
    expect(p.map((x) => [x.cwd, x.pinned, x.sessions.length])).toEqual([
      ['/w/pin', true, 0],
      ['/w/new2', false, 0],
      ['/w/new1', false, 0],
      ['/w/old', false, 1],
    ]);
    expect(p[1]?.name).toBe('new2');
  });

  it('addRecent persists newest first, dedupes, caps, and survives a new index', async () => {
    const dir = await mkRoot();
    const recentFile = path.join(dir, 'cfg', 'recent-folders.json');
    expect(await readRecent(recentFile)).toEqual([]);
    const roots = { a: '/nonexistent/a', b: '/nonexistent/b', c: '/nonexistent/c' };
    const idx = new SessionIndex({ roots: rootsOf(roots), pinnedFile: '/nonexistent/p.json', recentFile });
    await idx.refresh();
    await idx.addRecent('/w/one');
    await idx.addRecent('/w/two');
    expect(await idx.addRecent('/w/one')).toEqual(['/w/one', '/w/two']);
    expect(idx.projects().map((p) => p.cwd)).toEqual(['/w/one', '/w/two']);
    for (let i = 0; i < MAX_RECENT_FOLDERS + 5; i++) await idx.addRecent(`/w/n${i}`);
    expect(idx.recent()).toHaveLength(MAX_RECENT_FOLDERS);
    expect(idx.recent()[0]).toBe(`/w/n${MAX_RECENT_FOLDERS + 4}`);
    const again = new SessionIndex({ roots: rootsOf(roots), pinnedFile: '/nonexistent/p.json', recentFile });
    await again.refresh();
    expect(again.recent()).toEqual(idx.recent());
    expect((await fs.stat(recentFile)).mode & 0o777).toBe(0o600);
  });

  it('readRecent ignores junk', async () => {
    const dir = await mkRoot();
    const f = path.join(dir, 'r.json');
    await fs.writeFile(f, JSON.stringify(['/ok', 3, 'relative', null, '/ok2']));
    expect(await readRecent(f)).toEqual(['/ok', '/ok2']);
    await fs.writeFile(f, '{bad');
    expect(await readRecent(f)).toEqual([]);
  });
});

describe('NFC/NFD paths (작업)', () => {
  const NFC = '/Users/alice/Documents/작업/deck'.normalize('NFC');
  const NFD = NFC.normalize('NFD');
  const s = (sessionId: string, cwd: string, lastModified: number): SessionEntry => ({
    sessionId, account: 'a', cwd, projectDir: '/p', file: '/p/' + sessionId + '.jsonl', title: 't', lastModified, sizeBytes: 1,
  });

  it('the two spellings really differ', () => {
    expect(NFC).not.toBe(NFD);
  });

  it('groupProjects puts NFC and NFD transcripts of one folder in a single project, keeping each session cwd', () => {
    const p = groupProjects([s(ID1, NFC, 10), s(ID2, NFD, 20)], []);
    expect(p).toHaveLength(1);
    expect(p[0]?.cwd).toBe(NFC);
    expect(p[0]?.name).toBe('deck');
    expect(p[0]?.sessions.map((x) => x.cwd)).toEqual([NFD, NFC]);
  });

  it('a recent (폴더 열기) or pinned folder in the other spelling does not create a duplicate project', () => {
    const p = groupProjects([s(ID1, NFD, 10)], [], [NFC]);
    expect(p.map((x) => [x.cwd, x.sessions.length])).toEqual([[NFC, 1]]);
    const q = groupProjects([s(ID1, NFC, 10)], [{ cwd: NFD }], [NFC, NFD]);
    expect(q.map((x) => [x.cwd, x.pinned, x.sessions.length])).toEqual([[NFC, true, 1]]);
  });

  it('addRecent and readRecent dedupe across spellings', async () => {
    const dir = await mkRoot();
    const recentFile = path.join(dir, 'r.json');
    const idx = new SessionIndex({ roots: rootsOf({ a: '/nonexistent/a', b: '/nonexistent/b', c: '/nonexistent/c' }), pinnedFile: '/nonexistent/p.json', recentFile });
    await idx.refresh();
    await idx.addRecent(NFD);
    expect(await idx.addRecent(NFC)).toEqual([NFC]);
    await fs.writeFile(recentFile, JSON.stringify([NFD, NFC, '/w/x']));
    expect(await readRecent(recentFile)).toEqual([NFD, '/w/x']);
  });
});

describe('SessionIndex heldBy (process holders)', () => {
  it('a Claude session another process holds carries heldBy; it follows the holders on regroup, without a rescan', async () => {
    const root = await mkRoot();
    const roots = { a: path.join(root, 'a'), b: path.join(root, 'b'), c: path.join(root, 'c') };
    await writeSession(roots.a, '-Users-x-proj', ID1, '/Users/x/proj', 'held', 2_000_000);
    await writeSession(roots.a, '-Users-x-proj', ID2, '/Users/x/proj', 'free', 1_000_000);
    const held = new Map<string, 'desktop' | 'other'>([[ID1, 'desktop']]);
    const idx = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(root, 'pinned.json'), holders: { heldBy: (id) => held.get(id) ?? null } });
    await idx.refresh();
    const byId = () => Object.fromEntries(idx.projects().flatMap((p) => p.sessions).map((s) => [s.sessionId, s]));
    expect(byId()[ID1]?.heldBy).toBe('desktop');
    expect(byId()[ID2]).not.toHaveProperty('heldBy');
    // A Codex session with the same id shape is not a Claude process's to hold.
    const codex: SessionEntry = { sessionId: ID3, account: 'gpt', engine: 'codex', cwd: '/Users/x/proj', projectDir: '', file: '', title: 'gpt', lastModified: 1, sizeBytes: 0 };
    held.set(ID3, 'other');
    expect(idx.projects([codex]).flatMap((p) => p.sessions).find((s) => s.sessionId === ID3)).not.toHaveProperty('heldBy');

    held.set(ID1, 'other');
    held.set(ID2, 'desktop');
    expect(byId()[ID1]?.heldBy).toBe('desktop');
    idx.regroup();
    expect(byId()[ID1]?.heldBy).toBe('other');
    expect(byId()[ID2]?.heldBy).toBe('desktop');
    held.clear();
    idx.regroup();
    expect(byId()[ID1]).not.toHaveProperty('heldBy');
    expect(byId()[ID2]).not.toHaveProperty('heldBy');
  });
});

describe('SessionIndex.touch', () => {
  it('re-stats known files only: a newer mtime updates lastModified (same object lookup sees it) and re-sorts the project', async () => {
    const a = await mkRoot();
    const b = await mkRoot();
    const c = await mkRoot();
    const f1 = await writeSession(b, '-w-p', ID1, '/w/p', 'one', 1_000_000);
    await writeSession(b, '-w-p', ID2, '/w/p', 'two', 2_000_000);
    const idx = new SessionIndex({ roots: rootsOf({ a, b, c }), pinnedFile: '/nonexistent/p.json' });
    await idx.refresh();
    expect(idx.projects()[0]?.sessions.map((s) => s.sessionId)).toEqual([ID2, ID1]);
    expect(await idx.touch()).toBe(false);
    await fs.appendFile(f1, L({ type: 'assistant', message: { role: 'assistant', content: 'x' } }));
    await fs.utimes(f1, 3_000, 3_000);
    expect(await idx.touch([ID2])).toBe(false); // only the named sessions are looked at
    expect(await idx.touch(undefined, new Set([ID1]))).toBe(false); // skipped (a running turn's session)
    expect(await idx.touch([ID1])).toBe(true);
    expect(idx.lookup(ID1)?.lastModified).toBe(3_000_000);
    expect(idx.projects()[0]?.sessions.map((s) => s.sessionId)).toEqual([ID1, ID2]);
    // A file that vanished is left alone (the next full refresh drops it).
    await fs.rm(f1);
    expect(await idx.touch()).toBe(false);
  });
});
