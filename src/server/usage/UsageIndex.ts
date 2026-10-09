import fs from 'node:fs';
import path from 'node:path';
import type { Account, AccountRoot } from '../../shared/accounts';
import { addDays, CODEX_SOURCE, familyOf, localDay, type ModelFamily, type UsageHistory, type UsageRow, type UsageSource } from '../../shared/token-usage';

/** [input, output, cacheRead, cacheWrite, messages] — compact on disk. */
type Bucket = [number, number, number, number, number];
/** Codex `total_token_usage` seen so far in one rollout: [input incl. cached, cached, cacheWrite, output]. */
type CodexTotal = [number, number, number, number];

type FileState = { source: UsageSource; size: number; ino: number; offset: number; codexTotal?: CodexTotal };

type IndexFile = {
  version: 2;
  lastScanAt: string | null;
  /**
   * Claude accounts that have a dedupe bit: bit 0 is the global total, bit i+1 is `sources[i]`. Append-only —
   * an account that left the configuration keeps its place (and its rows); a new one goes to the end.
   */
  sources: Account[];
  files: Record<string, FileState>;
  /** Bytes of the `.seen` log this file's counts include (anything beyond is from a save that never finished). */
  seenLen?: number;
  /** `${day}|${source|all}|${family}` → counts. */
  buckets: Record<string, Bucket>;
};

/**
 * The v1 index (`usage-index.json` + `.seen`, written before accounts were configurable): bits a=1 b=2 c=4 and
 * GLOBAL=8, each dedupe value `mask + maxOutput * 16`, either as `id\tvalue` lines in the `.seen` log (`seenLen`
 * bytes of it) or, in its first form, inline as `seen`.
 */
type IndexFileV1 = Pick<IndexFile, 'lastScanAt' | 'files' | 'buckets' | 'seenLen'> & { version: 1; seen?: Record<string, number> };
const V1_SOURCES: readonly Account[] = ['a', 'b', 'c'];

/**
 * Format 2. A format gets its own file name (`usage-index-v2.json`), and an older file is only ever read: a build
 * that predates this format finds its own file untouched and carries on from its offsets, instead of dropping an
 * index it cannot read and losing what deleted transcripts had contributed.
 */
const VERSION = 2;
const GLOBAL_BIT = 1;
/**
 * In memory a dedupe value is `mask + maxOutput * MASK_SPAN` (one number per message id; the map holds hundreds of
 * thousands). 24 mask bits keep bit tests in int32 range and leave 2^29 for maxOutput inside the safe-integer range.
 * On disk mask and maxOutput are separate fields, so this width can change without a new format.
 */
const MASK_BITS = 24;
const MASK_SPAN = 2 ** MASK_BITS;
const MAX_OUTPUT = 2 ** (53 - MASK_BITS) - 1;
/** Claude accounts the index can hold, counting those that left the configuration (one bit each, next to GLOBAL). */
export const MAX_USAGE_ACCOUNTS = MASK_BITS - 1;
const SAVE_EVERY_MS = 30_000;
const CHUNK = 1024 * 1024;
const NL = 0x0a;
const CLAUDE_NEEDLE = Buffer.from('"usage"');
const CODEX_NEEDLES = [Buffer.from('"token_count"')];

export type UsageIndexOpts = {
  /** Claude `projects` dir per account (transcripts + `<id>/subagents/*.jsonl`). At most `MAX_USAGE_ACCOUNTS` over the life of the index; one more is logged and left out. */
  projectsRoots: readonly AccountRoot[];
  /** `$CODEX_HOME/sessions` (rollout jsonl files). */
  codexSessionsRoot: string;
  /** Cache file (`~/.config/deck/usage-index-v2.json`); its dedupe log is `<indexFile>.seen`. */
  indexFile: string;
  /** The v1 cache file (`~/.config/deck/usage-index.json`): converted when `indexFile` is missing or unusable, never written. */
  legacyIndexFile?: string;
  intervalMs?: number;
  now?: () => Date;
};

