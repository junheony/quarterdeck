import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CODEX_ARCHIVED_NOTICE, CWD_MISSING_NOTICE, CodexRolloutIndex, importBlockReason, isDeckTestCwd, readRolloutHead, readThreadNames, rolloutRecentlyActive } from './CodexImports';
import { SessionIndex } from './SessionIndex';
import { CLI_ID, DESKTOP_ID, GONE_ID, SUB_ID, assistant, jsonl, meta, user, writeFixtures } from './codexFixtures';
import { rootsOf } from '../../shared/accounts.testkit';

let base: string;
let root: string;
let work: string;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-codex-import-'));
  root = path.join(base, 'sessions');
  work = path.join(base, 'work');
  await fs.mkdir(work);
});
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

describe('readRolloutHead', () => {
  it('reads thread id, cwd and the first real prompt (Desktop request section, first line, trimmed)', async () => {
    const { desktop, cli } = await writeFixtures(root, work);
    expect(await readRolloutHead(desktop)).toEqual({ threadId: DESKTOP_ID, cwd: work, title: '스크린샷의 버그 고쳐줘' });
    expect(await readRolloutHead(cli)).toEqual({ threadId: CLI_ID, cwd: work, title: 'List the files' });
  });

  it('marks `codex exec` automation rollouts with exec: true', async () => {
    const f = path.join(base, 'exec.jsonl');
    await fs.writeFile(f, jsonl([meta(CLI_ID, work, { originator: 'codex_exec', source: 'exec' }), user('<environment_context>…'), user('You are the docs lane\nmore')]));
    expect(await readRolloutHead(f)).toEqual({ threadId: CLI_ID, cwd: work, title: 'You are the docs lane', exec: true });
    const g = path.join(base, 'exec2.jsonl');
    await fs.writeFile(g, jsonl([meta(CLI_ID, work, { originator: 'codex_exec' }), user('x')]));
    expect((await readRolloutHead(g))?.exec).toBe(true);
  });

  it('takes the prompt after either Desktop request heading', async () => {
    const f = path.join(base, 'r.jsonl');
    await fs.writeFile(f, jsonl([meta(CLI_ID, work), user('\n# Files mentioned by the user:\n\n## x.png: /tmp/x.png\n## My request:\n이거 파악해봐 \n')]));
    expect((await readRolloutHead(f))?.title).toBe('이거 파악해봐');
  });

  it('null for sub-agent threads and files that do not start with session_meta', async () => {
    await writeFixtures(root, work);
    const dir = path.join(root, '2026', '10', '01');
    expect(await readRolloutHead(path.join(dir, `rollout-2026-10-01T12-00-00-${SUB_ID}.jsonl`))).toBeNull();
    expect(await readRolloutHead(path.join(dir, 'rollout-junk.jsonl'))).toBeNull();
  });

  it('stops at the byte cap: a prompt beyond it leaves the title null', async () => {
    const f = path.join(base, 'big.jsonl');
    await fs.writeFile(f, jsonl([meta(CLI_ID, work), user(`<huge>${'y'.repeat(200_000)}</huge>`), user('late prompt')]));
    expect(await readRolloutHead(f, 64 * 1024)).toEqual({ threadId: CLI_ID, cwd: work, title: null });
    expect((await readRolloutHead(f))?.title).toBe('late prompt');
  });
});

