import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { TranscriptMessage } from '../../shared/session-types';
import { contextUsageOf } from '../../shared/turn-types';
import { redactSecrets } from '../engine/redact';

export type HeadInfo = { cwd: string | null; title: string | null };

type Rec = Record<string, unknown>;

function parseLines(text: string): Rec[] {
  const out: Rec[] = [];
  for (const line of text.split('\n')) {
    const r = parseLine(line);
    if (r) out.push(r);
  }
  return out;
}

export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const block = b as Rec;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[이미지]');
    else if (block.type === 'document') parts.push('[문서]');
  }
  return parts.join('\n');
}

const hasToolResult = (content: unknown) => Array.isArray(content) && content.some((b) => b && typeof b === 'object' && (b as Rec).type === 'tool_result');

function message(r: Rec): Rec | null {
  const m = r.message;
  return m && typeof m === 'object' ? (m as Rec) : null;
}

const originKind = (r: Rec): string | null => {
  const o = r.origin;
  return o && typeof o === 'object' && typeof (o as Rec).kind === 'string' ? ((o as Rec).kind as string) : null;
};

/** A user record the person (or deck) sent: not a compact summary, a subagent's, harness-injected (`isMeta`) or a task notification. */
function isRealUser(r: Rec): boolean {
  return r.type === 'user' && !r.isCompactSummary && !r.isSidechain && !r.isMeta && originKind(r) !== 'task-notification';
}

/** Claude Code's hook messages: "Stop hook feedback:\n…", "PreToolUse:Bash hook blocking error from command: …". */
const HOOK_RE = /^([A-Za-z]+)(?::\S*)? hook (?:feedback|blocking error)\b/;

/** A hook's message to the model (e.g. a Stop hook sending it back to work): its event and text, else null. */
export function hookMessage(text: string): { event: string; text: string } | null {
  const m = HOOK_RE.exec(text);
  return m ? { event: m[1]!, text } : null;
}

/** A harness-injected message shown as a collapsed system row: what kind (hook event, peer, task…), its label, its text. */
export type SystemRow = { source: string; label: string; text: string };

