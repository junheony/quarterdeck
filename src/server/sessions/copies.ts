import fs from 'node:fs/promises';
import path from 'node:path';
import type { Account, ProjectsRoots } from '../../shared/accounts';
import { isAncestor } from './SessionMover';

/** One profile's copy of a session transcript. */
export type SessionCopy = { account: Account; projectDir: string; file: string; size: number; mtimeMs: number };

type Stamped = { file: string; size: number; mtimeMs: number; account?: string };
export type PrefixFn = (prefix: Stamped, full: Stamped) => Promise<boolean>;

/** `prefix` is older than `full`: a byte-prefix of it, possibly plus Claude Desktop's uuid-less metadata lines. */
const ancestorPrefix: PrefixFn = (a, b) => isAncestor(a.file, b.file);

/** The `timestamp` (ms) of a conversation line (one with a `uuid`); null for anything else. */
function conversationAt(line: string): number | null {
  try {
    const o = JSON.parse(line) as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || o.uuid === undefined || typeof o.timestamp !== 'string') return null;
    const t = Date.parse(o.timestamp);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** When the last conversation line of a transcript was written (its `timestamp`); -Infinity = none. Reads from the end. */
export async function lastConversationAt(file: string): Promise<number> {
  const fh = await fs.open(file, 'r');
  try {
    const CHUNK = 1 << 16;
    let end = (await fh.stat()).size;
    // Bytes after the chunk being read, up to the next line break already seen: kept as pieces (newest-last read
    // = earliest in the file) and joined once, so one very long line costs O(length), not O(length²).
    let carry: Buffer[] = [];
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      const chunk = buf.subarray(0, bytesRead);
      end = start;
      // Only lines known to be whole: past the first line break unless this chunk starts the file.
      const cut = start === 0 ? 0 : chunk.indexOf(0x0a) + 1;
      if (start > 0 && cut === 0) { carry.push(chunk); continue; }
      const lines = Buffer.concat([chunk.subarray(cut), ...carry.reverse()]).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = conversationAt(lines[i]!);
        if (t !== null) return t;
      }
      carry = [chunk.subarray(0, cut)];
    }
    return -Infinity;
  } finally {
    await fh.close();
  }
}

/**
 * The copies `claude --resume` would use: in each profile, `<id>.jsonl` in the directory named like
 * `projectDir` (deck copies keep the dir name). The copy at `projectDir` itself comes first. A copy in a
 * differently spelled dir (e.g. an old NFD-era name) is not one resume picks and is ignored.
 */
export async function findCopies(roots: ProjectsRoots, sessionId: string, projectDir: string, account: Account): Promise<SessionCopy[]> {
  const name = path.basename(projectDir);
  const dirs: [Account, string][] = [[account, projectDir], ...roots.map((r): [Account, string] => [r.id, path.join(r.dir, name)])];
  const seen = new Set<string>();
  const out: SessionCopy[] = [];
  for (const [acc, dir] of dirs) {
    const key = path.resolve(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    const file = path.join(dir, `${sessionId}.jsonl`);
    const st = await fs.stat(file).catch(() => null);
    if (st?.isFile()) out.push({ account: acc, projectDir: dir, file, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

/**
 * Which copy wins. Transcripts are append-only, so a copy that is an ancestor of another (a byte-prefix, possibly
 * plus Claude Desktop's metadata lines) is just older: the longest one in a chain wins (on a tie the earlier-listed
 * copy). `heads` are the copies no other copy contains; more than one = truly diverged, and then the copy whose last
 * conversation line has the latest `timestamp` wins — on a tie the one not in `home` (deck's B/C copy has the turns
 * the user sent from deck), then the earlier-listed. Never mtime: Desktop touches its copy without adding turns.
 * The caller tells the user; nothing is overwritten.
 */
export async function resolveCopies<T extends Stamped>(
  copies: T[],
  prefix: PrefixFn = ancestorPrefix,
  opts: { home?: string | null; lastAt?: (file: string) => Promise<number> } = {},
): Promise<{ best: T; heads: T[] } | null> {
  let heads: T[] = [];
  for (const c of copies) {
    let dominated = false;
    for (const h of heads) if (await prefix(c, h)) { dominated = true; break; }
    if (dominated) continue;
    const kept: T[] = [];
    for (const h of heads) if (!(await prefix(h, c))) kept.push(h);
    heads = [...kept, c];
  }
  if (!heads.length) return null;
  if (heads.length === 1) return { best: heads[0]!, heads };
  const lastAt = opts.lastAt ?? lastConversationAt;
  const at = await Promise.all(heads.map((h) => lastAt(h.file).catch(() => -Infinity)));
  const order = heads.map((h, i) => i).sort((i, j) => {
    const x = heads[i]!;
    const y = heads[j]!;
    const byTime = at[j]! - at[i]!;
    if (byTime && !Number.isNaN(byTime)) return byTime;
    const homeX = opts.home != null && x.account === opts.home ? 1 : 0;
    const homeY = opts.home != null && y.account === opts.home ? 1 : 0;
    return homeX - homeY || copies.indexOf(x) - copies.indexOf(y);
  });
  return { best: heads[order[0]!]!, heads };
}