describe('CodexRolloutIndex', () => {
  it('lists user threads as gpt/codex entries (a gone folder flagged cwdMissing, sub-agents left out); heads are read once per file', async () => {
    const { desktop } = await writeFixtures(root, work);
    let reads = 0;
    const idx = new CodexRolloutIndex(root, async (f) => { reads++; return readRolloutHead(f); });
    await idx.refresh();
    const list = idx.list().sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    expect(list.map((e) => e.sessionId)).toEqual([DESKTOP_ID, CLI_ID, GONE_ID]);
    expect(list[0]).toMatchObject({ account: 'gpt', engine: 'codex', cwd: work, file: desktop, projectDir: path.dirname(desktop), title: '스크린샷의 버그 고쳐줘', imported: true });
    expect(list[0]).not.toHaveProperty('cwdMissing');
    expect(idx.lookup(CLI_ID)?.title).toBe('List the files');
    expect(idx.lookup(SUB_ID)).toBeNull();
    expect(idx.lookup(GONE_ID)).toMatchObject({ cwd: path.join(work, 'deleted-temp-dir'), title: 'hi', cwdMissing: true });
    const first = reads;
    expect(first).toBe(5);

    // Appending (the thread goes on) only bumps activity; the head is not re-read.
    await fs.appendFile(desktop, jsonl([assistant('more')]));
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(desktop, later, later);
    await idx.refresh();
    expect(reads).toBe(first);
    expect(idx.lookup(DESKTOP_ID)?.lastModified).toBe(later.getTime());
  });

  it('lists `codex exec` threads of any age (codexExec), gone folders too, not sub-agents', async () => {
    const dir = path.join(root, '2026', '10', '03');
    await fs.mkdir(dir, { recursive: true });
    const id = (n: string) => `01a0f2d3-0000-7c92-aeea-0000000000${n}`;
    const DAY = 86_400_000;
    const write = async (n: string, cwd: string, extra: Record<string, unknown>, ageMs: number) => {
      const f = path.join(dir, `rollout-2026-10-03T10-00-${n}-${id(n)}.jsonl`);
      await fs.writeFile(f, jsonl([meta(id(n), cwd, { originator: 'codex_exec', source: 'exec', ...extra }), user('run lane')]));
      const t = new Date(Date.now() - ageMs);
      await fs.utimes(f, t, t);
      return f;
    };
    await write('e1', work, {}, DAY);
    await write('e2', work, {}, 90 * DAY);
    await write('e3', path.join(work, 'gone'), {}, DAY);
    await write('e4', work, { thread_source: 'subagent' }, DAY);
    const idx = new CodexRolloutIndex(root);
    await idx.refresh();
    expect(idx.list().map((e) => e.sessionId).sort()).toEqual([id('e1'), id('e2'), id('e3')]);
    expect(idx.lookup(id('e2'))).toMatchObject({ account: 'gpt', engine: 'codex', imported: true, codexExec: true, title: 'run lane' });
    expect(idx.lookup(id('e3'))).toMatchObject({ codexExec: true, cwdMissing: true });
  });

  it('lists archived_sessions (flat) as archived + codexArchived; the newest copy of a thread wins', async () => {
    const { cli } = await writeFixtures(root, work);
    const arch = path.join(base, 'archived_sessions');
    await fs.mkdir(arch);
    const AID = '01a0f2d3-0000-7c92-aeea-0000000000a1';
    const af = path.join(arch, `rollout-2026-09-01T10-00-00-${AID}.jsonl`);
    await fs.writeFile(af, jsonl([meta(AID, work), user('old idea')]));
    await fs.writeFile(path.join(arch, `rollout-2026-09-01T11-00-00-${SUB_ID}.jsonl`), jsonl([meta(SUB_ID, work, { thread_source: 'subagent' }), user('x')]));
    const idx = new CodexRolloutIndex(root, undefined, arch);
    await idx.refresh();
    expect(idx.lookup(AID)).toMatchObject({ title: 'old idea', file: af, imported: true, archived: true, codexArchived: true });
    expect(idx.lookup(CLI_ID)).not.toHaveProperty('codexArchived');
    expect(idx.lookup(SUB_ID)).toBeNull();
    // The same thread in both dirs (moved mid-scan): the more recently written copy is listed.
    const dup = path.join(arch, path.basename(cli));
    await fs.copyFile(cli, dup);
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(dup, later, later);
    await idx.refresh();
    expect(idx.lookup(CLI_ID)).toMatchObject({ file: dup, codexArchived: true });
  });

  it('overlapping refreshes share the scan: each head is read once', async () => {
    await writeFixtures(root, work);
    const reads = new Map<string, number>();
    const idx = new CodexRolloutIndex(root, async (f) => { reads.set(f, (reads.get(f) ?? 0) + 1); return readRolloutHead(f); });
    await Promise.all([idx.refresh(), idx.refresh(), idx.refresh()]);
    expect([...reads.values()].every((n) => n === 1)).toBe(true);
    expect(reads.size).toBe(5);
    expect(idx.list()).toHaveLength(3);
  });

  it('leaves out deck e2e threads (deck-e2e* under a temp root), not other temp-dir threads', async () => {
    const dir = path.join(root, '2026', '10', '04');
    await fs.mkdir(dir, { recursive: true });
    const E2E = '01a0f2d3-0000-7c92-aeea-0000000000e9';
    const TMP = '01a0f2d3-0000-7c92-aeea-0000000000e8';
    await fs.writeFile(path.join(dir, `rollout-a-${E2E}.jsonl`), jsonl([meta(E2E, path.join(os.tmpdir(), 'deck-e2e-work-AbC123')), user('e2e')]));
    await fs.writeFile(path.join(dir, `rollout-b-${TMP}.jsonl`), jsonl([meta(TMP, '/private/tmp'), user('scratch')]));
    const idx = new CodexRolloutIndex(root);
    await idx.refresh();
    expect(idx.lookup(E2E)).toBeNull();
    expect(idx.lookup(TMP)).toMatchObject({ title: 'scratch' });
  });

  it('isDeckTestCwd: deck-e2e top folder under /tmp, /private/tmp, os.tmpdir() or macOS /var/folders/*/*/T only', () => {
    expect(isDeckTestCwd('/private/var/folders/wd/x/T/deck-e2e-work-AbCdEf')).toBe(true);
    expect(isDeckTestCwd('/var/folders/wd/x/T/deck-e2e-perm-work-1/sub')).toBe(true);
    expect(isDeckTestCwd('/tmp/deck-e2e-work-1')).toBe(true);
    expect(isDeckTestCwd('/private/tmp/deck-e2e-cfg-1')).toBe(true);
    expect(isDeckTestCwd(path.join(os.tmpdir(), 'deck-e2e-work-z'))).toBe(true);
    expect(isDeckTestCwd('/private/tmp')).toBe(false);
    expect(isDeckTestCwd('/tmp/other/deck-e2e-work-1')).toBe(false);
    expect(isDeckTestCwd('/private/var/folders/wd/x/T/codex-scratch')).toBe(false);
    expect(isDeckTestCwd('/Users/alice/deck-e2e-work-1')).toBe(false);
  });

  it('a failed scan does not stick: the overlapping follow-up and later refreshes still scan', async () => {
    await writeFixtures(root, work);
    let fail = true;
    const idx = new CodexRolloutIndex(root, (f) => { if (fail) { fail = false; throw new Error('boom'); } return readRolloutHead(f); });
    const first = idx.refresh();
    const second = idx.refresh();
    await expect(first).rejects.toThrow('boom');
    await second;
    expect(idx.list()).toHaveLength(3);
    await idx.refresh();
    expect(idx.list()).toHaveLength(3);
  });

  it('a rollout whose first line was half-written at scan time is listed once it grows', async () => {
    const dir = path.join(root, '2026', '10', '04');
    await fs.mkdir(dir, { recursive: true });
    const f = path.join(dir, `rollout-x-${CLI_ID}.jsonl`);
    const full = jsonl([meta(CLI_ID, work), user('late meta')]);
    await fs.writeFile(f, full.slice(0, 200));
    const idx = new CodexRolloutIndex(root);
    await idx.refresh();
    expect(idx.lookup(CLI_ID)).toBeNull();
    await fs.writeFile(f, full);
    await idx.refresh();
    expect(idx.lookup(CLI_ID)).toMatchObject({ title: 'late meta' });
  });

  it('importBlockReason: archived in Codex or folder gone → the Korean reason; otherwise null', async () => {
    expect(await importBlockReason({ cwd: work })).toBeNull();
    expect(await importBlockReason({ cwd: path.join(work, 'gone') })).toBe(`${CWD_MISSING_NOTICE}: ${path.join(work, 'gone')}`);
    expect(CWD_MISSING_NOTICE).toBe('폴더가 없어 이어서 보낼 수 없음');
    expect(await importBlockReason({ cwd: work, codexArchived: true })).toBe(CODEX_ARCHIVED_NOTICE);
  });

  it('non-exec threads carry no codexExec flag', async () => {
    await writeFixtures(root, work);
    const idx = new CodexRolloutIndex(root);
    await idx.refresh();
    expect(idx.list().every((e) => !('codexExec' in e))).toBe(true);
  });

  it('missing root → empty', async () => {
    const idx = new CodexRolloutIndex(path.join(base, 'nope'));
    await idx.refresh();
    expect(idx.list()).toEqual([]);
  });
});

