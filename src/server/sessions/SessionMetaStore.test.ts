import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_TITLE_CHARS, SessionMetaStore } from './SessionMetaStore';
import { SessionIndex } from './SessionIndex';
import { rootsOf } from '../../shared/accounts.testkit';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'deck-meta-'));

describe('SessionMetaStore', () => {
  it('renames, archives, persists 0600 and reloads', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'cfg', 'session-meta.json');
    const s = new SessionMetaStore(file);
    await s.load();
    await s.update(ID1, { title: '  새   이름 ' });
    await s.update(ID2, { archived: true });
    expect(s.title(ID1)).toBe('새 이름');
    expect(s.isArchived(ID2)).toBe(true);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const again = new SessionMetaStore(file);
    await again.load();
    expect(again.snapshot()).toEqual({ titles: { [ID1]: '새 이름' }, archived: [ID2] });
  });

  it('records branch links with the parent title, persists and reloads; junk links dropped', async () => {
    const file = path.join(await tmp(), 'm.json');
    const s = new SessionMetaStore(file);
    await s.load();
    await s.update(ID1, { title: '원본' });
    await s.branch(ID2, ID1, 3);
    expect(s.branchOf(ID2)).toEqual({ parent: ID1, n: 3 });
    expect(s.branchOf(ID1)).toBeNull();
    expect(s.title(ID2)).toBe('원본');
    const again = new SessionMetaStore(file);
    await again.load();
    expect(again.snapshot().branches).toEqual({ [ID2]: { parent: ID1, n: 3 } });
    await fs.writeFile(file, JSON.stringify({ titles: {}, archived: [], branches: { [ID2]: { parent: ID1, n: -1 }, [ID1]: { parent: '../x', n: 1 }, x: 5 } }));
    const junk = new SessionMetaStore(file);
    await junk.load();
    expect(junk.snapshot().branches).toBeUndefined();
  });

  it('empty / null title resets; unarchive removes; title capped', async () => {
    const s = new SessionMetaStore(path.join(await tmp(), 'm.json'));
    await s.update(ID1, { title: 'x', archived: true });
    await s.update(ID1, { title: null, archived: false });
    expect(s.title(ID1)).toBeNull();
    expect(s.isArchived(ID1)).toBe(false);
    await s.update(ID1, { title: 'y'.repeat(500) });
    expect(s.title(ID1)!.length).toBe(MAX_TITLE_CHARS);
    await s.update(ID1, { title: '   ' });
    expect(s.title(ID1)).toBeNull();
  });

  it('a corrupt file is moved aside and junk entries are dropped', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'm.json');
    await fs.writeFile(file, '{not json');
    const s = new SessionMetaStore(file);
    await s.load();
    expect(s.snapshot()).toEqual({ titles: {}, archived: [] });
    expect(await fs.readFile(`${file}.bad`, 'utf8')).toBe('{not json');
    await fs.writeFile(file, JSON.stringify({ titles: { '../x': 'bad', [ID1]: 'ok', [ID2]: 5 }, archived: ['/etc', ID2] }));
    const t = new SessionMetaStore(file);
    await t.load();
    expect(t.snapshot()).toEqual({ titles: { [ID1]: 'ok' }, archived: [ID2] });
  });

  it('SessionIndex lays titles and archive flags over the scan; regroup applies changes without a rescan', async () => {
    const dir = await tmp();
    const root = path.join(dir, 'b');
    await fs.mkdir(path.join(root, '-w-p'), { recursive: true });
    await fs.writeFile(path.join(root, '-w-p', `${ID1}.jsonl`), JSON.stringify({ type: 'user', cwd: '/w/p', message: { role: 'user', content: 'first prompt' } }) + '\n');
    const meta = new SessionMetaStore(path.join(dir, 'm.json'));
    const index = new SessionIndex({ roots: rootsOf({ a: path.join(dir, 'a'), b: root, c: path.join(dir, 'c') }), pinnedFile: path.join(dir, 'p.json'), meta });
    await index.refresh();
    expect(index.projects()[0]!.sessions[0]).toMatchObject({ title: 'first prompt' });
    expect(index.projects()[0]!.sessions[0]!.archived).toBeUndefined();
    await meta.update(ID1, { title: 'Renamed', archived: true });
    index.regroup();
    expect(index.projects()[0]!.sessions[0]).toMatchObject({ title: 'Renamed', archived: true });
    await meta.update(ID1, { title: null, archived: false });
    index.regroup();
    expect(index.projects()[0]!.sessions[0]!.title).toBe('first prompt');
    expect(index.projects()[0]!.sessions[0]!.archived).toBeUndefined();
    // The jsonl itself is untouched.
    expect(await fs.readFile(path.join(root, '-w-p', `${ID1}.jsonl`), 'utf8')).not.toContain('Renamed');
  });

  it('handoff links: link() titles the new session, persists next, reloads both directions; junk links are dropped', async () => {
    const file = path.join(await tmp(), 'm.json');
    const s = new SessionMetaStore(file);
    await s.load();
    expect(s.snapshot()).not.toHaveProperty('next');
    await s.link(ID1, ID2, '작업 (이어서)');
    expect(s.next(ID1)).toBe(ID2);
    expect(s.prev(ID2)).toBe(ID1);
    expect(s.title(ID2)).toBe('작업 (이어서)');
    const again = new SessionMetaStore(file);
    await again.load();
    expect(again.snapshot()).toEqual({ titles: { [ID2]: '작업 (이어서)' }, archived: [], next: { [ID1]: ID2 } });
    expect(again.prev(ID2)).toBe(ID1);
    await fs.writeFile(file, JSON.stringify({ titles: {}, archived: [], next: { '../x': ID2, [ID1]: ID1, [ID2]: 5 } }));
    const junk = new SessionMetaStore(file);
    await junk.load();
    expect(junk.snapshot()).toEqual({ titles: {}, archived: [] });
  });

  it('a session continues into one session only: a second link() from it is refused, the first link kept', async () => {
    const ID3 = '33333333-3333-4333-8333-333333333333';
    const file = path.join(await tmp(), 'm.json');
    const s = new SessionMetaStore(file);
    await s.load();
    await s.link(ID1, ID2, '작업 (이어서)');
    await s.link(ID1, ID3, '작업 (이어서)');
    expect(s.next(ID1)).toBe(ID2);
    expect(s.prev(ID2)).toBe(ID1);
    expect(s.prev(ID3)).toBeNull();
    expect(s.title(ID3)).toBeNull();
    await s.link(ID1, ID2, '작업 (이어서)'); // the same link again is fine
    expect(s.next(ID1)).toBe(ID2);
    const again = new SessionMetaStore(file);
    await again.load();
    expect(again.next(ID1)).toBe(ID2);
    expect(again.prev(ID3)).toBeNull();
  });

  it('SessionIndex decorates entries with prevSession / nextSession from the links', async () => {
    const dir = await tmp();
    const root = path.join(dir, 'b');
    await fs.mkdir(path.join(root, '-w-p'), { recursive: true });
    for (const id of [ID1, ID2]) await fs.writeFile(path.join(root, '-w-p', `${id}.jsonl`), JSON.stringify({ type: 'user', cwd: '/w/p', message: { role: 'user', content: `p ${id.slice(0, 1)}` } }) + '\n');
    const meta = new SessionMetaStore(path.join(dir, 'm.json'));
    const index = new SessionIndex({ roots: rootsOf({ a: path.join(dir, 'a'), b: root, c: path.join(dir, 'c') }), pinnedFile: path.join(dir, 'p.json'), meta });
    await index.refresh();
    const byId = () => new Map(index.projects()[0]!.sessions.map((e) => [e.sessionId, e]));
    expect(byId().get(ID1)!.nextSession).toBeUndefined();
    await meta.link(ID1, ID2, 'p 1 (이어서)');
    index.regroup();
    expect(byId().get(ID1)).toMatchObject({ nextSession: ID2 });
    expect(byId().get(ID1)!.prevSession).toBeUndefined();
    expect(byId().get(ID2)).toMatchObject({ prevSession: ID1, title: 'p 1 (이어서)' });
  });
});
