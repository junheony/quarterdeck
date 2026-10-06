import fs from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 86_400_000;

/**
 * A backup holding the only copy of turns deck overwrote (a diverged B/C copy replaced on relocate) carries this
 * file: pruning never removes it — only the user does.
 */
export const KEEP_MARKER = 'DECK-KEEP.txt';

/**
 * Every dir under a profile's config dir that holds deck-named, dated entries: fork backups (SessionFork)
 * and the 삭제 trash (SessionTrash). Both are pruned after the same retention.
 */
export function pruneRootsOf(configDir: string): string[] {
  return [path.join(configDir, 'session-backups'), path.join(configDir, 'session-trash')];
}

/** `<yyyymmdd-hhmmss>-<uuid>[-n]` — exactly the names SessionFork gives its backups (local time). */
const BACKUP_NAME = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-\d+)?$/i;

/** When a backup entry named by SessionFork was made; null = not one of deck's names. */
export function backupStampMs(name: string): number | null {
  const m = BACKUP_NAME.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const t = new Date(y, mo - 1, d, h, mi, s);
  // Reject impossible stamps (month 13 etc. would roll over).
  if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d || t.getHours() !== h || t.getMinutes() !== mi || t.getSeconds() !== s) return null;
  return t.getTime();
}

/**
 * Deletes the directories directly under `backupRoot` that deck created (name pattern above, a real
 * directory — never a symlink or file) and whose stamp is older than `retentionDays`, unless it holds
 * `KEEP_MARKER`. Nothing else is touched. Returns the removed paths.
 */
export async function pruneSessionBackups(backupRoot: string, retentionDays: number, nowMs: number = Date.now()): Promise<string[]> {
  const entries = await fs.readdir(backupRoot, { withFileTypes: true }).catch(() => []);
  const removed: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const t = backupStampMs(e.name);
    if (t === null || nowMs - t <= retentionDays * DAY_MS) continue;
    const p = path.join(backupRoot, e.name);
    const st = await fs.lstat(p).catch(() => null);
    if (!st?.isDirectory()) continue;
    if (await fs.lstat(path.join(p, KEEP_MARKER)).then(() => true, () => false)) continue;
    await fs.rm(p, { recursive: true, force: true });
    removed.push(p);
  }
  return removed;
}

/** Prunes every root now and then every `everyMs` (default 24 h). Returns a stop function. */
export function startBackupPruning(backupRoots: string[], retentionDays: number, everyMs = DAY_MS): () => void {
  const run = () => {
    for (const root of backupRoots) {
      pruneSessionBackups(root, retentionDays).then(
        (removed) => { if (removed.length) console.log(`deck: ${retentionDays}일 지난 세션 백업/휴지통 ${removed.length}개 정리 (${root})`); },
        (err: unknown) => console.error('deck: session backup cleanup failed', err instanceof Error ? err.message : err),
      );
    }
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