function emptyIndex(): IndexFile {
  return { version: VERSION, lastScanAt: null, sources: [], files: {}, buckets: {} };
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** A sum of counts: past 2^53 it is no longer exact, and still no reason to drop the index. */
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * A token count as a transcript states it, made a whole number in [0, cap]: fractions are floored, anything that
 * is not a positive number is 0. What goes into the index must be something `load` accepts again — a value it
 * rejects is re-read from the same transcript line by the rescan, and the index would be dropped at every start.
 */
function tokenCount(v: unknown, cap: number): number {
  return typeof v === 'number' && v > 0 ? Math.min(Math.floor(v), cap) : 0;
}

/** The content of an index file is not something this code can use (as opposed to: the file could not be read right now). */
class Unusable extends Error {}

function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new Unusable(err instanceof Error ? err.message : String(err));
  }
}

/** A message id with one of these would split its `.seen` line: such a message is left out. */
const ID_BREAKS_LINE = /[\t\n\r]/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Throws (with what is wrong) unless `raw` has the parts v1 and v2 share in a usable shape. */
function checkBody(raw: unknown): asserts raw is Pick<IndexFile, 'lastScanAt' | 'files' | 'buckets' | 'seenLen'> {
  if (!isRecord(raw)) throw new Unusable('객체가 아님');
  if (raw.lastScanAt !== null && typeof raw.lastScanAt !== 'string') throw new Unusable('lastScanAt');
  if (raw.seenLen !== undefined && !isCount(raw.seenLen)) throw new Unusable('seenLen');
  if (!isRecord(raw.files) || !isRecord(raw.buckets)) throw new Unusable('files/buckets 없음');
  for (const [file, f] of Object.entries(raw.files)) {
    const ok = isRecord(f) && typeof f.source === 'string' && isCount(f.size) && typeof f.ino === 'number' && isCount(f.offset)
      && (f.codexTotal === undefined || (Array.isArray(f.codexTotal) && f.codexTotal.length === 4 && f.codexTotal.every(isCount)));
    if (!ok) throw new Unusable(`files 항목: ${file}`);
  }
  for (const [key, b] of Object.entries(raw.buckets)) {
    if (!(Array.isArray(b) && b.length === 5 && b.every(isAmount)) || key.split('|').length !== 3) throw new Unusable(`buckets 항목: ${key}`);
  }
}

/** null when there is no such file. */
async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await fs.promises.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * The lines of the first `len` bytes of a dedupe log, each split at its tabs. Throws when the log is shorter than
 * what the index counted or does not end at a line end there (entries would be missing: messages would count twice).
 */
async function seenFields(file: string, len: number): Promise<{ lines: string[][]; size: number }> {
  const buf = await readIfExists(file);
  if (!buf) {
    if (len > 0) throw new Unusable(`${path.basename(file)} 없음`);
    return { lines: [], size: 0 };
  }
  if (buf.length < len || (len > 0 && buf[len - 1] !== NL)) throw new Unusable(`${path.basename(file)} 가 색인이 센 길이(${len})와 맞지 않음`);
  const text = buf.toString('utf8', 0, len);
  return { lines: len === 0 ? [] : text.slice(0, -1).split('\n').map((l) => l.split('\t')), size: buf.length };
}

const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

/** null when the root can't be listed (missing or unreadable). */
async function walkJsonl(root: string, accept: (rel: string) => boolean): Promise<string[] | null> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(root, { recursive: true });
  } catch {
    return null;
  }
  // `<id>.deck-tmp/` and `<file>.deck-tmp` are SessionMover/SessionFork staging copies: short-lived, and the
  // same bytes are counted under their final name.
  return entries.filter((rel) => rel.endsWith('.jsonl') && !rel.split(path.sep).some((seg) => seg.endsWith('.deck-tmp')) && accept(rel)).map((rel) => path.join(root, rel));
}

