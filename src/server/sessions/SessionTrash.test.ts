import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pruneRootsOf, pruneSessionBackups } from './backupPrune';
import { isTrashId, moveToTrash, restoreFromTrash, TRASH_DIR } from './SessionTrash';

const ID = '77777777-7777-4777-8777-777777777777';
const NOW = new Date(2026, 9, 2, 13, 4, 5).getTime();

async function profile(root: string, name: string, withComp = true) {
  const configDir = path.join(root, name);
  const projectDir = path.join(configDir, 'projects', '-Users-me-app');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, `${ID}.jsonl`), `{"sessionId":"${ID}"}\n`);
  if (withComp) { await fs.mkdir(path.join(projectDir, ID)); await fs.writeFile(path.join(projectDir, ID, 'note.txt'), 'n'); }
  await fs.writeFile(path.join(projectDir, 'other.jsonl'), 'keep\n');
  return { configDir, projectDir };
}

const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

describe('SessionTrash', () => {
  it('moves every copy (jsonl + companion dir) into its own profile trash and restores them', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-trash-'));
    const a = await profile(root, 'a');
    const b = await profile(root, 'b', false);
    const r = await moveToTrash({ sessionId: ID, projectDirs: [b.projectDir, a.projectDir, b.projectDir], nowMs: NOW });
    expect(r.trashId).toBe(`20261002-130405-${ID}`);
    expect(isTrashId(r.trashId)).toBe(true);
    for (const p of [a, b]) {
      expect(await exists(path.join(p.projectDir, `${ID}.jsonl`))).toBe(false);
      expect(await exists(path.join(p.projectDir, 'other.jsonl'))).toBe(true);
      expect(await exists(path.join(p.configDir, TRASH_DIR, r.trashId, `${ID}.jsonl`))).toBe(true);
    }
    expect(await fs.readFile(path.join(a.configDir, TRASH_DIR, r.trashId, ID, 'note.txt'), 'utf8')).toBe('n');

    const back = await restoreFromTrash({ trashId: r.trashId, projectsRoots: [path.join(a.configDir, 'projects'), path.join(b.configDir, 'projects')] });
    expect(back.sessionId).toBe(ID);
    expect(back.restored).toHaveLength(2);
    expect(await fs.readFile(path.join(a.projectDir, ID, 'note.txt'), 'utf8')).toBe('n');
    expect(await exists(path.join(b.projectDir, `${ID}.jsonl`))).toBe(true);
    expect(await exists(path.join(a.configDir, TRASH_DIR, r.trashId))).toBe(false);
    await expect(restoreFromTrash({ trashId: r.trashId, projectsRoots: [path.join(a.configDir, 'projects')] })).rejects.toThrow(/휴지통에 없는/);
  });

  it('a second delete in the same second gets its own trash dir; restore refuses to overwrite', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-trash-'));
    const a = await profile(root, 'a');
    const first = await moveToTrash({ sessionId: ID, projectDirs: [a.projectDir], nowMs: NOW });
    await fs.writeFile(path.join(a.projectDir, `${ID}.jsonl`), 'new\n');
    const second = await moveToTrash({ sessionId: ID, projectDirs: [a.projectDir], nowMs: NOW });
    expect(second.trashId).toBe(`${first.trashId}-1`);
    await fs.writeFile(path.join(a.projectDir, `${ID}.jsonl`), 'again\n');
    await expect(restoreFromTrash({ trashId: first.trashId, projectsRoots: [path.join(a.configDir, 'projects')] })).rejects.toThrow(/이미 있어/);
    expect(await fs.readFile(path.join(a.projectDir, `${ID}.jsonl`), 'utf8')).toBe('again\n');
    expect(await exists(path.join(a.configDir, TRASH_DIR, first.trashId, `${ID}.jsonl`))).toBe(true);
  });

  it('refuses a missing transcript and malformed trash ids', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-trash-'));
    await expect(moveToTrash({ sessionId: ID, projectDirs: [path.join(root, 'nope', 'projects', 'x')] })).rejects.toThrow(/없습니다/);
    await expect(restoreFromTrash({ trashId: '../../etc', projectsRoots: [path.join(root, 'projects')] })).rejects.toThrow(/잘못된/);
  });

  it('restore refuses a tampered manifest: another id, an unnormalized path, or a dir outside projects/', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-trash-'));
    const a = await profile(root, 'a');
    const { trashId } = await moveToTrash({ sessionId: ID, projectDirs: [a.projectDir], nowMs: NOW });
    const mf = path.join(a.configDir, TRASH_DIR, trashId, 'manifest.json');
    const good = JSON.parse(await fs.readFile(mf, 'utf8')) as { sessionId: string; copies: { projectDir: string; dir: string }[] };
    const bad = [
      { ...good, sessionId: '' },
      { ...good, sessionId: ID.slice(0, 8) },
      { ...good, copies: [{ projectDir: `${a.configDir}/projects/x/../-Users-me-app`, dir: '' }] },
      { ...good, copies: [{ projectDir: path.join(a.configDir, 'other', '-Users-me-app'), dir: '' }] },
      { ...good, copies: [{ projectDir: path.join(a.configDir, 'projects', 'p', 'deeper'), dir: '' }] },
    ];
    for (const m of bad) {
      await fs.writeFile(mf, JSON.stringify(m));
      await expect(restoreFromTrash({ trashId, projectsRoots: [path.join(a.configDir, 'projects')] }), JSON.stringify(m)).rejects.toThrow(/맞지 않습니다/);
    }
    await fs.writeFile(mf, JSON.stringify(good));
    expect((await restoreFromTrash({ trashId, projectsRoots: [path.join(a.configDir, 'projects')] })).sessionId).toBe(ID);
  });

  it('expired trash entries are pruned with the backups (DECK_BACKUP_RETENTION_DAYS)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-trash-'));
    const a = await profile(root, 'a');
    const old = await moveToTrash({ sessionId: ID, projectDirs: [a.projectDir], nowMs: new Date(2026, 7, 1).getTime() });
    const [backups, trash] = pruneRootsOf(a.configDir);
    expect(trash).toBe(path.join(a.configDir, TRASH_DIR));
    expect(backups).toBe(path.join(a.configDir, 'session-backups'));
    const removed = await pruneSessionBackups(trash!, 30, NOW);
    expect(removed).toEqual([path.join(trash!, old.trashId)]);
  });
});