/** Injected context for the model only (skill bodies, caveats, image paths, retries): never shown. */
const HIDDEN_META_RE = /^(?:<local-command-caveat>|<system-reminder>|Base directory for this skill|\[Image:|Continue from where you left off\.|\(Re-invocation of |Skill \/\S+ was loaded earlier|The previous response failed to produce a valid tool call)/;
const GOAL_RE = /^(?:Goal check-in:|A session-scoped Stop hook is now active)/;
const SYSTEM_ROW_MAX = 8000;

const TASK_LABEL: Record<string, string> = { completed: '백그라운드 작업 완료', failed: '백그라운드 작업 실패', killed: '백그라운드 작업 중단됨', stopped: '백그라운드 작업 중단됨' };
const tag = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? '';

function row(source: string, label: string, text: string): SystemRow {
  const t = redactSecrets(text);
  return { source, label, text: t.length > SYSTEM_ROW_MAX ? `${t.slice(0, SYSTEM_ROW_MAX)}\n…[잘림: 원래 ${t.length}자]` : t };
}

/**
 * A user-role record the harness wrote, not the person: a system row, 'hide' (context for the model only), or null (a real
 * message). Works on jsonl records (`isMeta`, `origin`, `turnOrigin`, `turnCompanion`) and SDK messages (`isSynthetic`, `origin`).
 * Callers skip tool_result records.
 */
export function systemRow(r: Rec, text: string): SystemRow | 'hide' | null {
  const origin = originKind(r);
  if (origin === 'task-notification') {
    const status = tag(text, 'status').toLowerCase();
    const event = tag(text, 'event');
    const body = [tag(text, 'summary'), tag(text, 'result'), event].filter(Boolean).join('\n\n');
    return row('task', TASK_LABEL[status] ?? (event && !tag(text, 'task-type') ? '모니터 이벤트' : '백그라운드 작업 알림'), body || text);
  }
  if (r.isMeta !== true && r.isSynthetic !== true) return null;
  if (r.turnCompanion === true || HIDDEN_META_RE.test(text) || (text.startsWith('<command-message>') && text.includes('<skill-format>true'))) return 'hide';
  const hook = hookMessage(text);
  if (hook) return row(hook.event, hook.event === 'Stop' || hook.event === 'SubagentStop' ? `${hook.event} 훅이 이어서 진행시킴` : `${hook.event} 훅 메시지`, text);
  if (origin === 'peer') return row('peer', '다른 세션의 메시지', text);
  if (r.turnOrigin === 'scheduled') return row('scheduled', '예약 작업', text);
  if (GOAL_RE.test(text)) return row('goal', '목표 확인', text);
  return text.trim() ? row('auto', '자동 메시지', text) : 'hide';
}

/**
 * A message sent into a running turn (steer) that the CLI folded in at a tool boundary: logged as a
 * `queued_command` attachment, not a user record, but shown — and counted — as the user's message there.
 * `source`: the uuid of the input message it came from (a message is shown once even if logged both ways).
 */
function queuedPrompt(r: Rec): { content: unknown; source: string | null } | null {
  if (r.type !== 'attachment' || r.isSidechain) return null;
  const a = r.attachment;
  if (!a || typeof a !== 'object') return null;
  const q = a as Rec;
  if (q.type !== 'queued_command' || (q.commandMode ?? 'prompt') !== 'prompt' || q.isMeta) return null;
  return { content: q.prompt, source: typeof q.source_uuid === 'string' && q.source_uuid ? q.source_uuid : null };
}

/** Input-message ids already shown as user messages (a steer can be logged as a user record and as a queued_command). */
class SeenPrompts {
  private ids = new Set<string>();
  /** false = this id was shown before (skip it). */
  first(id: string | null): boolean {
    if (!id) return true;
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    return true;
  }
}

function titleFrom(text: string): string | null {
  const first = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  if (!first || first.startsWith('<')) return null;
  return first.length > 80 ? first.slice(0, 80) : first;
}

function scan(text: string): { cwd: string | null; custom: string | null; firstUser: string | null } {
  let cwd: string | null = null;
  let custom: string | null = null;
  let firstUser: string | null = null;
  for (const r of parseLines(text)) {
    if (cwd === null && typeof r.cwd === 'string' && r.cwd) cwd = r.cwd;
    if (r.type === 'custom-title' && typeof r.customTitle === 'string' && r.customTitle.trim()) custom = r.customTitle.trim();
    if (firstUser === null && isRealUser(r)) {
      const m = message(r);
      const t = titleFrom(textOfContent(m?.content));
      if (t) firstUser = t;
    }
  }
  return { cwd, custom, firstUser };
}

export function parseHead(text: string): HeadInfo {
  const { cwd, custom, firstUser } = scan(text);
  return { cwd, title: custom ?? firstUser };
}

async function companionTitle(file: string): Promise<string | null> {
  try {
    const o = JSON.parse(await fs.readFile(path.join(file.replace(/\.jsonl$/, ''), 'custom-title.json'), 'utf8')) as unknown;
    const t = o && typeof o === 'object' ? (o as Rec).customTitle : null;
    return typeof t === 'string' && t.trim() ? t.trim() : null;
  } catch {
    return null;
  }
}

/**
 * cwd from the head; title = the LAST `custom-title` record in the tail window, else the companion
 * `<id>/custom-title.json` (it can lag behind the jsonl), else the last `custom-title` in the head,
 * else the first real user message in the head.
 */
export async function readHead(file: string, maxBytes = 256 * 1024): Promise<HeadInfo> {
  const fh = await fs.open(file, 'r');
  let head: ReturnType<typeof scan>;
  let tailCustom: string | null = null;
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(Math.min(maxBytes, size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    head = scan(buf.subarray(0, bytesRead).toString('utf8'));
    if (size <= maxBytes) tailCustom = head.custom; // the head is the whole file
    else {
      const start = Math.max(maxBytes, size - maxBytes);
      const tail = Buffer.alloc(size - start);
      const r = await fh.read(tail, 0, tail.length, start);
      // The first tail line is usually cut mid-record; parseLines skips it.
      tailCustom = scan(tail.subarray(0, r.bytesRead).toString('utf8')).custom;
    }
  } finally {
    await fh.close();
  }
  const title = tailCustom ?? (await companionTitle(file)) ?? head.custom ?? head.firstUser;
  return { cwd: head.cwd, title };
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return textOfContent(v) || JSON.stringify(v);
  return v === undefined ? '' : JSON.stringify(v);
}

export type TranscriptOptions = {
  /** Keep only the last N messages. */
  maxMessages?: number;
  /** Cut each tool result to this many characters, with a marker. */
  maxToolResultChars?: number;
};

function parseLine(line: string): Rec | null {
  if (!line.trim()) return null;
  try {
    const o = JSON.parse(line) as unknown;
    return o && typeof o === 'object' ? (o as Rec) : null;
  } catch {
    return null; // truncated or non-JSON line: skip
  }
}

/** Incremental jsonl → TranscriptMessage[] (assistant chunks with the same message id merge). */
class TranscriptBuilder {
  private out: TranscriptMessage[] = [];
  private lastAssistantId: string | null = null;
  /** User messages seen so far (their ordinal `n`; must count exactly as `promptText` does). */
  private userCount = 0;
  private seen = new SeenPrompts();
  private readonly max: number;
  private readonly maxChars: number;

  constructor(opts: TranscriptOptions) {
    this.max = opts.maxMessages ?? Infinity;
    this.maxChars = opts.maxToolResultChars ?? Infinity;
  }

  private push(m: TranscriptMessage): void {
    this.out.push(m);
    // Only the last entry is ever merged into, so dropping from the front is safe.
    if (this.out.length > this.max * 2 + 64) this.out = this.out.slice(-this.max);
  }

  add(r: Rec): void {
    const ts = typeof r.timestamp === 'string' ? r.timestamp : null;
    const sys = r.type === 'user' && !r.isSidechain && !r.isCompactSummary && !hasToolResult(message(r)?.content) ? systemRow(r, textOfContent(message(r)?.content)) : null;
    if (sys) {
      // Harness-injected (hook feedback, peer messages, task notifications…): never a user message, so not counted.
      if (sys !== 'hide') {
        this.push({ kind: 'system', ...sys, ts });
        this.lastAssistantId = null;
      }
    } else if (isRealUser(r)) {
      const m = message(r);
      const content = m?.content;
      if (Array.isArray(content) && content.some((b) => b && typeof b === 'object' && (b as Rec).type === 'tool_result')) {
        for (const b of content) {
          const block = b as Rec;
          if (block.type !== 'tool_result') continue;
          let text = stringify(block.content);
          let truncated = false;
          if (text.length > this.maxChars) {
            text = `${text.slice(0, this.maxChars)}\n…[잘림: 원래 ${text.length}자]`;
            truncated = true;
          }
          this.push({ kind: 'tool_result', toolUseId: String(block.tool_use_id ?? ''), content: text, isError: block.is_error === true, ts, ...(truncated ? { truncated } : {}) });
        }
        this.lastAssistantId = null;
        return;
      }
      const t = textOfContent(content);
      if (t && this.seen.first(typeof r.uuid === 'string' ? r.uuid : null)) this.push({ kind: 'user', text: t, ts, n: this.userCount++ });
      this.lastAssistantId = null;
    } else if (queuedPrompt(r)) {
      const q = queuedPrompt(r)!;
      const t = textOfContent(q.content);
      if (t && this.seen.first(q.source)) this.push({ kind: 'user', text: t, ts, n: this.userCount++ });
      this.lastAssistantId = null;
    } else if (r.type === 'assistant' && !r.isSidechain) {
      const m = message(r);
      if (!m) return;
      const id = typeof m.id === 'string' ? m.id : null;
      const model = typeof m.model === 'string' ? m.model : null;
      const blocks = Array.isArray(m.content) ? (m.content as Rec[]) : [];
      let entry: Extract<TranscriptMessage, { kind: 'assistant' }>;
      const last = this.out[this.out.length - 1];
      if (id && id === this.lastAssistantId && last && last.kind === 'assistant') entry = last;
      else {
        entry = { kind: 'assistant', text: '', model, toolCalls: [], ts };
        this.push(entry);
      }
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string') entry.text += (entry.text ? '\n' : '') + b.text;
        else if (b.type === 'thinking') {
          if (typeof b.thinking === 'string' && b.thinking.trim()) entry.thinking = (entry.thinking ? `${entry.thinking}\n\n` : '') + redactSecrets(b.thinking); // as the live stream shows it
          else if (typeof b.signature === 'string' && b.signature) entry.thinkingRedacted = true; // empty text + signature = thinking the API did not return
        } else if (b.type === 'redacted_thinking') entry.thinkingRedacted = true;
        else if (b.type === 'tool_use') entry.toolCalls.push({ id: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input });
      }
      const usage = contextUsageOf(m.usage);
      if (usage) entry.usage = usage;
      this.lastAssistantId = id;
    }
  }

  result(): TranscriptMessage[] {
    return Number.isFinite(this.max) ? this.out.slice(-this.max) : this.out;
  }
}

export function parseTranscript(text: string, opts: TranscriptOptions = {}): TranscriptMessage[] {
  const b = new TranscriptBuilder(opts);
  for (const line of text.split('\n')) {
    const r = parseLine(line);
    if (r) b.add(r);
  }
  return b.result();
}

/** Streams the jsonl line by line (large sessions reach hundreds of MB); defaults: last 200 messages, 8 KB per tool result. */
export async function readTranscript(file: string, opts: TranscriptOptions = {}): Promise<TranscriptMessage[]> {
  const b = new TranscriptBuilder({ maxMessages: opts.maxMessages ?? 200, maxToolResultChars: opts.maxToolResultChars ?? 8192 });
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const r = parseLine(line);
    if (r) b.add(r);
  }
  return b.result();
}

/** The text of a user prompt record or folded steer (what the transcript shows as a user message, counted by `n`), else null. */
function promptText(r: Rec, seen: SeenPrompts): string | null {
  const q = queuedPrompt(r);
  if (q) {
    const t = textOfContent(q.content);
    return t && seen.first(q.source) ? t : null;
  }
  if (!isRealUser(r)) return null;
  const content = message(r)?.content;
  if (Array.isArray(content) && content.some((b) => b && typeof b === 'object' && (b as Rec).type === 'tool_result')) return null;
  const t = textOfContent(content);
  return t && seen.first(typeof r.uuid === 'string' ? r.uuid : null) ? t : null;
}

const squash = (t: string) => t.replace(/\s+/g, ' ').trim();

/**
 * 메시지 편집 갈래: where to fork a Claude transcript so user message `n` is replaced.
 * `at` = the chain entry the message was appended after (its `parentUuid`, else the last chain entry before it): the
 * kept turn's last entry, which `resumeSessionAt` accepts. null = the message opens the conversation (no history to keep).
 * `expect` (the text the user saw, injected blocks stripped): the chosen message must contain it; when message `n`
 * does not (e.g. the device counted differently), the nearest message that does is taken. Null = not found.
 */
export type BranchPoint = { n: number; at: string | null; uuid: string | null };

/** Line-by-line `findBranchPoint`: `feed` returns true once the answer is known (stop reading). */
function branchScanner(n: number, expect?: string): { feed(line: string): boolean; result(): BranchPoint | null } {
  const want = expect ? squash(expect) : '';
  let lastUuid: string | null = null;
  let count = 0;
  let best: BranchPoint | null = null;
  let done = false;
  const seen = new SeenPrompts();
  return {
    feed(line) {
      if (done) return true;
      const r = parseLine(line);
      if (!r) return false;
      const t = promptText(r, seen);
      if (t !== null) {
        const k = count++;
        if (!want || squash(t).includes(want)) {
          const parent = typeof r.parentUuid === 'string' && r.parentUuid ? r.parentUuid : null;
          const cand: BranchPoint = { n: k, at: parent ?? (k === 0 ? null : lastUuid), uuid: typeof r.uuid === 'string' ? r.uuid : null };
          if (k === n || !best || Math.abs(k - n) < Math.abs(best.n - n)) best = cand;
          // Exact hit, or past `n` and only moving away from it.
          if (k >= n) done = true;
        }
      }
      if (typeof r.uuid === 'string' && r.uuid && !r.isSidechain && 'parentUuid' in r) lastUuid = r.uuid;
      return done;
    },
    // Without a text to match only message `n` itself will do.
    result: () => (want || best?.n === n ? best : null),
  };
}

export function findBranchPoint(lines: Iterable<string>, n: number, expect?: string): BranchPoint | null {
  const scan = branchScanner(n, expect);
  for (const line of lines) if (scan.feed(line)) break;
  return scan.result();
}

/** `findBranchPoint` over a transcript file, streamed (sessions reach hundreds of MB). */
export async function readBranchPoint(file: string, n: number, expect?: string): Promise<BranchPoint | null> {
  const scan = branchScanner(n, expect);
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) if (scan.feed(line)) break;
  } finally {
    rl.close();
  }
  return scan.result();
}