/**
 * Token usage history from the transcripts themselves. Each refresh reads only bytes appended since the last
 * one (offsets per file, complete lines only), streaming in 1 MiB chunks and yielding between files, and keeps
 * the aggregates plus offsets in one JSON cache so a restart resumes where it stopped.
 *
 * Claude: assistant lines' `message.usage`, deduped by `message.id` (one message is written as several lines,
 * and copied sessions repeat whole prefixes) — per account within that account, and once more across accounts
 * for the global total. Re-reading a file is therefore harmless. Codex: deltas of each rollout's cumulative
 * `token_count.info.total_token_usage` (repeated events add nothing).
 */
export class UsageIndex {
  private state: IndexFile = emptyIndex();
  private loaded = false;
  private readonly refused = new Set<Account>();
  /** The whole `.seen` log is written anew at the next save (after a migration). */
  private rewriteSeen = false;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSave = 0;
  /**
   * message id → `mask + maxOutput * MASK_SPAN`: mask = GLOBAL once the global total counted it, plus the bit of
   * every account that did (`sources`); maxOutput = the largest output_tokens seen for it (every counted target
   * holds exactly that). Persisted as an append-only log of `id\tmask\tmaxOutput` lines (`<indexFile>.seen`), not
   * inside the JSON that is rewritten on every save.
   */
  private seen = new Map<string, number>();
  private dirtySeen = new Map<string, number>();
  private seenLines = 0;
  /** Bytes of the `.seen` log that are whole lines this instance read or wrote (what `seenLen` is saved as). */
  private seenBytes = 0;
  private oddIdLogged = false;
  private readonly now: () => Date;

  constructor(private readonly opts: UsageIndexOpts) {
    this.now = opts.now ?? (() => new Date());
  }

