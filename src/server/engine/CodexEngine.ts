import { execFileSync, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { codexEnv } from '../../shared/accounts';
import { CODEX_CLI_MODEL, type CodexModel, type CodexSandbox, type Effort } from '../../shared/models';
import { ZERO_USAGE, type TurnUsage } from '../../shared/turn-types';
import type { EngineEvent, EngineResult } from './Engine';
import { STDERR_MAX, redactSecrets } from './redact';

type Rec = Record<string, unknown>;

/** Review finding 2: `resumeThreadId` must be a Codex thread id (UUID), never argv-flag-shaped. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CodexTurnRequest = {
  cwd: string;
  /** Codex thread id (= deck session id for Codex sessions); null starts a new thread. */
  resumeThreadId: string | null;
  model: CodexModel;
  sandbox: CodexSandbox;
  /** `-c model_reasoning_effort=…`; absent = config.toml's value. */
  effort?: Effort;
  prompt: string;
  /** Absolute paths of image attachments (D7), passed as `-i`. */
  imagePaths?: string[];
  signal: AbortSignal;
};

/**
 * The slice of ChildProcess the engine uses; tests hand in a fake. `once` is declared as
 * per-event overloads (PF9) so both a real `ChildProcess` and the test fake satisfy it.
 */
const STDERR_DRAIN_MS = 1000;

export type ChildLike = Pick<ChildProcess, 'stdout' | 'stderr' | 'stdin' | 'kill'> & {
  pid?: number;
  once(event: 'exit', cb: (code: number | null) => void): unknown;
  once(event: 'error', cb: (err: Error) => void): unknown;
};

