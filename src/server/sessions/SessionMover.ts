import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type MoveResult =
  | { ok: true; targetDir: string; targetFile: string; copied: string[] }
  | { ok: false; error: string; diverged?: true };

export async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** sha256 of the first `n` bytes of `file`. */
export async function sha256Prefix(file: string, n: number): Promise<string> {
  const h = createHash('sha256');
  if (n <= 0) return h.digest('hex');
  return new Promise((resolve, reject) => {
    createReadStream(file, { start: 0, end: n - 1 }).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Relative paths of every regular file under `dir`. */
export async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(path.relative(dir, path.join(e.parentPath, e.name)));
  }
  return out;
}

/** End of the last complete line within the first `size` bytes (0 = none). */
async function lastLineEnd(file: string, size: number): Promise<number> {
  const fh = await fs.open(file, 'r');
  try {
    const CHUNK = 1 << 16;
    const buf = Buffer.alloc(CHUNK);
    for (let end = size; end > 0; end -= CHUNK) {
      const start = Math.max(0, end - CHUNK);
      const { bytesRead } = await fh.read(buf, 0, end - start, start);
      const i = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (i >= 0) return start + i + 1;
    }
    return 0;
  } finally {
    await fh.close();
  }
}

/** Copies exactly the first `n` bytes of `src` to `dst`; returns the sha256 of the bytes written. */
async function copyPrefix(src: string, dst: string, n: number): Promise<string> {
  const h = createHash('sha256');
  if (n > 0) {
    const hashing = new Transform({ transform(chunk: Buffer, _enc, cb) { h.update(chunk); cb(null, chunk); } });
    await pipeline(createReadStream(src, { start: 0, end: n - 1 }), hashing, createWriteStream(dst));
  } else {
    await fs.writeFile(dst, '');
  }
  return h.digest('hex');
}

export type Snapshot = { size: number; hash: string };

/**
 * Snapshot copy of a file another process may still be appending to (the live CLI, Claude Desktop):
 * take its size N now, copy exactly the first N bytes (a `.jsonl` is cut back to its last complete line),
 * and accept only when the copy and the source's first N bytes hash the same — an append during the
 * copy is fine, a rewrite is not. Retried a few times; null = it kept changing under us.
 * Any other file must also keep its size (it is not append-only).
 */
export async function snapshotCopy(src: string, dst: string, attempts = 3): Promise<Snapshot | null> {
  const lines = src.endsWith('.jsonl');
  for (let i = 0; i < attempts; i++) {
    const size = (await fs.stat(src)).size;
    const n = lines ? await lastLineEnd(src, size) : size;
    // Bytes but no complete line yet: nothing safe to take this round.
    if (n === 0 && size > 0) continue;
    const hash = await copyPrefix(src, dst, n);
    const copied = (await fs.stat(dst)).size === n && (await sha256File(dst)) === hash;
    if (copied && (await sha256Prefix(src, n)) === hash && (lines || (await fs.stat(src)).size === size)) return { size: n, hash };
  }
  return null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

type FileStamp = { size: number; mtimeMs: number; hash: string };

/** Size, mtime and sha256 of a file; null when it does not exist. */
async function fileStamp(file: string): Promise<FileStamp | null> {
  const st = await fs.stat(file).catch(() => null);
  if (!st) return null;
  return { size: st.size, mtimeMs: st.mtimeMs, hash: await sha256File(file) };
}

function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  return a === b || (!!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.hash === b.hash);
}

/** True when every byte of `prefixFile` equals the start of `fullFile`. */
export async function isBytePrefix(prefixFile: string, fullFile: string): Promise<boolean> {
  const [a, b] = await Promise.all([fs.open(prefixFile, 'r'), fs.open(fullFile, 'r')]);
  try {
    const [sa, sb] = await Promise.all([a.stat(), b.stat()]);
    if (sa.size > sb.size) return false;
    const CHUNK = 1 << 20;
    const ba = Buffer.alloc(CHUNK);
    const bb = Buffer.alloc(CHUNK);
    for (let pos = 0; pos < sa.size; pos += CHUNK) {
      const n = Math.min(CHUNK, sa.size - pos);
      const [ra, rb] = await Promise.all([a.read(ba, 0, n, pos), b.read(bb, 0, n, pos)]);
      if (ra.bytesRead !== n || rb.bytesRead !== n || !ba.subarray(0, n).equals(bb.subarray(0, n))) return false;
    }
    return true;
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
}

/**
 * A transcript line that is not a conversation entry: a JSON object without a `uuid` (Claude Desktop appends such
 * metadata, e.g. `artifact-autoreact-ledger`, to a session it has open) or a line that does not parse at all.
 */
export function isMetaLine(line: string): boolean {
  // Without the key text there is no uuid field (whether or not the line parses): no need to parse it.
  if (!line.includes('"uuid"')) return true;
  try {
    const o: unknown = JSON.parse(line);
    return !o || typeof o !== 'object' || Array.isArray(o) || (o as Record<string, unknown>).uuid === undefined;
  } catch {
    return true;
  }
}

/** Length of the common byte prefix of two files. */
async function commonPrefixLength(a: string, b: string): Promise<number> {
  const [fa, fb] = await Promise.all([fs.open(a, 'r'), fs.open(b, 'r')]);
  try {
    const [sa, sb] = await Promise.all([fa.stat(), fb.stat()]);
    const max = Math.min(sa.size, sb.size);
    const CHUNK = 1 << 20;
    const ba = Buffer.alloc(CHUNK);
    const bb = Buffer.alloc(CHUNK);
    for (let pos = 0; pos < max; pos += CHUNK) {
      const n = Math.min(CHUNK, max - pos);
      const [ra, rb] = await Promise.all([fa.read(ba, 0, n, pos), fb.read(bb, 0, n, pos)]);
      const m = Math.min(ra.bytesRead, rb.bytesRead);
      for (let i = 0; i < m; i++) if (ba[i] !== bb[i]) return pos + i;
      if (m < n) return pos + m;
    }
    return max;
  } finally {
    await Promise.all([fa.close(), fb.close()]);
  }
}

/** A line worth keeping on write-back: a JSON object without a `uuid` (an unparsable line is not propagated). */
function isPropagatableMeta(line: string): boolean {
  try {
    const o: unknown = JSON.parse(line);
    return !!o && typeof o === 'object' && !Array.isArray(o) && (o as Record<string, unknown>).uuid === undefined;
  } catch {
    return false;
  }
}

/**
 * Whether transcript `x` is an ancestor of transcript `y`: x = (a common prefix ending at a line break) + tail,
 * where every tail line is complete (newline-terminated) and a metadata line (`isMetaLine`). Null = not an
 * ancestor: x has a conversation line of its own (diverged), or an unterminated last line past the common prefix
 * (a writer mid-line — it may be a turn; decide later). Otherwise the tail lines to keep on write-back: JSON objects
 * without a `uuid` (unparsable lines count as metadata for the decision but are not returned). An empty result is
 * also what a plain byte-prefix gives. Streams x's tail and stops at the first conversation line.
 */
export async function ancestorTail(x: string, y: string): Promise<string[] | null> {
  const n = await commonPrefixLength(x, y);
  const size = (await fs.stat(x)).size;
  if (n >= size) return [];
  const start = await lastLineEnd(x, n);
  const keep: string[] = [];
  let carry: Buffer[] = [];
  for await (const chunk of createReadStream(x, { start, end: size - 1 }) as AsyncIterable<Buffer>) {
    let from = 0;
    for (let i = chunk.indexOf(0x0a); i >= 0; i = chunk.indexOf(0x0a, from)) {
      const piece = chunk.subarray(from, i);
      const line = (carry.length ? Buffer.concat([...carry, piece]) : piece).toString('utf8');
      carry = [];
      from = i + 1;
      if (!line) continue;
      if (!isMetaLine(line)) return null;
      if (isPropagatableMeta(line)) keep.push(line);
    }
    if (from < chunk.length) carry.push(chunk.subarray(from));
  }
  // Bytes after the last line break: an unfinished line is never taken for metadata.
  return carry.length ? null : keep;
}

/** `ancestorTail(x, y) !== null`. */
export async function isAncestor(x: string, y: string): Promise<boolean> {
  return (await ancestorTail(x, y)) !== null;
}

/** Project dirs under `projectsRoot` (other than `targetDir`) that already hold `<id>.jsonl`. */
async function findDuplicates(projectsRoot: string, sessionId: string, targetDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(projectsRoot);
  } catch {
    return [];
  }
  const targetStat = await fs.stat(targetDir).catch(() => null);
  const out: string[] = [];
  for (const name of names) {
    const dir = path.join(projectsRoot, name);
    if (!(await exists(path.join(dir, `${sessionId}.jsonl`)))) continue;
    const st = await fs.stat(dir);
    // Compare by inode: on APFS an NFC/NFD spelling of the same name is the same directory.
    if (targetStat && st.dev === targetStat.dev && st.ino === targetStat.ino) continue;
    out.push(name);
  }
  return out;
}

/**
 * Spec §7/§8: copy a session (jsonl + `<id>/` companions) into another profile's
 * projects root under the same directory name, verify, and never write the source.
 * `ignoreOtherDirs`: skip the M12 check — for the home write-back, which only refreshes the
 * same-named copy and leaves a stale copy in a differently spelled dir untouched.
 */
export function moveSession(opts: MoveOptions): Promise<MoveResult> {
  // One move per target at a time: concurrent ones would share the staging names and race the commit renames.
  const key = path.resolve(opts.targetProjectsRoot, path.basename(opts.sourceProjectDir), `${opts.sessionId}.jsonl`);
  const run = (movesByTarget.get(key) ?? Promise.resolve()).then(() => moveOnce(opts));
  const tail = run.then(() => undefined, () => undefined);
  movesByTarget.set(key, tail);
  void tail.then(() => { if (movesByTarget.get(key) === tail) movesByTarget.delete(key); });
  return run;
}

type MoveOptions = { sessionId: string; sourceProjectDir: string; targetProjectsRoot: string; ignoreOtherDirs?: boolean };
const movesByTarget = new Map<string, Promise<void>>();

async function moveOnce(opts: MoveOptions): Promise<MoveResult> {
  const { sessionId } = opts;
  const srcFile = path.join(opts.sourceProjectDir, `${sessionId}.jsonl`);
  const srcDir = path.join(opts.sourceProjectDir, sessionId);
  const targetDir = path.join(opts.targetProjectsRoot, path.basename(opts.sourceProjectDir));
  const targetFile = path.join(targetDir, `${sessionId}.jsonl`);
  const tmpFile = `${targetFile}.deck-tmp`;
  const tmpDir = path.join(targetDir, `${sessionId}.deck-tmp`);

  if (path.resolve(targetDir) === path.resolve(opts.sourceProjectDir)) {
    return (await exists(srcFile)) ? { ok: true, targetDir, targetFile, copied: [] } : { ok: false, error: `원본 없음: ${srcFile}` };
  }

  const finalDir = path.join(targetDir, sessionId);
  const bakDir = path.join(targetDir, `${sessionId}.deck-bak-${Date.now()}`);
  let movedOld = false;
  let installedNew = false;
  let committed = false;
  let diverged = false;
  try {
    await fs.stat(srcFile);

    // M12: the same id in another directory of this profile — which one resume picks is unverified.
    const dups = opts.ignoreOtherDirs ? [] : await findDuplicates(opts.targetProjectsRoot, sessionId, targetDir);
    if (dups.length) throw new Error(`대상 프로필의 다른 디렉터리에 같은 세션이 있음: ${dups.join(', ')}`);

    await fs.mkdir(targetDir, { recursive: true });
    const copied: string[] = [`${sessionId}.jsonl`];

    // Stage 1: jsonl — a snapshot of its first N bytes (the live CLI / Desktop may still be appending).
    await fs.rm(tmpFile, { force: true });
    const snap = await snapshotCopy(srcFile, tmpFile);
    if (!snap) throw new Error('복사본 검증 실패(jsonl 해시 불일치)');

    // Sessions are append-only: an older copy is a byte-prefix of the snapshot — or that plus metadata lines Claude
    // Desktop appended (no conversation of its own). Anything else diverged. The metadata is kept: appended to the
    // staged copy (lines the snapshot already has are not repeated), and the target must not change before the commit.
    // The target as it is now (absent = null); the decision is made on these bytes and they must still be there at
    // the commit — a writer (Desktop) appending meanwhile aborts this round instead of losing its line.
    const targetBefore = await fileStamp(targetFile);
    if (targetBefore) {
      const tail = await ancestorTail(targetFile, tmpFile);
      if ((await fileStamp(targetFile))?.hash !== targetBefore.hash) throw new Error('대상 사본이 복사 중 바뀜');
      if (!tail) {
        diverged = true;
        throw new Error('대상 세션이 따로 진행됨(원본의 앞부분이 아님) — 덮어쓰지 않음');
      }
      if (tail.length) {
        const body = await fs.readFile(tmpFile);
        const have = new Set(body.toString('utf8').split('\n'));
        const extra = tail.filter((l) => !have.has(l));
        if (extra.length) {
          if (createHash('sha256').update(body).digest('hex') !== snap.hash) throw new Error('복사본 검증 실패(jsonl 해시 불일치)');
          const out = Buffer.concat([body, Buffer.from(`${extra.join('\n')}\n`)]);
          await fs.writeFile(tmpFile, out);
          if ((await sha256File(tmpFile)) !== createHash('sha256').update(out).digest('hex')) throw new Error('복사본 검증 실패(메타데이터 덧붙이기)');
        }
      }
    }

    // Stage 2: companions, each a snapshot (source wins; files only on the target are merged in so nothing
    // is lost). A file that keeps changing is skipped this round — the target keeps its version if any.
    const hasCompanions = await exists(srcDir);
    let conflict = false;
    if (hasCompanions) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.mkdir(tmpDir, { recursive: true });
      const staged = new Set<string>();
      for (const rel of await listTree(srcDir)) {
        const dst = path.join(tmpDir, rel);
        await fs.mkdir(path.dirname(dst), { recursive: true });
        if (await snapshotCopy(path.join(srcDir, rel), dst)) staged.add(rel);
        else await fs.rm(dst, { force: true });
      }
      if (await exists(finalDir)) {
        for (const rel of await listTree(finalDir)) {
          const old = path.join(finalDir, rel);
          if (!staged.has(rel)) {
            await fs.mkdir(path.dirname(path.join(tmpDir, rel)), { recursive: true });
            await fs.copyFile(old, path.join(tmpDir, rel));
          } else if (!(await isBytePrefix(old, path.join(tmpDir, rel)))) {
            // An appended file (a growing subagent transcript) is not a conflict; a rewritten one is.
            conflict = true;
          }
        }
      }
      copied.push(`${sessionId}/`);
    }

    // Everything staged and verified; the source's first N bytes must still be the snapshot we copied.
    if ((await sha256Prefix(srcFile, snap.size)) !== snap.hash) throw new Error('원본이 복사 중 바뀜');
    if (!sameStamp(await fileStamp(targetFile), targetBefore)) throw new Error('대상 사본이 복사 중 바뀜');

    // Commit: companions first, jsonl LAST (the final rename is the commit point).
    if (hasCompanions) {
      if (await exists(finalDir)) {
        await fs.rename(finalDir, bakDir);
        movedOld = true;
      }
      await fs.rename(tmpDir, finalDir);
      installedNew = true;
    }
    await fs.rename(tmpFile, targetFile);
    committed = true;

    // The old companion dir is only dropped when every file in it survives unchanged in the new one.
    if (movedOld && !conflict) await fs.rm(bakDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: true, targetDir, targetFile, copied };
  } catch (err) {
    if (!committed) {
      if (installedNew) await fs.rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
      if (movedOld) await fs.rename(bakDir, finalDir).catch(() => undefined);
    }
    await fs.rm(tmpFile, { force: true }).catch(() => undefined);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: err instanceof Error ? err.message : String(err), ...(diverged ? { diverged: true as const } : {}) };
  }
}
