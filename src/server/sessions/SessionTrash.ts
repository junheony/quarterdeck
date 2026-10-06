import fs from 'node:fs/promises';
import path from 'node:path';

/** Next to session-backups/ in each profile's config dir; pruned like it (backupPrune). */
export const TRASH_DIR = 'session-trash';
const MANIFEST = 'manifest.json';

/** `<yyyymmdd-hhmmss>-<uuid>[-n]` — the same names SessionFork gives its backups. */
const TRASH_ID = /^\d{8}-\d{6}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-\d+)?$/i;

export function isTrashId(v: unknown): v is string {
  return typeof v === 'string' && TRASH_ID.test(v);
}

/** `dir`: where inside the trash entry this copy's files are ('' = the entry itself, like session-backups). */
type Manifest = { sessionId: string; trashedAt: number; copies: { projectDir: string; dir: string }[] };

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(() => true, () => false);
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** `<configDir>/projects/<name>` → `<configDir>/session-trash`. */
export function trashRootOf(projectDir: string): string {
  return path.join(path.dirname(path.dirname(projectDir)), TRASH_DIR);
}

/**
 * 삭제 = move, never unlink: every copy's `<id>.jsonl` and `<id>/` go into its own profile's
 * `session-trash/<stamp>-<id>/` (rename inside the same config dir) with a manifest of where they came from.
 * All copies share one trash id (the undo handle). Any failure puts back what was moved and removes the
 * trash dirs this call made.
 */
export async function moveToTrash(opts: { sessionId: string; projectDirs: string[]; nowMs?: number }): Promise<{ trashId: string; dirs: string[] }> {
  const id = opts.sessionId;
  const nowMs = opts.nowMs ?? Date.now();
  const dirs = [...new Set(opts.projectDirs.map((d) => path.resolve(d)))];
  const sources = [];
  for (const projectDir of dirs) {
    const file = path.join(projectDir, `${id}.jsonl`);
    if (!(await fs.stat(file).then((s) => s.isFile(), () => false))) continue;
    sources.push({ projectDir, file, comp: path.join(projectDir, id) });
  }
  if (!sources.length) throw new Error('지울 대화 파일이 없습니다');

  // One name free in every profile's trash.
  let trashId = '';
  for (let i = 0; !trashId; i++) {
    if (i > 20) throw new Error('휴지통 이름을 정하지 못했습니다');
    const name = `${stamp(nowMs)}-${id}${i ? `-${i}` : ''}`;
    let free = true;
    for (const s of sources) if (await exists(path.join(trashRootOf(s.projectDir), name))) free = false;
    if (free) trashId = name;
  }

  // Copies whose profiles share a config dir share one trash entry (extra copies in copy-<n>/).
  const byRoot = new Map<string, typeof sources>();
  for (const src of sources) byRoot.set(trashRootOf(src.projectDir), [...(byRoot.get(trashRootOf(src.projectDir)) ?? []), src]);
  const made: string[] = [];
  const moved: [string, string][] = [];
  try {
    for (const [root, list] of byRoot) {
      const dir = path.join(root, trashId);
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.mkdir(dir, { mode: 0o700 });
      made.push(dir);
      const manifest: Manifest = { sessionId: id, trashedAt: nowMs, copies: list.map((src, i) => ({ projectDir: src.projectDir, dir: i ? `copy-${i}` : '' })) };
      await fs.writeFile(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
      for (const [i, src] of list.entries()) {
        const into = path.join(dir, manifest.copies[i]!.dir);
        if (i) await fs.mkdir(into, { mode: 0o700 });
        const to = path.join(into, `${id}.jsonl`);
        await fs.rename(src.file, to);
        moved.push([src.file, to]);
        if (await exists(src.comp)) {
          const toComp = path.join(into, id);
          await fs.rename(src.comp, toComp);
          moved.push([src.comp, toComp]);
        }
      }
    }
  } catch (err) {
    for (const [from, to] of moved.reverse()) if (!(await exists(from))) await fs.rename(to, from).catch(() => undefined);
    for (const d of made) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return { trashId, dirs: made };
}

/**
 * Undo: every `<configDir>/session-trash/<trashId>/` found (configDir = a projects root's parent) is moved back to its
 * manifest's project dir. Refused (nothing moved) when a transcript of that id already exists there again.
 */
export async function restoreFromTrash(opts: { trashId: string; projectsRoots: string[] }): Promise<{ sessionId: string; restored: string[] }> {
  const idOfTrash = TRASH_ID.exec(opts.trashId)?.[1];
  if (!idOfTrash) throw new Error('잘못된 휴지통 항목입니다');
  const found: { entry: string; m: Manifest }[] = [];
  const roots = [...new Set(opts.projectsRoots.map((r) => path.resolve(r)))];
  for (const configDir of [...new Set(roots.map((r) => path.dirname(r)))]) {
    const entry = path.join(configDir, TRASH_DIR, opts.trashId);
    const st = await fs.lstat(entry).catch(() => null);
    if (!st?.isDirectory()) continue;
    const m = JSON.parse(await fs.readFile(path.join(entry, MANIFEST), 'utf8')) as Manifest;
    // The manifest's id is exactly the trash name's, and every copy points back to a project dir directly inside a
    // projects root of this same config dir (a normalized absolute path: never somewhere else on disk).
    const own = roots.filter((r) => path.dirname(r) === configDir);
    const ok = m.sessionId === idOfTrash && Array.isArray(m.copies) && m.copies.length > 0
      && m.copies.every((c) => typeof c.projectDir === 'string' && path.resolve(c.projectDir) === c.projectDir && own.includes(path.dirname(c.projectDir))
        && trashRootOf(c.projectDir) === path.join(configDir, TRASH_DIR) && typeof c.dir === 'string' && /^(copy-\d+)?$/.test(c.dir));
    if (!ok) throw new Error('휴지통 항목 정보가 맞지 않습니다');
    if (!found.some((f) => f.entry === entry)) found.push({ entry, m });
  }
  if (!found.length) throw new Error('휴지통에 없는 항목입니다(이미 되돌렸거나 정리됨)');
  const id = found[0]!.m.sessionId;
  for (const { m } of found) {
    for (const c of m.copies) {
      if (await exists(path.join(c.projectDir, `${id}.jsonl`))) throw new Error('같은 대화가 이미 있어 되돌리지 않았습니다');
      if (await exists(path.join(c.projectDir, id))) throw new Error('같은 대화 폴더가 이미 있어 되돌리지 않았습니다');
    }
  }
  const restored: string[] = [];
  for (const { entry, m } of found) {
    for (const c of m.copies) {
      const from = path.join(entry, c.dir);
      await fs.mkdir(c.projectDir, { recursive: true });
      if (await exists(path.join(from, id))) await fs.rename(path.join(from, id), path.join(c.projectDir, id));
      const file = path.join(c.projectDir, `${id}.jsonl`);
      await fs.rename(path.join(from, `${id}.jsonl`), file);
      restored.push(file);
      if (c.dir) await fs.rmdir(from).catch(() => undefined);
    }
    await fs.rm(path.join(entry, MANIFEST), { force: true });
    await fs.rmdir(entry).catch(() => undefined);
  }
  return { sessionId: id, restored };
}