export type SpawnFn = (bin: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => ChildLike;

/**
 * D2: every turn overrides the user's config.toml (which may set a wider sandbox or approval policy) with a
 * sandbox and `approval_policy="never"` — exec mode cannot relay approvals, so the sandbox is the guard.
 * The prompt is read from stdin (`-`), never placed in argv. `-i` is multi-valued, so a flag follows
 * the image list to keep the trailing `-` from being taken as a file. `resume` has no `-s`/`-C`
 * (verified `codex exec resume --help`), hence `-c sandbox_mode=…` for both forms.
 */
export function codexArgs(req: Pick<CodexTurnRequest, 'cwd' | 'resumeThreadId' | 'model' | 'sandbox' | 'imagePaths' | 'effort'>): string[] {
  const images = (req.imagePaths ?? []).flatMap((p) => ['-i', p]);
  const common = [
    '--json', '--skip-git-repo-check', '-m', CODEX_CLI_MODEL[req.model],
    '-c', `sandbox_mode="${req.sandbox}"`,
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_workspace_write.network_access=false',
    // Overrides config.toml's model_reasoning_effort; values from ~/.codex/models_cache.json supported_reasoning_levels.
    ...(req.effort ? ['-c', `model_reasoning_effort="${req.effort}"`] : []),
  ];
  return req.resumeThreadId
    ? ['exec', 'resume', req.resumeThreadId, ...images, ...common, '-']
    : ['exec', '-C', req.cwd, ...images, ...common, '-'];
}

/** Codex `input_tokens` includes `cached_input_tokens` (total = input + output); deck reports them apart like Anthropic usage. */
function usageOf(u: unknown): TurnUsage {
  const r = (u ?? {}) as Rec;
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  const cached = n('cached_input_tokens');
  return { inputTokens: Math.max(0, n('input_tokens') - cached), outputTokens: n('output_tokens'), cacheReadTokens: cached, cacheCreationTokens: n('cache_write_input_tokens') };
}

/**
 * codex-cli takes a per-thread writer lock (~/.codex/thread-writer-locks/<id>.lock). The ChatGPT desktop
 * app's `codex app-server` holds it for every thread it has loaded, for as long as it runs (observed
 * 2026-10-03: held since app start, idle threads included), so `codex exec resume` exits 1 with this text.
 * Retrying does not help; deck never touches another app's process.
 */
const THREAD_LOCKED_RE = /already has an active writer/;
export const THREAD_LOCKED_MESSAGE =
  '이 GPT 스레드를 다른 프로그램이 쓰고 있어 deck 에서 이어갈 수 없습니다 — 보통 ChatGPT 데스크톱 앱(Codex)이 이 스레드를 열어 두고 있을 때입니다(/goal 자동 진행 포함). ' +
  '데스크톱 앱에서 이어가거나, 데스크톱 앱을 종료(⌘Q)한 뒤 재시도하세요.';

/** SIGTERM → SIGKILL grace for a codex child deck stops (abort, or the consumer stopped iterating). */
const KILL_GRACE_MS = 5000;

/** PF16: recurring codex-cli config noise (`item.type==='error'`) — logged server-side, never shown as a turn notice. */
const CONFIG_NOISE_RE = /unrecognized configuration setting|is deprecated/;

/**
 * Stateful translation of `codex exec --json` events (thread.started, turn.*, item.*) into
 * EngineEvents. Shapes observed 2026-09-30 are in the plan; command/file/mcp item fields follow the
 * Codex docs and are read leniently.
 */
export class CodexEventMapper {
  threadId: string | null;
  private messages: string[] = [];
  private lastError: string | null = null;
  private started = new Set<string>();
  private warnedNoise = new Set<string>();
  private done = false;

  constructor(private readonly model: string, resumeThreadId: string | null) {
    this.threadId = resumeThreadId;
  }

  get sawResult(): boolean {
    return this.done;
  }

  map(ev: unknown): EngineEvent[] {
    if (!ev || typeof ev !== 'object') return [];
    const e = ev as Rec;
    switch (e.type) {
      case 'thread.started': {
        if (typeof e.thread_id !== 'string' || !e.thread_id) return [];
        this.threadId = e.thread_id;
        return [{ kind: 'init', sessionId: e.thread_id, model: this.model }];
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return this.item(e.type === 'item.completed', (e.item && typeof e.item === 'object' ? e.item : {}) as Rec);
      case 'error':
        this.lastError = typeof e.message === 'string' ? e.message : JSON.stringify(e);
        return [];
      case 'turn.completed':
        this.done = true;
        return [this.result(true, usageOf(e.usage), null)];
      case 'turn.failed': {
        this.done = true;
        const err = (e.error && typeof e.error === 'object' ? e.error : {}) as Rec;
        return [this.result(false, ZERO_USAGE, typeof err.message === 'string' ? err.message : (this.lastError ?? 'turn.failed'))];
      }
      default:
        return [];
    }
  }

  private item(done: boolean, item: Rec): EngineEvent[] {
    const id = String(item.id ?? '');
    const out: EngineEvent[] = [];
    switch (item.type) {
      case 'agent_message': {
        if (!done || typeof item.text !== 'string' || !item.text) return [];
        const sep = this.messages.length ? '\n\n' : '';
        this.messages.push(item.text);
        return [{ kind: 'delta', text: sep + item.text }];
      }
      case 'command_execution': {
        if (!this.started.has(id)) { this.started.add(id); out.push({ kind: 'tool_call', toolUseId: id, name: 'Bash', input: { command: String(item.command ?? '') } }); }
        if (done) {
          const code = typeof item.exit_code === 'number' ? item.exit_code : null;
          out.push({ kind: 'tool_result', toolUseId: id, content: typeof item.aggregated_output === 'string' ? item.aggregated_output : '', isError: item.status === 'failed' || (code !== null && code !== 0) });
        }
        return out;
      }
      case 'file_change': {
        if (!this.started.has(id)) { this.started.add(id); out.push({ kind: 'tool_call', toolUseId: id, name: 'Edit', input: { changes: item.changes ?? [] } }); }
        if (done) out.push({ kind: 'tool_result', toolUseId: id, content: String(item.status ?? 'completed'), isError: item.status === 'failed' });
        return out;
      }
      case 'mcp_tool_call': {
        if (!this.started.has(id)) { this.started.add(id); out.push({ kind: 'tool_call', toolUseId: id, name: `mcp:${String(item.server ?? '')}.${String(item.tool ?? '')}`, input: item.arguments ?? {} }); }
        if (done) out.push({ kind: 'tool_result', toolUseId: id, content: JSON.stringify(item.result ?? item.error ?? null), isError: item.status === 'failed' || (item.error !== undefined && item.error !== null) });
        return out;
      }
      case 'web_search':
        if (!done) return [];
        return [{ kind: 'tool_call', toolUseId: id, name: 'WebSearch', input: { query: String(item.query ?? '') } }, { kind: 'tool_result', toolUseId: id, content: '', isError: false }];
      case 'error': {
        if (!done || typeof item.message !== 'string' || !item.message) return [];
        if (CONFIG_NOISE_RE.test(item.message)) {
          if (!this.warnedNoise.has(item.message)) {
            this.warnedNoise.add(item.message);
            console.warn('deck: codex config notice:', item.message);
          }
          return [];
        }
        return [{ kind: 'notice', message: item.message }];
      }
      default:
        return []; // reasoning, todo_list, unknown
    }
  }

  result(ok: boolean, usage: TurnUsage, errorText: string | null): EngineResult {
    return {
      kind: 'result', sessionId: this.threadId, ok, text: ok ? this.messages.join('\n\n') : '', usage,
      errorText: ok ? null : (errorText ?? this.lastError), stderr: null, errorKind: null, terminalReason: ok ? 'completed' : null,
    };
  }
}

export class CodexEngine {
  private readonly spawnFn: SpawnFn;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly killGraceMs: number;

  constructor(readonly bin: string, opts: { spawnFn?: SpawnFn; baseEnv?: NodeJS.ProcessEnv; killGraceMs?: number } = {}) {
    this.spawnFn = opts.spawnFn ?? ((b, args, o) => nodeSpawn(b, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] }));
    this.baseEnv = opts.baseEnv ?? process.env;
    this.killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  }

  async *runTurn(req: CodexTurnRequest): AsyncIterable<EngineEvent> {
    const mapper = new CodexEventMapper(req.model, req.resumeThreadId);
    if (req.signal.aborted) {
      yield { ...mapper.result(false, ZERO_USAGE, '중단됨'), terminalReason: 'aborted' };
      return;
    }
    // Review finding 2: `resumeThreadId` lands as a bare positional in `codex exec resume <id>`
    // (see codexArgs); an id starting with `-` would be parsed as a flag (e.g. the real
    // `--dangerously-bypass-approvals-and-sandbox`). Verified against codex-cli 0.159.2 that `--`
    // cannot be inserted before the id here: `resume` only has two positional slots (SESSION_ID,
    // PROMPT), so putting `--` there makes every later flag (`-c`, `--json`, `-i`, …) an
    // "unexpected argument" instead of an option. So the UUID shape check below is the sole guard.
    if (req.resumeThreadId !== null && !UUID_RE.test(req.resumeThreadId)) {
      yield mapper.result(false, ZERO_USAGE, '잘못된 세션 ID 형식');
      return;
    }
    const child = this.spawnFn(this.bin, codexArgs(req), { cwd: req.cwd, env: codexEnv(this.baseEnv) });
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer | string) => { stderrTail = (stderrTail + String(chunk)).slice(-STDERR_MAX); });
    // 'exit' can fire before the last stderr chunk is read; classification waits (bounded) for the stream to end.
    const stderrEnded = new Promise<void>((resolve) => {
      if (!child.stderr) { resolve(); return; }
      for (const ev of ['end', 'close', 'error']) child.stderr.once(ev, () => resolve());
    });
    // EPIPE on stdin (child died early) must not crash the server.
    child.stdin?.on('error', () => {});
    // Review finding 3: whether the child has already exited when we stop watching it — if the
    // consumer abandons iteration early (e.g. `sink.emit` throws), the generator's `finally` must
    // still kill the process instead of leaving it running.
    let exited = false;
    // A spawn failure (ENOENT/EACCES) emits 'error' instead of 'exit'; its message becomes the failed result's text.
    let spawnError: string | null = null;
    const exit = new Promise<number | null>((resolve) => {
      child.once('exit', (code: number | null) => { exited = true; resolve(code); });
      child.once('error', (err: Error) => { exited = true; spawnError = err.message; resolve(null); });
    });
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), this.killGraceMs);
      killTimer.unref?.();
    };
    // A failure caused by another process holding the thread's writer lock: a plain Korean message, not a stderr dump.
    const failed = (r: EngineResult): EngineResult => {
      if (!THREAD_LOCKED_RE.test(`${r.errorText ?? ''}\n${stderrTail}`)) return { ...r, stderr: stderrTail || null };
      console.warn('deck: codex thread is locked by another writer:', redactSecrets(stderrTail.trim()));
      return { ...r, errorText: THREAD_LOCKED_MESSAGE, errorKind: 'thread_locked', stderr: null, terminalReason: null };
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    // An abort that landed while spawning (before the listener existed) must still kill the child.
    if (req.signal.aborted) onAbort();
    try {
      child.stdin?.end(req.prompt);
      if (child.stdout) {
        const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        for await (const line of rl) {
          if (!line.trim()) continue;
          let parsed: unknown;
          try { parsed = JSON.parse(line); } catch { continue; }
          for (const ev of mapper.map(parsed)) yield ev.kind === 'result' && !ev.ok ? failed(ev) : ev;
        }
      }
      const code = await exit;
      if (!mapper.sawResult) {
        const aborted = req.signal.aborted;
        // Only a failure is classified from stderr; a grandchild holding the pipe must not delay every normal turn end.
        if (!aborted) {
          let stderrTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([stderrEnded, new Promise<void>((r) => { stderrTimer = setTimeout(r, STDERR_DRAIN_MS); stderrTimer.unref?.(); })]);
          clearTimeout(stderrTimer);
        }
        const r = mapper.result(false, ZERO_USAGE, aborted ? '중단됨' : spawnError !== null ? `codex 실행 실패: ${spawnError}` : `codex 종료 코드 ${code ?? '?'}`);
        yield aborted ? { ...r, stderr: stderrTail || null, terminalReason: 'aborted' } : failed(r);
      }
    } finally {
      req.signal.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      // The consumer stopped iterating (break/throw) before the child exited on its own — don't
      // leave it running, and don't return until it is gone: a resume of the same thread started
      // while it is still shutting down would hit its writer lock ("already has an active writer").
      if (!exited) {
        child.kill('SIGTERM');
        const gone = (ms: number) => Promise.race([exit.then(() => true), new Promise<false>((r) => { setTimeout(() => r(false), ms).unref?.(); })]);
        if (!(await gone(this.killGraceMs))) {
          child.kill('SIGKILL');
          if (!(await gone(this.killGraceMs))) console.warn(`deck: codex pid ${child.pid ?? '?'} did not exit after SIGKILL`);
        }
      }
    }
  }
}

