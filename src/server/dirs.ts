import fs from 'node:fs/promises';
import path from 'node:path';

/** A path the folder picker / new-session cwd may not use; the message is shown to the user (400). */
export class DirError extends Error {}

export const MAX_DIR_ENTRIES = 200;

export type DirListing = { path: string; parent: string | null; dirs: { name: string; path: string }[] };

/** True when `p` is one of `roots` or lies inside one (all paths already real/absolute). */
export function isUnderRoots(p: string, roots: string[]): boolean {
  return roots.some((r) => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}

/** Real paths of `roots` (a missing root is dropped). */
export async function realRoots(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of roots) {
    try { out.push(await fs.realpath(r)); } catch { /* missing root */ }
  }
  return out;
}

/**
 * F1: `~`, `~/…` or an absolute path → its real path, which must be an existing directory
 * inside one of `roots` (default: the home dir). Symlinks are resolved first, so one pointing
 * outside is refused; `~user` and relative paths are refused.
 */
export async function resolveUnderRoots(input: string, home: string, roots: string[] = [home]): Promise<string> {
  const raw = input.trim();
  let abs: string;
  if (raw === '~') abs = home;
  else if (raw.startsWith('~/')) abs = path.join(home, raw.slice(2));
  else if (raw.startsWith('/')) abs = raw;
  else throw new DirError('절대 경로나 ~ 로 시작하는 경로만 쓸 수 있습니다');
  let real: string;
  try {
    real = await fs.realpath(path.resolve(abs));
  } catch {
    throw new DirError(`폴더를 찾을 수 없습니다: ${raw}`);
  }
  if (!isUnderRoots(real, await realRoots(roots))) throw new DirError('홈 폴더 안의 경로만 열 수 있습니다');
  const st = await fs.stat(real).catch(() => null);
  if (!st?.isDirectory()) throw new DirError(`폴더가 아닙니다: ${raw}`);
  return real;
}

export function resolveUnderHome(input: string, home: string): Promise<string> {
  return resolveUnderRoots(input, home, [home]);
}

/** F1 `/api/dirs`: non-hidden subdirectories (never files, never symlinks), sorted, capped. Read-only. */
export async function listDirs(input: string, home: string, max = MAX_DIR_ENTRIES): Promise<DirListing> {
  const dir = await resolveUnderHome(input, home);
  const realHome = await fs.realpath(home);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    throw new DirError('폴더를 읽을 수 없습니다');
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, max)
    .map((name) => ({ name, path: path.join(dir, name) }));
  return { path: dir, parent: dir === realHome ? null : path.dirname(dir), dirs };
}
