import { createReadStream, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { SessionEntry } from '../../shared/session-types';
import { elsewhereNotice } from './elsewhereNotice';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);

const ROLLOUT = /^rollout-.*\.jsonl$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bytes read from a rollout's start to find its meta and first prompt (Desktop prepends ~100 KB of context). */
const HEAD_BYTES = 2 * 1024 * 1024;
const UNTITLED = '(제목 없음)';
/** Heads read in parallel on a cold scan (~1200 rollouts at first start). */
const READ_CONCURRENCY = 8;

/** Codex's own thread names, next to the rollout roots: one `{"id","thread_name","updated_at"}` object per line, appended on every rename. */
const THREAD_NAMES_FILE = 'session_index.jsonl';
/** Only the file's end is read (the last line for an id is its current name); a line is ~150 bytes. */
const THREAD_NAMES_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_THREAD_NAME_CHARS = 200;

/** A rollout touched this recently is probably still open in Codex Desktop / CLI. */
export const LIVE_ROLLOUT_MS = 2 * 60 * 1000;

/** Why an imported thread can be viewed but not continued from deck. */
export const CWD_MISSING_NOTICE = '폴더가 없어 이어서 보낼 수 없음';
export const CODEX_ARCHIVED_NOTICE = 'Codex 에서 보관한 대화라 이어서 보낼 수 없음 — Codex 앱에서 보관 해제하면 이어갈 수 있습니다';

/** `exec`: a non-interactive `codex exec` run (tagged 자동 실행). */
export type RolloutHead = { threadId: string; cwd: string; title: string | null; exec?: true };

/** Temp roots deck's e2e harness (tests/e2e) creates its `deck-e2e-*` work dirs under. */
const TMP_ROOTS = [...new Set(['/tmp', '/private/tmp', os.tmpdir(), (() => { try { return realpathSync(os.tmpdir()); } catch { return os.tmpdir(); } })()].map((r) => r.replace(/\/+$/, '')))];
const MAC_TMP = /^(?:\/private)?\/var\/folders\/[^/]+\/[^/]+\/T\/(.*)$/;

/** A thread deck's own e2e tests started (cwd in a temp dir whose top folder is `deck-e2e…`): not the user's, never listed. */
export function isDeckTestCwd(cwd: string): boolean {
  const rest = MAC_TMP.exec(cwd)?.[1] ?? TMP_ROOTS.map((r) => (cwd.startsWith(`${r}/`) ? cwd.slice(r.length + 1) : null)).find((x) => x !== null);
  return rest != null && rest.split('/')[0]!.startsWith('deck-e2e');
}

/** Codex Desktop wraps attachments as `# Files mentioned by the user: … ## My request[ for Codex]:` then the prompt. */
const REQUEST_MARK = /^## My request[^\n]*:[ \t]*$/m;

function titleOf(text: string): string | null {
  const m = REQUEST_MARK.exec(text);
  const t = (m ? text.slice(m.index + m[0].length) : text).trimStart();
  // Injected context (environment, AGENTS.md, plugins, images) — same rule as the transcript reader.
  if (!t || t.startsWith('<') || t.startsWith('# AGENTS.md') || (!m && t.startsWith('# Files mentioned by the user'))) return null;
  const first = t.split('\n').find((l) => l.trim())?.trim() ?? '';
  return first ? first.slice(0, 80) : null;
}

/**
 * Streams the first HEAD_BYTES of a rollout: `session_meta` (thread id, cwd) and the first real user prompt.
 * Null for sub-agent threads (Codex Desktop spawns hundreds; they are not conversations) and unusable files.
 * `codex exec` runs are returned with `exec: true`.
 */
export async function readRolloutHead(file: string, maxBytes = HEAD_BYTES): Promise<RolloutHead | null> {
  const stream = createReadStream(file, { encoding: 'utf8', start: 0, end: maxBytes - 1 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let meta: { threadId: string; cwd: string; exec?: true } | null = null;
  let title: string | null = null;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let r: Rec | null;
      try { r = rec(JSON.parse(line)); } catch { if (!meta) return null; continue; }
      const p = r ? rec(r.payload) : null;
      if (!r || !p) continue;
      if (!meta) {
        if (r.type !== 'session_meta') return null;
        const id = typeof p.id === 'string' ? p.id : null;
        if (!id || !UUID.test(id) || typeof p.cwd !== 'string' || !p.cwd.startsWith('/')) return null;
        if (p.thread_source === 'subagent' || (p.source !== undefined && typeof p.source !== 'string')) return null;
        meta = { threadId: id, cwd: p.cwd, ...(p.source === 'exec' || p.originator === 'codex_exec' ? { exec: true as const } : {}) };
        continue;
      }
      if (r.type === 'response_item' && p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
        for (const b of p.content) {
          const block = rec(b);
          if (block?.type !== 'input_text' || typeof block.text !== 'string') continue;
          title = titleOf(block.text);
          if (title) break;
        }
        if (title) break;
      }
    }
  } catch {
    if (!meta) return null;
  } finally {
    rl.close();
    stream.destroy();
  }
  return meta ? { ...meta, title } : null;
}