function isExecutable(p: string): boolean {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

/** D1/D11: gpt-6-sol needs codex-cli >= 0.159 (0.146.1 was rejected with HTTP 400). */
export const MIN_CODEX_VERSION = '0.159.0';

function parseVersion(v: string): [number, number, number] {
  const parts = v.split('.').map((n) => Number(n) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function versionAtLeast(v: string, min: string): boolean {
  const a = parseVersion(v);
  const b = parseVersion(min);
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] >= b[2];
}

function defaultVersionFn(bin: string): string | null {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000, env: codexEnv(process.env), stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** Parses `codex-cli X.Y.Z` (and tolerates surrounding text/whitespace); null when unparsable. */
function parseCodexVersion(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/**
 * D11: `DECK_CODEX_BIN` (honored as-is when executable — explicit override, no version gate) →
 * each `PATH` entry → `~/.local/bin/codex` → the newest `~/.nvm/versions/node/<ver>/bin/codex`.
 * Every candidate after the override is skipped when its `--version` is missing or below
 * MIN_CODEX_VERSION (gpt-6-sol needs >= 0.159; an older binary may also sit on PATH). Null =
 * Codex disabled. deck never runs `codex login`.
 */
export function resolveCodexBin(
  env: NodeJS.ProcessEnv,
  home: string,
  existsFn: (p: string) => boolean = isExecutable,
  versionFn: (bin: string) => string | null = defaultVersionFn,
): string | null {
  if (env.DECK_CODEX_BIN) return existsFn(env.DECK_CODEX_BIN) ? env.DECK_CODEX_BIN : null;

  const qualifies = (p: string): boolean => {
    if (!existsFn(p)) return false;
    const v = parseCodexVersion(versionFn(p));
    return v !== null && versionAtLeast(v, MIN_CODEX_VERSION);
  };

  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const p = path.join(dir, 'codex');
    if (qualifies(p)) return p;
  }
  const local = path.join(home, '.local', 'bin', 'codex');
  if (qualifies(local)) return local;
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  let versions: string[];
  try { versions = fs.readdirSync(nvm); } catch { return null; }
  const parts = (v: string) => v.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  versions.sort((x, y) => { const a = parts(x), b = parts(y); return (b[0]! - a[0]!) || (b[1]! - a[1]!) || (b[2]! - a[2]!); });
  for (const v of versions) {
    const p = path.join(nvm, v, 'bin', 'codex');
    if (qualifies(p)) return p;
  }
  return null;
}
