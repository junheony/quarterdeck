import { createHash, randomUUID } from 'node:crypto';
import { constants as FS } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isAncestor, isBytePrefix, listTree, moveSession, sha256File, type MoveResult } from './SessionMover';
import { KEEP_MARKER } from './backupPrune';
import { readHead } from './transcript';

export const FORK_SUFFIX = '(갈라진 사본)';

export type ReplaceResult =
  | {
    ok: true; move: Extract<MoveResult, { ok: true }>; backupDir: string;
    /** Set-aside copies that changed after the backup (something still wrote them): kept, not deleted. */
    keptAside: string[];
  }
  | { ok: false; error: string; restored: boolean; backupDir: string | null };

export type ForkResult =
  | (Extract<ReplaceResult, { ok: true }> & { fork: { sessionId: string; title: string; file: string } })
  | Extract<ReplaceResult, { ok: false }>;

type DivergedOpts = {
  sessionId: string; sourceProjectDir: string; targetProjectsRoot: string; refuseProjectsRoots: string[];
  move?: typeof moveSession; backupRoot?: string; quietMs?: number; nowMs?: number; newId?: string;
};

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(() => true, () => false);
}

/** Same size and sha256. */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
  return sa.size === sb.size && (await sha256File(a)) === (await sha256File(b));
}

/** Every file of `prefixTree` is in `fullTree` and a byte-prefix of it there (append-only companions; extra files allowed). */
async function treeContains(prefixTree: string, fullTree: string): Promise<boolean> {
  for (const rel of await listTree(prefixTree)) {
    const full = path.join(fullTree, rel);
    if (!(await exists(full)) || !(await isBytePrefix(path.join(prefixTree, rel), full))) return false;
  }
  return true;
}

/** Same set of files, each with the same bytes. */
async function sameTree(a: string, b: string): Promise<boolean> {
  const [la, lb] = await Promise.all([listTree(a), listTree(b)]);
  if (la.length !== lb.length || la.sort().join('\0') !== lb.sort().join('\0')) return false;
  for (const rel of la) if (!(await sameFile(path.join(a, rel), path.join(b, rel)))) return false;
  return true;
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * The transcript with every line's top-level `sessionId` rewritten old → new; other lines (and an unparsable
 * cut-off last line) are kept verbatim. Each rewritten line is checked to differ from the original only there.
 */
function rewriteSessionId(text: string, oldId: string, newId: string): string {
  return text.split('\n').map((line) => {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      return line;
    }
    if (!o || typeof o !== 'object' || Array.isArray(o) || (o as Record<string, unknown>).sessionId !== oldId) return line;
    const out = JSON.stringify({ ...(o as Record<string, unknown>), sessionId: newId });
    const back = JSON.parse(out) as Record<string, unknown>;
    if (back.sessionId !== newId || !isDeepStrictEqual({ ...back, sessionId: oldId }, o)) throw new Error('사본 줄 변환 검증 실패');
    return out;
  }).join('\n');
}

/**
 * The account-switch move found the target profile's copy of `sessionId` went its own way (the same id was
 * continued in two places). Instead of refusing:
 *  1. back the target copy (jsonl + `<id>/`) up to `<configDir>/session-backups/<stamp>-<id>/` and verify it;
 *  2. write a fork of it under a new uuid next to it (every line's `sessionId` rewritten, companions copied,
 *     title "<title> (갈라진 사본)"), verified;
 *  3. set the original target copy aside (renamed, verified equal to the backup) and retry the move once;
 *  4. only after the move succeeded drop the set-aside copy (the backup stays).
 * Any failure puts the original back (from the set-aside copy, else from the backup) and removes the fork.
 * The source copy is only ever read (by `move`). A target copy written within `quietMs` is left alone —
 * something (Desktop/CLI) probably still has it open. A target that merely extends the source (it is ahead,
 * not diverged) is refused — the caller adopts it. `refuseProjectsRoots`: profiles never forked in
 * (the home/protected one, Desktop's) — refused before anything is read.
 */
export async function forkDivergedAndMove(opts: DivergedOpts): Promise<ForkResult> {
  return (await divergedAndMove(opts, true)) as ForkResult;
}