describe('SessionIndex with codexRoot', () => {
  it('lists imported threads under their project, and not again once deck runs the thread', async () => {
    await writeFixtures(root, work);
    const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
    const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json'), codexRoot: root });
    await index.refresh();
    const project = index.projects().find((p) => p.cwd === work);
    expect(project?.sessions.map((s) => s.sessionId).sort()).toEqual([DESKTOP_ID, CLI_ID]);
    expect(index.codexImport(DESKTOP_ID)?.imported).toBe(true);

    const own = { sessionId: CLI_ID, account: 'gpt' as const, engine: 'codex' as const, cwd: work, projectDir: '', file: '', title: 'deck title', lastModified: 1, sizeBytes: 0 };
    const sessions = index.projects([own]).find((p) => p.cwd === work)!.sessions;
    // Deck's entry, not the import — at least as recent as the thread's rollout file.
    expect(sessions.filter((s) => s.sessionId === CLI_ID)).toEqual([{ ...own, lastModified: index.codexImport(CLI_ID)!.lastModified }]);
  });
});

const nameLine = (id: string, thread_name: unknown) => JSON.stringify({ id, thread_name, updated_at: '2026-10-01T02:00:00.000Z' });

describe('Codex thread names (session_index.jsonl beside the rollout roots)', () => {
  const namesFile = () => path.join(base, 'session_index.jsonl');
  const titles = (idx: CodexRolloutIndex) => Object.fromEntries(idx.list().map((e) => [e.sessionId, e.title]));

  it('readThreadNames: the last line for an id wins; bad lines, other shapes and a half-written last line are skipped', async () => {
    await fs.writeFile(namesFile(), [
      nameLine(DESKTOP_ID, 'First Name'),
      'not json',
      '[1,2]',
      nameLine('not-a-thread-id', 'Stray'),
      nameLine(CLI_ID, 42),
      nameLine(CLI_ID, '  Paper   Kite\n'),
      nameLine(DESKTOP_ID, 'Tin Robot'),
      nameLine(GONE_ID, 'Was Named'),
      nameLine(GONE_ID, ' '),
      `{"id":"${SUB_ID}","thread_na`,
    ].join('\n'));
    expect(Object.fromEntries(await readThreadNames(namesFile()))).toEqual({ [DESKTOP_ID]: 'Tin Robot', [CLI_ID]: 'Paper Kite' });
  });

  it('readThreadNames: only the end of a large file is read, without the line the cut falls in', async () => {
    const last = nameLine(CLI_ID, 'Paper Kite') + '\n';
    await fs.writeFile(namesFile(), nameLine(DESKTOP_ID, 'Tin Robot') + '\n' + nameLine(GONE_ID, 'Cut In Half') + '\n' + last);
    expect(Object.fromEntries(await readThreadNames(namesFile(), Buffer.byteLength(last) + 10))).toEqual({ [CLI_ID]: 'Paper Kite' });
    await expect(readThreadNames(path.join(base, 'absent.jsonl'))).rejects.toThrow();
  });

  it('a named thread is titled with its Codex name, the others with their first prompt; a rename shows on the next refresh', async () => {
    await writeFixtures(root, work);
    await fs.writeFile(namesFile(), nameLine(DESKTOP_ID, 'Old Name') + '\n' + nameLine(DESKTOP_ID, 'Tin Robot') + '\n');
    const idx = new CodexRolloutIndex(root);
    await idx.refresh();
    expect(titles(idx)).toMatchObject({ [DESKTOP_ID]: 'Tin Robot', [CLI_ID]: 'List the files' });
    expect(idx.threadName(DESKTOP_ID)).toBe('Tin Robot');
    expect(idx.threadName(CLI_ID)).toBeNull();

    await fs.appendFile(namesFile(), nameLine(CLI_ID, 'Paper Kite') + '\n');
    await idx.refresh();
    expect(titles(idx)).toMatchObject({ [DESKTOP_ID]: 'Tin Robot', [CLI_ID]: 'Paper Kite' });
  });

  it('a missing, emptied or garbage names file leaves the first-prompt titles', async () => {
    await writeFixtures(root, work);
    const idx = new CodexRolloutIndex(root);
    await idx.refresh();
    expect(titles(idx)).toMatchObject({ [DESKTOP_ID]: '스크린샷의 버그 고쳐줘', [CLI_ID]: 'List the files' });

    await fs.writeFile(namesFile(), nameLine(DESKTOP_ID, 'Tin Robot') + '\n');
    await idx.refresh();
    expect(titles(idx)[DESKTOP_ID]).toBe('Tin Robot');

    await fs.writeFile(namesFile(), '\u0000\u0001 {"id": half\n\n{}\n');
    await idx.refresh();
    expect(titles(idx)[DESKTOP_ID]).toBe('스크린샷의 버그 고쳐줘');

    await fs.rm(namesFile());
    await idx.refresh();
    expect(titles(idx)[DESKTOP_ID]).toBe('스크린샷의 버그 고쳐줘');
    expect(idx.threadName(DESKTOP_ID)).toBeNull();
  });
});

