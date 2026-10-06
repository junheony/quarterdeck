import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KEEP_MARKER, backupStampMs, pruneSessionBackups } from './backupPrune';

const ID = '66666666-6666-4666-8666-666666666666';
const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();

describe('pruneSessionBackups', () => {
  it('parses only deck\'s own backup names', () => {
    expect(backupStampMs(`20260902-110000-${ID}`)).toBe(new Date(2026, 8, 2, 11, 0, 0).getTime());
    expect(backupStampMs(`20260902-110000-${ID}-3`)).toBe(new Date(2026, 8, 2, 11, 0, 0).getTime());
    for (const bad of [`20261302-110000-${ID}`, `20260902-110000-not-a-uuid`, `x20260902-110000-${ID}`, `20260902-110000-${ID}.bak`, 'notes']) expect(backupStampMs(bad)).toBeNull();
  });

  it('removes only matching directories older than the retention; everything else stays', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-bkprune-'));
    const old = path.join(root, `20260801-090000-${ID}`);
    const oldDup = path.join(root, `20260801-090000-${ID}-1`);
    const fresh = path.join(root, `20260930-090000-${ID}`);
    await fs.mkdir(path.join(old, ID), { recursive: true });
    await fs.writeFile(path.join(old, `${ID}.jsonl`), 'x\n');
    await fs.mkdir(oldDup);
    await fs.mkdir(fresh);
    // Not deck's: an old-looking file, a foreign dir, a symlink with a matching name pointing elsewhere.
    await fs.writeFile(path.join(root, `20260101-000000-${ID}-2`), 'file');
    await fs.mkdir(path.join(root, 'keep-me'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-bkprune-outside-'));
    await fs.symlink(outside, path.join(root, `20260101-000000-${ID}-5`));

    const removed = await pruneSessionBackups(root, 30, NOW);
    expect(removed.sort()).toEqual([old, oldDup].sort());
    expect((await fs.readdir(root)).sort()).toEqual([`20260101-000000-${ID}-2`, `20260101-000000-${ID}-5`, `20260930-090000-${ID}`, 'keep-me'].sort());
    expect(await fs.stat(outside).then(() => true)).toBe(true);
    // A shorter retention takes the fresher one too; a missing root is fine.
    expect(await pruneSessionBackups(root, 1, NOW)).toEqual([fresh]);
    expect(await pruneSessionBackups(path.join(root, 'nope'), 30, NOW)).toEqual([]);
  });

  it('never prunes a backup marked to keep (the only copy of overwritten turns)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-bkprune-'));
    const kept = path.join(root, `20260801-090000-${ID}`);
    await fs.mkdir(kept);
    await fs.writeFile(path.join(kept, KEEP_MARKER), 'x');
    expect(await pruneSessionBackups(root, 30, NOW)).toEqual([]);
    expect(await fs.stat(kept).then(() => true)).toBe(true);
  });
});
