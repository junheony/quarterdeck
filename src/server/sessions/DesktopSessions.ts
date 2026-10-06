import fs from 'node:fs/promises';
import path from 'node:path';
import type { DesktopSession, SessionEntry } from '../../shared/session-types';
import { pathKey } from './slug';

/** How many Desktop sessions the sidebar shows. */
export const DESKTOP_RECENT = 8;
/** Metadata files read per scan at most (newest file mtime first) — the store holds hundreds. */
const MAX_READS = 80;
/** A metadata file larger than this is not a session record; skipped unread. */
const MAX_META_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Only Desktop's per-session records are opened — never any other file in the app's support dir. */
const META_FILE = /^local_[0-9a-f-]{36}\.json$/i;

export type DesktopMeta = { cliSessionId: string; title: string | null; cwd: string | null; activityMs: number };

/**
 * Claude Desktop's Code tab keeps one JSON record per session at
 * `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_<id>.json`
 * (title, cwd, `cliSessionId`, `lastActivityAt`, `isArchived`). The transcript itself is a normal
 * CLI jsonl in the A profile's projects dir, which SessionIndex already scans — so this source is
 * read-only metadata used to pick and title the sessions; opening/continuing goes through the index.
 */
async function listMetaFiles(root: string): Promise<{ file: string; mtimeMs: number }[]> {
  const out: { file: string; mtimeMs: number }[] = [];
  const subdirs = async (d: string) => (await fs.readdir(d, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name));
  for (const accountDir of await subdirs(root)) {
    for (const orgDir of await subdirs(accountDir)) {
      for (const e of await fs.readdir(orgDir, { withFileTypes: true }).catch(() => [])) {
        if (!e.isFile() || !META_FILE.test(e.name)) continue;
        const file = path.join(orgDir, e.name);
        const st = await fs.stat(file).catch(() => null);
        if (st && st.size <= MAX_META_BYTES) out.push({ file, mtimeMs: st.mtimeMs });
      }
    }
  }
  return out.sort((x, y) => y.mtimeMs - x.mtimeMs);
}

/** The few fields deck uses; null for archived, malformed or id-less records. */
export async function readDesktopMeta(file: string, mtimeMs: number): Promise<DesktopMeta | null> {
  let r: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    r = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (r.isArchived === true || typeof r.cliSessionId !== 'string' || !UUID.test(r.cliSessionId)) return null;
  const activity = typeof r.lastActivityAt === 'number' && Number.isFinite(r.lastActivityAt) ? r.lastActivityAt : mtimeMs;
  return {
    cliSessionId: r.cliSessionId,
    title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : null,
    cwd: typeof r.cwd === 'string' && r.cwd.startsWith('/') ? r.cwd : null,
    activityMs: activity,
  };
}

/**
 * The `limit` most recently active Desktop sessions whose transcript deck can open (`lookup` finds it
 * in the index, on whichever account it lives now). Missing store → [].
 */
export async function recentDesktopSessions(root: string, lookup: (sessionId: string) => SessionEntry | null, limit = DESKTOP_RECENT): Promise<DesktopSession[]> {
  const files = (await listMetaFiles(root)).slice(0, MAX_READS);
  const seen = new Set<string>();
  const out: DesktopSession[] = [];
  for (const { file, mtimeMs } of files) {
    const meta = await readDesktopMeta(file, mtimeMs);
    if (!meta || seen.has(meta.cliSessionId)) continue;
    const entry = lookup(meta.cliSessionId);
    if (!entry || entry.engine === 'codex') continue;
    seen.add(meta.cliSessionId);
    const cwd = entry.cwd || meta.cwd || '';
    out.push({
      sessionId: entry.sessionId,
      account: entry.account,
      title: meta.title ?? entry.title,
      cwd,
      project: path.basename(pathKey(cwd)),
      lastModified: Math.max(meta.activityMs, entry.lastModified),
    });
  }
  return out.sort((x, y) => y.lastModified - x.lastModified).slice(0, limit);
}