/**
 * The same as forkDivergedAndMove without step 2: the diverged target copy is backed up to
 * `<configDir>/session-backups/<stamp>-<id>/` (verified) and then overwritten by the source — no "(갈라진 사본)"
 * session is written. The backup is then the only copy of the target's own turns, so it is marked
 * (`KEEP_MARKER`) and never pruned. Same refusals and restore on failure.
 */
export function backupDivergedAndMove(opts: Omit<DivergedOpts, 'newId'>): Promise<ReplaceResult> {
  return divergedAndMove(opts, false);
}

async function divergedAndMove(opts: DivergedOpts, makeFork: boolean): Promise<ReplaceResult | ForkResult> {
  const id = opts.sessionId;
  const move = opts.move ?? moveSession;
  const nowMs = opts.nowMs ?? Date.now();
  const newId = opts.newId ?? randomUUID();
  const targetDir = path.join(opts.targetProjectsRoot, path.basename(opts.sourceProjectDir));
  const tFile = path.join(targetDir, `${id}.jsonl`);
  const tComp = path.join(targetDir, id);
  const stagedFile = `${tFile}.deck-forking`;
  const stagedComp = `${tComp}.deck-forking`;
  const nFile = path.join(targetDir, `${newId}.jsonl`);
  const nComp = path.join(targetDir, newId);
  const nFileTmp = `${nFile}.deck-tmp`;
  const nCompTmp = `${nComp}.deck-tmp`;

  let backupDir: string | null = null;
  let bFile = '';
  let bComp = '';
  let hadComp = false;
  let touched = false;
  const created: string[] = [];
  try {
    const real = (p: string) => fs.realpath(p).catch(() => path.resolve(p));
    const targetRoot = await real(opts.targetProjectsRoot);
    for (const r of opts.refuseProjectsRoots) if ((await real(r)) === targetRoot) throw new Error('보호 계정(Desktop)의 사본은 갈라 보관하지 않음');
    if (path.resolve(targetDir) === path.resolve(opts.sourceProjectDir)) throw new Error('원본과 대상이 같은 곳');
    const st = await fs.stat(tFile);
    if (nowMs - st.mtimeMs < (opts.quietMs ?? 120_000)) throw new Error('대상 사본이 방금 전에도 바뀌어 다른 곳(Desktop/CLI)에서 열려 있는 것 같음');
    const sFile = path.join(opts.sourceProjectDir, `${id}.jsonl`);
    if (await isAncestor(tFile, sFile)) throw new Error('대상 사본이 갈라지지 않음');
    if (await isAncestor(sFile, tFile)) throw new Error('대상 사본이 더 최신(원본이 그 앞부분)');
    for (const p of makeFork ? [nFile, nComp, nFileTmp, nCompTmp, stagedFile, stagedComp] : [stagedFile, stagedComp]) if (await exists(p)) throw new Error(`이미 있음: ${p}`);
    hadComp = await exists(tComp);

    // 1. Backup, verified before anything is touched.
    const backupRoot = opts.backupRoot ?? path.join(path.dirname(opts.targetProjectsRoot), 'session-backups');
    await fs.mkdir(backupRoot, { recursive: true });
    for (let i = 0; !backupDir; i++) {
      const dir = path.join(backupRoot, `${stamp(nowMs)}-${id}${i ? `-${i}` : ''}`);
      try {
        await fs.mkdir(dir);
        backupDir = dir;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || i > 20) throw err;
      }
    }
    bFile = path.join(backupDir, `${id}.jsonl`);
    bComp = path.join(backupDir, id);
    if (!makeFork) {
      await fs.writeFile(path.join(backupDir, KEEP_MARKER), `deck 이 ${targetDir} 의 갈라진 사본(${id})을 덮어쓰기 전에 백업했습니다. 이 사본에만 있는 대화가 있을 수 있어 자동 정리에서 빠집니다.\n`, { flag: 'wx' });
    }
    await fs.copyFile(tFile, bFile, FS.COPYFILE_EXCL);
    if (!(await sameFile(tFile, bFile))) throw new Error('백업 검증 실패(jsonl)');
    if (hadComp) {
      await fs.cp(tComp, bComp, { recursive: true, errorOnExist: true, force: false });
      if (!(await sameTree(tComp, bComp))) throw new Error('백업 검증 실패(동반 폴더)');
    }

    // 2. (forkDivergedAndMove only) The fork, built from the (stable) backup. A custom-title record is appended so it wins over any earlier one.
    let fork: { sessionId: string; title: string; file: string } | null = null;
    if (makeFork) {
      const title = `${(await readHead(bFile)).title ?? '(제목 없음)'} ${FORK_SUFFIX}`;
      let text = rewriteSessionId(await fs.readFile(bFile, 'utf8'), id, newId);
      if (text.length && !text.endsWith('\n')) text += '\n';
      text += `${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: newId })}\n`;
      const want = createHash('sha256').update(text).digest('hex');
      created.push(nFileTmp);
      await fs.writeFile(nFileTmp, text, { flag: 'wx', mode: st.mode & 0o777 });
      if ((await sha256File(nFileTmp)) !== want) throw new Error('갈라진 사본 검증 실패(jsonl)');
      created.push(nCompTmp);
      if (hadComp) {
        await fs.cp(bComp, nCompTmp, { recursive: true, errorOnExist: true, force: false });
        if (!(await sameTree(bComp, nCompTmp))) throw new Error('갈라진 사본 검증 실패(동반 폴더)');
      } else {
        await fs.mkdir(nCompTmp);
      }
      await fs.writeFile(path.join(nCompTmp, 'custom-title.json'), JSON.stringify({ customTitle: title }));
      created.push(nComp);
      await fs.rename(nCompTmp, nComp);
      created.push(nFile);
      await fs.rename(nFileTmp, nFile);
      fork = { sessionId: newId, title, file: nFile };
    }

    // 3. Set the original aside; it must still be exactly what was backed up.
    touched = true;
    await fs.rename(tFile, stagedFile);
    if (!(await sameFile(stagedFile, bFile))) throw new Error('대상 사본이 백업 중 바뀜');
    if (hadComp) {
      await fs.rename(tComp, stagedComp);
      if (!(await sameTree(stagedComp, bComp))) throw new Error('대상 동반 폴더가 백업 중 바뀜');
    }

    // 4. Retry the move once.
    const r = await move({ sessionId: id, sourceProjectDir: opts.sourceProjectDir, targetProjectsRoot: opts.targetProjectsRoot });
    if (!r.ok) throw new Error(r.error);
    // The set-aside copy goes only if it still is exactly the backup (a writer holding it open may have appended).
    const keptAside: string[] = [];
    if (await sameFile(stagedFile, bFile).catch(() => false)) await fs.rm(stagedFile, { force: true }).catch(() => undefined);
    else if (await exists(stagedFile)) keptAside.push(stagedFile);
    if (hadComp) {
      if (await sameTree(stagedComp, bComp).catch(() => false)) await fs.rm(stagedComp, { recursive: true, force: true }).catch(() => undefined);
      else if (await exists(stagedComp)) keptAside.push(stagedComp);
    }
    return { ok: true, move: r, ...(fork ? { fork } : {}), backupDir, keptAside };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const restored = await restore().catch(() => false);
    return { ok: false, error, restored, backupDir };
  }

  /** Puts the original target copy back and removes what this call created. True = the target is as before. */
  async function restore(): Promise<boolean> {
    let good = true;
    if (!touched) {
      for (const p of created.reverse()) await fs.rm(p, { recursive: true, force: true }).catch(() => undefined);
      return true;
    }
    if (await exists(stagedFile)) {
      if (await exists(tFile)) good = false;
      else await fs.rename(stagedFile, tFile);
    } else if (!(await exists(tFile)) && bFile && (await exists(bFile))) {
      await fs.copyFile(bFile, tFile, FS.COPYFILE_EXCL);
    }
    if (await exists(stagedComp)) {
      if (await exists(tComp)) good = false;
      else await fs.rename(stagedComp, tComp);
    } else if (hadComp && !(await exists(tComp)) && bComp && (await exists(bComp))) {
      await fs.cp(bComp, tComp, { recursive: true, errorOnExist: true, force: false });
    }
    // Restored = the original's bytes are back; appended to since (a writer still holding it) counts too.
    if (bFile && (await exists(bFile))) {
      good = good && (await exists(tFile)) && (await isBytePrefix(bFile, tFile));
      if (hadComp) good = good && (await exists(tComp)) && (await treeContains(bComp, tComp));
    }
    // The fork is ours and the backup holds its bytes; only remove it once the original is back.
    if (good) for (const p of created.reverse()) await fs.rm(p, { recursive: true, force: true }).catch(() => undefined);
    return good;
  }
}