/**
 * Thread id → the name Codex shows for it, from the last `maxBytes` of `session_index.jsonl`. The last line for an
 * id wins (an empty name clears it); lines that are not such an object — a half-written last one, the cut first
 * one of a tail read — are skipped. Throws only when the file cannot be read.
 */
export async function readThreadNames(file: string, maxBytes = THREAD_NAMES_TAIL_BYTES): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const fh = await fs.open(file, 'r');
  let text: string;
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    text = buf.subarray(0, bytesRead).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } finally {
    await fh.close();
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: Rec | null;
    try { r = rec(JSON.parse(line)); } catch { continue; }
    if (!r || typeof r.id !== 'string' || !UUID.test(r.id) || typeof r.thread_name !== 'string') continue;
    const name = r.thread_name.replace(/\s+/g, ' ').trim().slice(0, MAX_THREAD_NAME_CHARS);
    if (name) names.set(r.id, name);
    else names.delete(r.id);
  }
  return names;
}

type RolloutFile = { file: string; mtimeMs: number; size: number };

/** The rollout files directly in `dir`, stat'ed in parallel. */
async function rolloutsIn(dir: string): Promise<RolloutFile[]> {
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => ROLLOUT.test(n));
  const stats = await Promise.all(names.map((n) => fs.stat(path.join(dir, n)).catch(() => null)));
  return names.flatMap((n, i) => { const st = stats[i]; return st?.isFile() ? [{ file: path.join(dir, n), mtimeMs: st.mtimeMs, size: st.size }] : []; });
}

/** `sessions/YYYY/MM/DD/rollout-*.jsonl`. */
async function rolloutFiles(root: string): Promise<RolloutFile[]> {
  const subdirs = async (p: string) => (await fs.readdir(p, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name));
  const days: string[] = [];
  for (const y of await subdirs(root)) for (const m of await subdirs(y)) days.push(...(await subdirs(m)));
  return (await Promise.all(days.map(rolloutsIn))).flat();
}

/**
 * Codex Desktop / CLI threads under `~/.codex/sessions` and `~/.codex/archived_sessions` (flat; listed as
 * 보관됨), read-only, as Codex sidebar entries. Every user thread is listed — `codex exec` runs (자동 실행)
 * and threads whose folder is gone (view only) included; sub-agent threads are not (they are not conversations),
 * nor deck's own e2e runs (isDeckTestCwd).
 * A rollout's head never changes once written, so it is read once per file and kept while the file does not
 * shrink; a rescan only stats. A thread is titled with its Codex name (`session_index.jsonl` beside the rollout
 * roots, re-read when its mtime or size changes), else its first prompt. Nothing else under `~/.codex` is ever opened.
 */
export class CodexRolloutIndex {
  private heads = new Map<string, { size: number; head: RolloutHead | null }>();
  private entries: SessionEntry[] = [];
  private byId = new Map<string, SessionEntry>();
  private names = new Map<string, string>();
  private namesStamp = '';
  private running: Promise<void> | null = null;
  private again: Promise<void> | null = null;

  constructor(private readonly root: string, private readonly readHead: typeof readRolloutHead = readRolloutHead, private readonly archivedRoot: string | null = null) {}

  /** Overlapping calls share one scan, plus at most one more after it (a write since may need it). */
  refresh(): Promise<void> {
    if (!this.running) {
      this.running = this.scan().finally(() => { this.running = null; });
      return this.running;
    }
    // A failed scan must not stick: the follow-up runs regardless (as ws.ts' rescanIndex).
    return (this.again ??= this.running.catch(() => {}).then(() => { this.again = null; return this.refresh(); }));
  }

