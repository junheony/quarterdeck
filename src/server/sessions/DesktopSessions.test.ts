import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionEntry } from '../../shared/session-types';
import { readDesktopMeta, recentDesktopSessions } from './DesktopSessions';
import { SessionIndex } from './SessionIndex';
import { rootsOf } from '../../shared/accounts.testkit';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** One Desktop record under <root>/<acct>/<org>/local_<uuid>.json. */
async function writeMeta(root: string, n: number, fields: Record<string, unknown>, mtimeMs = 1_000_000 + n): Promise<string> {
  const dir = path.join(root, 'acct-1', 'org-1');
  await fs.mkdir(dir, { recursive: true });
  const f = path.join(dir, `local_${uuid(900 + n)}.json`);
  await fs.writeFile(f, JSON.stringify({ sessionId: `local_${uuid(900 + n)}`, cliSessionId: uuid(n), ...fields }));
  await fs.utimes(f, mtimeMs / 1000, mtimeMs / 1000);
  return f;
}

const entry = (n: number, over: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: uuid(n), account: 'a', engine: 'claude', cwd: `/Users/x/proj${n}`, projectDir: '/p', file: `/p/${uuid(n)}.jsonl`, title: `first prompt ${n}`, lastModified: 0, sizeBytes: 1, ...over,
});

describe('readDesktopMeta', () => {
  it('reads title/cwd/activity and rejects archived or id-less records', async () => {
    const root = await mkTmp('deck-dsk-');
    const ok = await writeMeta(root, 1, { title: ' My title ', cwd: '/Users/x/p', lastActivityAt: 5000 });
    expect(await readDesktopMeta(ok, 1)).toEqual({ cliSessionId: uuid(1), title: 'My title', cwd: '/Users/x/p', activityMs: 5000 });
    expect(await readDesktopMeta(await writeMeta(root, 2, { isArchived: true }), 1)).toBeNull();
    expect(await readDesktopMeta(await writeMeta(root, 3, { cliSessionId: '--flag' }), 1)).toBeNull();
    const bad = path.join(root, 'acct-1', 'org-1', `local_${uuid(999)}.json`);
    await fs.writeFile(bad, '{not json');
    expect(await readDesktopMeta(bad, 1)).toBeNull();
  });
});

describe('recentDesktopSessions', () => {
  it('returns the newest 8 openable sessions, Desktop title first, fallback to the transcript title', async () => {
    const root = await mkTmp('deck-dsk-');
    const known = new Map<string, SessionEntry>();
    for (let n = 1; n <= 10; n++) {
      await writeMeta(root, n, { ...(n % 2 ? { title: `Desktop ${n}` } : {}), cwd: `/Users/x/proj${n}`, lastActivityAt: n * 1000 });
      known.set(uuid(n), entry(n, n === 10 ? { account: 'b', lastModified: 99_000 } : {}));
    }
    // A record whose transcript is unknown to the index (not openable) is skipped.
    await writeMeta(root, 11, { title: 'orphan', lastActivityAt: 50_000 });
    // Files outside the record pattern are never read.
    await fs.writeFile(path.join(root, 'acct-1', 'org-1', 'scheduled-tasks.json'), JSON.stringify({ cliSessionId: uuid(1) }));
    const list = await recentDesktopSessions(root, (id) => known.get(id) ?? null);
    expect(list).toHaveLength(8);
    expect(list.map((d) => d.sessionId)).toEqual([10, 9, 8, 7, 6, 5, 4, 3].map(uuid));
    // Session 10 was moved to B and continued there: newest activity wins, account reflects where it lives.
    expect(list[0]).toEqual({ sessionId: uuid(10), account: 'b', title: 'first prompt 10', cwd: '/Users/x/proj10', project: 'proj10', lastModified: 99_000 });
    expect(list[1]).toMatchObject({ title: 'Desktop 9', project: 'proj9', lastModified: 9000 });
  });

  it('returns [] when Claude Desktop has no session store', async () => {
    expect(await recentDesktopSessions('/nonexistent/deck-desktop', () => entry(1))).toEqual([]);
  });
});

describe('SessionIndex.desktop', () => {
  it('joins the Desktop records with the profile scan on refresh', async () => {
    const base = await mkTmp('deck-dsk-idx-');
    const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
    const projDir = path.join(roots.a, '-Users-x-deck');
    await fs.mkdir(projDir, { recursive: true });
    await fs.writeFile(path.join(projDir, `${uuid(1)}.jsonl`), JSON.stringify({ type: 'user', cwd: '/Users/x/deck', sessionId: uuid(1), message: { role: 'user', content: 'hello from desktop' } }) + '\n');
    const desktopRoot = path.join(base, 'claude-code-sessions');
    await writeMeta(desktopRoot, 1, { title: 'Desktop work', cwd: '/Users/x/deck', lastActivityAt: 1 });
    const idx = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json'), desktopRoot });
    expect(idx.desktop()).toEqual([]);
    await idx.refresh();
    expect(idx.desktop()).toEqual([expect.objectContaining({ sessionId: uuid(1), account: 'a', title: 'Desktop work', project: 'deck', cwd: '/Users/x/deck' })]);
    // Without a desktopRoot the list stays empty.
    const plain = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json') });
    await plain.refresh();
    expect(plain.desktop()).toEqual([]);
  });
});