describe('SessionIndex: Codex names and rollout time on listed sessions', () => {
  const roots = () => ({ a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') });
  const find = (index: SessionIndex, id: string, extra: Parameters<SessionIndex['projects']>[0] = []) => index.projects(extra).flatMap((p) => p.sessions).find((s) => s.sessionId === id)!;
  const ownEntry = (file: string, lastModified: number) => ({ sessionId: CLI_ID, account: 'gpt' as const, engine: 'codex' as const, sandbox: 'workspace-write' as const, cwd: work, projectDir: path.dirname(file), file, title: 'List the files', lastModified, sizeBytes: 0 });

  it('title: deck rename > Codex thread name > first prompt, for imported and deck-owned sessions alike', async () => {
    const { cli } = await writeFixtures(root, work);
    await fs.writeFile(path.join(base, 'session_index.jsonl'), nameLine(DESKTOP_ID, 'Tin Robot') + '\n' + nameLine(CLI_ID, 'Paper Kite') + '\n');
    const renamed = new Map<string, string>();
    const index = new SessionIndex({ roots: rootsOf(roots()), pinnedFile: path.join(base, 'p.json'), codexRoot: root, meta: { title: (id) => renamed.get(id) ?? null, isArchived: () => false } });
    await index.refresh();
    const own = [ownEntry(cli, 1)];
    expect(find(index, DESKTOP_ID, own)).toMatchObject({ title: 'Tin Robot', imported: true });
    expect(find(index, CLI_ID, own).title).toBe('Paper Kite');
    expect(find(index, CLI_ID, own).imported).toBeUndefined();
    expect(find(index, GONE_ID, own).title).toBe('hi');
    expect(index.codexOwned(own)[0]!.title).toBe('Paper Kite');

    renamed.set(DESKTOP_ID, 'My Import');
    renamed.set(CLI_ID, 'My Own');
    expect(find(index, DESKTOP_ID, own).title).toBe('My Import');
    expect(find(index, CLI_ID, own).title).toBe('My Own');
  });

  it('a deck-owned Codex session is at least as recent as its rollout file, and follows it on the next refresh', async () => {
    const { cli } = await writeFixtures(root, work);
    const index = new SessionIndex({ roots: rootsOf(roots()), pinnedFile: path.join(base, 'p.json'), codexRoot: root });
    const t1 = new Date('2026-10-02T03:00:00.000Z');
    await fs.utimes(cli, t1, t1);
    await index.refresh();
    const stale = ownEntry(cli, t1.getTime() - 86_400_000);
    expect(find(index, CLI_ID, [stale]).lastModified).toBe(t1.getTime());

    // Codex wrote the rollout outside deck.
    const t2 = new Date('2026-10-02T04:30:00.000Z');
    await fs.utimes(cli, t2, t2);
    expect(find(index, CLI_ID, [stale]).lastModified).toBe(t1.getTime());
    await index.refresh();
    expect(find(index, CLI_ID, [stale]).lastModified).toBe(t2.getTime());

    // A deck turn newer than the file keeps its own time; other engines and unknown threads pass through.
    const newer = ownEntry(cli, t2.getTime() + 5000);
    expect(find(index, CLI_ID, [newer]).lastModified).toBe(t2.getTime() + 5000);
    const gemini = { ...stale, sessionId: 'gem-1', engine: 'gemini' as const, account: 'g1' as const };
    const unknown = { ...stale, sessionId: '01a0f2d3-0000-7c92-aeea-0000000000ff' };
    expect(index.codexOwned([gemini, unknown])).toEqual([gemini, unknown]);
  });
});

describe('SessionIndex with codexArchivedRoot', () => {
  it('Codex-archived threads stay archived through the deck meta overlay; threads outside pinned projects get their own group', async () => {
    await writeFixtures(root, work);
    const arch = path.join(base, 'archived_sessions');
    const other = path.join(base, 'Desktop');
    await fs.mkdir(arch);
    await fs.mkdir(other);
    const AID = '01a0f2d3-0000-7c92-aeea-0000000000a1';
    await fs.writeFile(path.join(arch, `rollout-2026-09-01T10-00-00-${AID}.jsonl`), jsonl([meta(AID, other), user('old idea')]));
    const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
    await fs.writeFile(path.join(base, 'p.json'), JSON.stringify([{ cwd: work, name: 'work' }]));
    const meta0 = { title: () => null, isArchived: () => false };
    const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json'), codexRoot: root, codexArchivedRoot: arch, meta: meta0 });
    await index.refresh();
    const projects = index.projects();
    expect(projects[0]).toMatchObject({ cwd: work, pinned: true });
    const desk = projects.find((p) => p.cwd === other);
    expect(desk).toMatchObject({ name: 'Desktop', pinned: false });
    expect(desk?.sessions[0]).toMatchObject({ sessionId: AID, archived: true, codexArchived: true });
  });
});

describe('SessionIndex.freshCodexImport', () => {
  it('rescans (and pushes onChange) when Codex archived / unarchived the thread or its folder came back; else no rescan', async () => {
    const { cli } = await writeFixtures(root, work);
    const arch = path.join(base, 'archived_sessions');
    await fs.mkdir(arch);
    const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
    const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json'), codexRoot: root, codexArchivedRoot: arch });
    await index.refresh();
    let changes = 0;
    index.onChange = () => { changes++; };
    expect(await index.freshCodexImport(CLI_ID)).not.toHaveProperty('codexArchived');
    expect(changes).toBe(0);
    // Archived in Codex: the rollout moved.
    const moved = path.join(arch, path.basename(cli));
    await fs.rename(cli, moved);
    expect(await index.freshCodexImport(CLI_ID)).toMatchObject({ file: moved, codexArchived: true });
    expect(changes).toBe(1);
    // Own (my-wrapper) copy of a thread Codex archived: archived too.
    const own = { sessionId: CLI_ID, account: 'gpt' as const, engine: 'codex' as const, cwd: work, projectDir: '', file: cli, title: 'deck title', lastModified: 1, sizeBytes: 0 };
    expect(index.projects([own]).flatMap((p) => p.sessions).find((e) => e.sessionId === CLI_ID)).toMatchObject({ title: 'deck title', archived: true, codexArchived: true });
    // Unarchived again.
    await fs.rename(moved, cli);
    expect(await index.freshCodexImport(CLI_ID)).toMatchObject({ file: cli });
    expect(index.codexImport(CLI_ID)).not.toHaveProperty('codexArchived');
    expect(index.projects([own]).flatMap((p) => p.sessions).find((e) => e.sessionId === CLI_ID)).not.toHaveProperty('archived');
    // A gone folder that is back.
    expect(index.codexImport(GONE_ID)?.cwdMissing).toBe(true);
    await fs.mkdir(path.join(work, 'deleted-temp-dir'));
    expect(await index.freshCodexImport(GONE_ID)).not.toHaveProperty('cwdMissing');
    expect(changes).toBe(3);
  });
});

describe('rolloutRecentlyActive', () => {
  it('true within 2 minutes of the last write, false after or when missing', async () => {
    const { cli } = await writeFixtures(root, work);
    const mtime = (await fs.stat(cli)).mtimeMs;
    expect(await rolloutRecentlyActive(cli, mtime + 60_000)).toBe(true);
    expect(await rolloutRecentlyActive(cli, mtime + 3 * 60_000)).toBe(false);
    expect(await rolloutRecentlyActive(path.join(base, 'missing'), mtime)).toBe(false);
  });
});

describe('SessionIndex codexInBackground', () => {
  it('resolves before the Codex read finishes and calls onChange once threads are in', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-idx-bg-'));
    const work = path.join(base, 'work');
    await fs.mkdir(work);
    const root = path.join(base, 'codex');
    await writeFixtures(root, work);
    const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
    const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json'), codexRoot: root });
    const changed = new Promise<void>((r) => { index.onChange = r; });
    await index.refresh({ codexInBackground: true });
    expect(index.codexImport(DESKTOP_ID)).toBeNull();
    await changed;
    expect(index.codexImport(DESKTOP_ID)).not.toBeNull();
    await fs.rm(base, { recursive: true, force: true });
  });
});