  /** Missing file = no names; a failed read keeps the names of the last good one. */
  private async loadNames(): Promise<void> {
    const file = path.join(path.dirname(this.root), THREAD_NAMES_FILE);
    const st = await fs.stat(file).catch(() => null);
    if (!st?.isFile()) { this.names = new Map(); this.namesStamp = ''; return; }
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (stamp === this.namesStamp) return;
    try {
      this.names = await readThreadNames(file);
      this.namesStamp = stamp;
    } catch { /* retried on the next scan */ }
  }

  private async scan(): Promise<void> {
    await this.loadNames();
    const [live, archived] = await Promise.all([rolloutFiles(this.root), this.archivedRoot ? rolloutsIn(this.archivedRoot) : Promise.resolve([])]);
    const files = [...live.map((f) => ({ ...f, archived: false })), ...archived.map((f) => ({ ...f, archived: true }))];
    // A head without a prompt yet (thread just started), or none at all (first line still half-written), is retried once the file grows.
    const stale = files.filter((f) => {
      const c = this.heads.get(f.file);
      return !c || f.size < c.size || ((!c.head || !c.head.title) && f.size !== c.size);
    });
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, stale.length) }, async () => {
      while (next < stale.length) {
        const f = stale[next++]!;
        this.heads.set(f.file, { size: f.size, head: await this.readHead(f.file, HEAD_BYTES).catch(() => null) });
      }
    }));
    const dirOk = new Map<string, Promise<boolean>>();
    const cwdExists = (cwd: string) => {
      let v = dirOk.get(cwd);
      if (!v) { v = fs.stat(cwd).then((st) => st.isDirectory(), () => false); dirOk.set(cwd, v); }
      return v;
    };
    const byId = new Map<string, SessionEntry>();
    for (const f of files) {
      const h = this.heads.get(f.file)?.head;
      if (!h || isDeckTestCwd(h.cwd)) continue;
      const prev = byId.get(h.threadId);
      if (prev && prev.lastModified >= f.mtimeMs) continue;
      // Threads whose folder is gone (e.g. temp dirs of scripted `codex exec` runs) can be read, not continued.
      const gone = !(await cwdExists(h.cwd));
      byId.set(h.threadId, {
        sessionId: h.threadId, account: 'gpt', engine: 'codex', cwd: h.cwd, projectDir: path.dirname(f.file), file: f.file,
        title: this.names.get(h.threadId) ?? h.title ?? UNTITLED, lastModified: f.mtimeMs, sizeBytes: f.size, imported: true,
        ...(h.exec ? { codexExec: true } : {}),
        ...(f.archived ? { archived: true, codexArchived: true } : {}),
        ...(gone ? { cwdMissing: true } : {}),
      });
    }
    const seen = new Set(files.map((f) => f.file));
    for (const k of this.heads.keys()) if (!seen.has(k)) this.heads.delete(k);
    this.byId = byId;
    this.entries = [...byId.values()];
  }

  list(): SessionEntry[] {
    return this.entries;
  }

  lookup(threadId: string): SessionEntry | null {
    return this.byId.get(threadId) ?? null;
  }

  /** The name Codex shows for the thread (as of the last refresh); null when it has none. */
  threadName(threadId: string): string | null {
    return this.names.get(threadId) ?? null;
  }
}

/** Why deck cannot continue an imported thread (checked live: a folder may come back), or null if it can. */
export async function importBlockReason(e: Pick<SessionEntry, 'cwd' | 'codexArchived'>): Promise<string | null> {
  if (e.codexArchived) return CODEX_ARCHIVED_NOTICE;
  const ok = await fs.stat(e.cwd).then((st) => st.isDirectory(), () => false);
  return ok ? null : `${CWD_MISSING_NOTICE}: ${e.cwd}`;
}

/** How long ago a rollout was written, if within LIVE_ROLLOUT_MS (Codex Desktop / CLI probably has it open); else null. */
export async function rolloutActiveAgeMs(file: string, nowMs = Date.now()): Promise<number | null> {
  const st = await fs.stat(file).catch(() => null);
  return st && nowMs - st.mtimeMs < LIVE_ROLLOUT_MS ? Math.max(0, nowMs - st.mtimeMs) : null;
}

/** Whether a rollout was written within LIVE_ROLLOUT_MS. */
export async function rolloutRecentlyActive(file: string, nowMs = Date.now()): Promise<boolean> {
  return (await rolloutActiveAgeMs(file, nowMs)) !== null;
}

/** The notice for an imported Codex thread written outside deck `ageMs` ago. */
export function liveRolloutNotice(title: string | null, ageMs: number): string {
  return elsewhereNotice({ engine: 'codex', title: title === UNTITLED ? null : title, ageMs });
}