  get scanning(): boolean {
    return this.running !== null;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.intervalMs ?? 10 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scan at a time; a call during a scan joins it. */
  refresh(): Promise<void> {
    this.running ??= this.scan()
      .catch((err: unknown) => console.error('deck: usage index scan failed', err instanceof Error ? err.message : String(err)))
      .finally(() => { this.running = null; });
    return this.running;
  }

  /** Rows for the last `days` local days (today included). */
  history(days: number): UsageHistory {
    const today = localDay(this.now());
    const from = addDays(today, -(days - 1));
    const rows: UsageRow[] = [];
    for (const [key, b] of Object.entries(this.state.buckets)) {
      const [day, source, family] = key.split('|') as [string, UsageSource | 'all', ModelFamily];
      if (day < from || day > today) continue;
      rows.push({ day, source, family, input: b[0], output: b[1], cacheRead: b[2], cacheWrite: b[3], messages: b[4] });
    }
    rows.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
    return { generatedAt: this.now().toISOString(), days, lastScanAt: this.state.lastScanAt, scanning: this.scanning, sources: [...this.state.sources, CODEX_SOURCE], rows };
  }

  /**
   * Throws when a file could not be read or written just now (EACCES, EMFILE, EIO, …): nothing on disk is changed,
   * this scan fails and the next one loads again. Only content that cannot be used is given up on.
   */
  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      await this.loadFiles();
      this.loaded = true;
    } catch (err) {
      this.forget();
      throw err;
    }
  }

  private forget(): void {
    this.state = emptyIndex();
    this.seen.clear();
    this.dirtySeen.clear();
    this.seenLines = 0;
    this.seenBytes = 0;
    this.rewriteSeen = false;
  }

  private async loadFiles(): Promise<void> {
    /** False when there is no such index or its content is unusable (logged); I/O errors pass through. */
    const attempt = async (file: string, read: () => Promise<boolean>): Promise<boolean> => {
      try {
        return await read();
      } catch (err) {
        if (!(err instanceof Unusable)) throw err;
        console.error(`deck: 사용량 색인 ${file} 을 읽을 수 없어 버립니다 — ${err.message}`);
        this.forget();
        return false;
      }
    };
    const moveAside = async (file: string) => {
      await fs.promises.rename(file, `${file}.bad`).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'ENOENT') throw err; });
    };
    if (await attempt(this.opts.indexFile, () => this.loadCurrent())) return;
    // What was given up on is kept for a look (`.bad`, the previous one overwritten); a dedupe log without its index
    // (a migration that stopped halfway) goes the same way — counts restart, so it must not make messages look seen.
    await moveAside(this.opts.indexFile);
    await moveAside(this.seenFile);
    // An unusable v2 index falls back to the v1 files when they are still there, not straight to an empty index: v1
    // is a consistent snapshot (counts, offsets and dedupe log of one moment), so continuing from it counts everything
    // exactly once — and keeps what since-deleted transcripts contributed, which a full rescan can never do better than.
    const legacy = this.opts.legacyIndexFile;
    if (legacy !== undefined && await attempt(legacy, () => this.loadV1(legacy))) {
      // Written at once (dedupe log, then the index: the index is what makes the migration done). A stop before
      // that leaves no v2 index, and the next start converts the v1 files again.
      this.rewriteSeen = true;
      await this.save();
      console.error(`deck: 사용량 색인을 v1(${legacy}) 에서 v2(${this.opts.indexFile}) 로 옮겼습니다 — 메시지 ${this.seen.size}건, 옛 파일은 그대로 둡니다`);
    }
    // Else nothing usable: every transcript is read again (slow, exact — Claude counts are idempotent by message id).
  }

  private get seenFile(): string {
    return `${this.opts.indexFile}.seen`;
  }

  /** False when there is no index file; throws `Unusable` when there is one this code cannot use. */
  private async loadCurrent(): Promise<boolean> {
    const buf = await readIfExists(this.opts.indexFile);
    if (!buf) return false;
    const raw = parseJson(buf) as { version?: unknown; sources?: unknown } | null;
    if (raw?.version !== VERSION) throw new Unusable(`모르는 형식 버전 ${JSON.stringify(raw?.version)}`);
    checkBody(raw);
    const sources = raw.sources;
    if (!Array.isArray(sources) || sources.length > MAX_USAGE_ACCOUNTS || new Set(sources).size !== sources.length || !sources.every((x) => typeof x === 'string')) throw new Unusable('sources');
    const len = raw.seenLen ?? 0;
    const { lines, size } = await seenFields(this.seenFile, len);
    const maskEnd = 2 ** (sources.length + 1);
    for (const f of lines) {
      const mask = Number(f[1]);
      const max = Number(f[2]);
      if (f.length !== 3 || !f[0] || !isCount(mask) || mask < 1 || mask >= maskEnd || !isCount(max) || max > MAX_OUTPUT) throw new Unusable(`.seen 줄 ${this.seenLines + 1} 을 해석할 수 없음`);
      this.seen.set(f[0], mask + max * MASK_SPAN);
      this.seenLines++;
    }
    // Drop what a crashed save left beyond the counted part, so appends continue from a clean tail.
    if (len < size) await fs.promises.truncate(this.seenFile, len);
    this.seenBytes = len;
    this.state = raw as IndexFile;
    return true;
  }

  /** The v1 index converted in memory (nothing is written here). False when there is no v1 file; throws `Unusable` when it cannot be converted exactly. */
  private async loadV1(file: string): Promise<boolean> {
    const buf = await readIfExists(file);
    if (!buf) return false;
    const raw = parseJson(buf) as IndexFileV1 | null;
    if (raw?.version !== 1) throw new Unusable(`모르는 형식 버전 ${JSON.stringify((raw as { version?: unknown } | null)?.version)}`);
    checkBody(raw);
    const entries: [string, unknown][] = isRecord(raw.seen)
      ? Object.entries(raw.seen)
      : (await seenFields(`${file}.seen`, raw.seenLen ?? 0)).lines.map((f, i) => {
        if (f.length !== 2 || !f[0] || !/^\d+$/.test(f[1]!)) throw new Unusable(`.seen 줄 ${i + 1} 을 해석할 수 없음`);
        return [f[0], Number(f[1])];
      });
    for (const [id, v] of entries) {
      // v1: a=1 b=2 c=4 GLOBAL=8, value = mask + maxOutput * 16. Every entry was counted somewhere, so mask 0 is not v1.
      if (!isCount(v) || v % 16 === 0 || ID_BREAKS_LINE.test(id)) throw new Unusable(`메시지 ${JSON.stringify(id)} 의 값 ${String(v)} 을 해석할 수 없음`);
      const max = Math.floor(v / 16);
      if (max > MAX_OUTPUT) throw new Unusable(`메시지 ${id} 의 값 ${v} 이 너무 큼`);
      // `v & 8` and `v & 7` look at the low four bits only (ToInt32 keeps them), so they are right for v beyond 2^32 too.
      this.seen.set(id, (v & 8 ? GLOBAL_BIT : 0) + ((v & 7) << 1) + max * MASK_SPAN);
    }
    this.state = { version: VERSION, lastScanAt: raw.lastScanAt, sources: [...V1_SOURCES], files: raw.files, buckets: raw.buckets };
    return true;
  }

  private async save(): Promise<void> {
    this.lastSave = Date.now();
    await fs.promises.mkdir(path.dirname(this.opts.indexFile), { recursive: true, mode: 0o700 });
    const lines = (m: Map<string, number>) => [...m].map(([id, v]) => `${id}\t${v % MASK_SPAN}\t${Math.floor(v / MASK_SPAN)}\n`).join('');
    // The dedupe log first: a crash between the two leaves it ahead of the counts, never behind.
    if (this.rewriteSeen || this.seenLines > 2 * this.seen.size + 10_000) {
      const all = lines(this.seen);
      await fs.promises.writeFile(`${this.seenFile}.tmp`, all, { mode: 0o600 });
      // Known window: a stop between this rename and the index rename below leaves an index whose `seenLen` belongs
      // to the log that was just replaced; the next start finds they do not fit, gives the index up and rescans
      // (what deleted transcripts contributed is lost; nothing is missed or counted twice). A generation number
      // shared by the two files would close it.
      await fs.promises.rename(`${this.seenFile}.tmp`, this.seenFile);
      this.seenBytes = Buffer.byteLength(all);
      this.rewriteSeen = false;
      this.dirtySeen.clear();
      this.seenLines = this.seen.size;
    } else if (this.dirtySeen.size) {
      const add = lines(this.dirtySeen);
      const fh = await fs.promises.open(this.seenFile, 'a', 0o600);
      try {
        // An append that failed halfway (ENOSPC, EIO) left a piece of a line behind: cut back to what is known whole,
        // or this append would continue that piece and the log would not parse at the next start.
        await fh.truncate(this.seenBytes);
        await fh.appendFile(add);
      } finally {
        await fh.close();
      }
      this.seenBytes += Buffer.byteLength(add);
      this.seenLines += this.dirtySeen.size;
      this.dirtySeen.clear();
    }
    this.state.seenLen = this.seenBytes;
    const tmp = `${this.opts.indexFile}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 });
    await fs.promises.rename(tmp, this.opts.indexFile);
  }

  private async scan(): Promise<void> {
    await this.load();
    const sources = this.state.sources;
    const accounts = this.opts.projectsRoots.filter(({ id: a }) => {
      if (sources.includes(a)) return true;
      if (sources.length < MAX_USAGE_ACCOUNTS) { sources.push(a); return true; }
      // No bit left: counting it under another account's bit would be wrong, so it is left out, loudly.
      if (!this.refused.has(a)) {
        this.refused.add(a);
        console.error(`deck: 사용량 색인에 계정 자리가 없습니다(최대 ${MAX_USAGE_ACCOUNTS}개, 설정에서 뺀 계정 포함) — 계정 ${a} 의 사용량은 세지 않습니다`);
      }
      return false;
    });
    const targets: { file: string; source: UsageSource }[] = [];
    const unlisted: string[] = [];
    const roots: { root: string; source: UsageSource; accept: (rel: string) => boolean }[] = [
      // Transcripts and subagent transcripts; tool-result dumps and other sidecars are not jsonl.
      ...accounts.map((r) => ({ root: r.dir, source: r.id, accept: () => true })),
      { root: this.opts.codexSessionsRoot, source: CODEX_SOURCE, accept: (rel) => path.basename(rel).startsWith('rollout-') },
    ];
    for (const { root, source, accept } of roots) {
      const files = await walkJsonl(root, accept);
      if (!files) { unlisted.push(root + path.sep); continue; }
      for (const file of files) targets.push({ file, source });
    }

    let changed = false;
    const live = new Set<string>();
    for (const { file, source } of targets) {
      live.add(file);
      try {
        if (await this.scanFile(file, source)) changed = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // Gone between the listing and the read (a move or fork finished): a deleted file, not a failure.
          live.delete(file);
          delete this.state.files[file];
          continue;
        }
        console.error('deck: usage index read failed', file, err instanceof Error ? err.message : String(err));
      }
      await yieldLoop();
      if (changed && Date.now() - this.lastSave > SAVE_EVERY_MS) await this.save();
    }
    // Deleted files: drop their offsets; what they contributed stays (that usage happened). A root that could
    // not be listed this time keeps its offsets, so a transient error never causes a Codex re-count.
    for (const f of Object.keys(this.state.files)) {
      if (!live.has(f) && !unlisted.some((r) => f.startsWith(r))) delete this.state.files[f];
    }
    this.state.lastScanAt = this.now().toISOString();
    await this.save();
  }

  /** True when anything was read. */
  private async scanFile(file: string, source: UsageSource): Promise<boolean> {
    const st = await fs.promises.stat(file);
    let fs0 = this.state.files[file];
    if (fs0 && fs0.source === source && fs0.ino === st.ino && st.size === fs0.offset) return false;
    if (!fs0 || fs0.source !== source || fs0.ino !== st.ino || st.size < fs0.offset) {
      // New, replaced or truncated: read from the start (Claude: idempotent; Codex: baseline restarts).
      fs0 = { source, size: st.size, ino: st.ino, offset: 0, ...(source === CODEX_SOURCE ? { codexTotal: [0, 0, 0, 0] as CodexTotal } : {}) };
      this.state.files[file] = fs0;
    }
    if (st.size <= fs0.offset) return false;
    const state = fs0;
    // Every Claude account being scanned has a place in `sources` (scan() put it there).
    const bit = 2 << this.state.sources.indexOf(source);
    const onLine = source === CODEX_SOURCE ? (line: Buffer) => this.codexLine(line, state) : (line: Buffer) => this.claudeLine(line, source, bit);
    await readLines(file, state.offset, st.size, (line, endOffset) => {
      onLine(line);
      state.offset = endOffset;
    });
    state.size = st.size;
    return true;
  }

  private add(day: string, source: UsageSource | 'all', family: ModelFamily, c: Bucket): void {
    const key = `${day}|${source}|${family}`;
    const b = (this.state.buckets[key] ??= [0, 0, 0, 0, 0]);
    for (let i = 0; i < 5; i++) b[i]! += c[i]!;
  }

  private claudeLine(line: Buffer, account: Account, bit: number): void {
    if (!line.includes(CLAUDE_NEEDLE)) return;
    let o: { type?: unknown; timestamp?: unknown; requestId?: unknown; uuid?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } };
    try { o = JSON.parse(line.toString('utf8')) as typeof o; } catch { return; }
    const m = o?.message;
    const u = m?.usage;
    if (o.type !== 'assistant' || !u || typeof u !== 'object' || m.model === '<synthetic>') return;
    const id = typeof m.id === 'string' ? m.id : typeof o.requestId === 'string' ? o.requestId : typeof o.uuid === 'string' ? o.uuid : null;
    const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (!id || Number.isNaN(t)) return;
    if (ID_BREAKS_LINE.test(id)) {
      if (!this.oddIdLogged) {
        this.oddIdLogged = true;
        console.error(`deck: 사용량 집계에서 뺍니다 — 탭·줄바꿈이 든 메시지 id ${JSON.stringify(id.slice(0, 80))} (같은 종류는 더 알리지 않습니다)`);
      }
      return;
    }
    // One message's counts, each within MAX_OUTPUT (the dedupe value has that much room for output_tokens).
    const n = (k: string) => tokenCount(u[k], MAX_OUTPUT);
    const c: Bucket = [n('input_tokens'), n('output_tokens'), n('cache_read_input_tokens'), n('cache_creation_input_tokens'), 1];
    if (c[0] + c[1] + c[2] + c[3] === 0) return;
    const prev = this.seen.get(id) ?? 0;
    const mask = prev % MASK_SPAN;
    const maxOut = Math.floor(prev / MASK_SPAN);
    const newMax = Math.max(maxOut, c[1]);
    if (mask & bit && newMax === maxOut) return;
    const day = localDay(new Date(t));
    const family = familyOf(typeof m.model === 'string' ? m.model : null);
    // A later line of the same message can carry a larger output_tokens: top up every target that counted it.
    const full: Bucket = [c[0], newMax, c[2], c[3], 1];
    if (!(mask & bit)) this.add(day, account, family, full);
    if (!(mask & GLOBAL_BIT)) this.add(day, 'all', family, full);
    if (newMax > maxOut && mask) {
      const top: Bucket = [0, newMax - maxOut, 0, 0, 0];
      this.state.sources.forEach((a, i) => { if (mask & (2 << i)) this.add(day, a, family, top); });
      if (mask & GLOBAL_BIT) this.add(day, 'all', family, top);
    }
    const next = (mask | bit | GLOBAL_BIT) + newMax * MASK_SPAN;
    this.seen.set(id, next);
    this.dirtySeen.set(id, next);
  }

  private codexLine(line: Buffer, state: FileState): void {
    if (!CODEX_NEEDLES.some((nd) => line.includes(nd))) return;
    let o: { type?: unknown; timestamp?: unknown; payload?: { type?: unknown; info?: { total_token_usage?: Record<string, unknown>; last_token_usage?: Record<string, unknown> } | null } };
    try { o = JSON.parse(line.toString('utf8')) as typeof o; } catch { return; }
    const p = o?.payload;
    if (o.type !== 'event_msg' || p?.type !== 'token_count' || !p.info?.total_token_usage) return;
    const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (Number.isNaN(t)) return;
    const vec = (u: Record<string, unknown> | undefined): CodexTotal => {
      // Cumulative per rollout, so only the safe-integer range bounds it.
      const n = (k: string) => tokenCount(u?.[k], Number.MAX_SAFE_INTEGER);
      return [n('input_tokens'), n('cached_input_tokens'), n('cache_write_input_tokens'), n('output_tokens')];
    };
    const total = vec(p.info.total_token_usage);
    const prev = state.codexTotal ?? [0, 0, 0, 0];
    // A cumulative counter that went backwards (compaction/reset): this event's own usage is the delta.
    const d: CodexTotal = total.some((v, i) => v < prev[i]!) ? vec(p.info.last_token_usage) : (total.map((v, i) => v - prev[i]!) as CodexTotal);
    state.codexTotal = total;
    if (d[0] + d[2] + d[3] === 0) return;
    // Codex input includes its cached share; report them apart like Anthropic usage.
    this.add(localDay(new Date(t)), CODEX_SOURCE, 'gpt', [Math.max(0, d[0] - d[1]), d[3], d[1], d[2], 1]);
    this.add(localDay(new Date(t)), 'all', 'gpt', [Math.max(0, d[0] - d[1]), d[3], d[1], d[2], 1]);
  }
}

/**
 * Streams [start, end) and calls `onLine(line, offsetAfterLine)` for every complete (newline-terminated) line;
 * a trailing partial line is left for the next read.
 */
async function readLines(file: string, start: number, end: number, onLine: (line: Buffer, endOffset: number) => void): Promise<void> {
  const stream = fs.createReadStream(file, { start, end: end - 1, highWaterMark: CHUNK });
  let parts: Buffer[] = [];
  let pos = start; // file offset of the first byte of `parts`
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let from = 0;
    for (let nl = chunk.indexOf(NL); nl !== -1; nl = chunk.indexOf(NL, from)) {
      const piece = chunk.subarray(from, nl);
      const line = parts.length ? Buffer.concat([...parts, piece]) : piece;
      pos += line.length + 1;
      parts = [];
      onLine(line, pos);
      from = nl + 1;
    }
    if (from < chunk.length) parts.push(chunk.subarray(from));
  }
}
