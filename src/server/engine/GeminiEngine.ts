import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { geminiCredFile, geminiEnv, type GeminiAccount } from '../../shared/accounts';
import { GEMINI_CLI_ALIAS, type CodexSandbox, type GeminiModel } from '../../shared/models';
import { ZERO_USAGE, type TurnUsage } from '../../shared/turn-types';
import type { SpawnFn } from './CodexEngine';
import type { EngineEvent, EngineResult } from './Engine';
import { STDERR_MAX } from './redact';

type Rec = Record<string, unknown>;

/** A resume id must be a gemini-cli session id (UUID): it lands in argv after `--resume`, so nothing flag-shaped. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GeminiTurnRequest = {
  account: GeminiAccount;
  cwd: string;
  /** gemini-cli session id (= deck session id); null starts a new session. */
  resumeSessionId: string | null;
  model: GeminiModel;
  /** read-only → `--approval-mode plan`; workspace-write → `auto_edit` (edits only; shell needs approval, which headless denies). */
  sandbox: CodexSandbox;
  prompt: string;
  signal: AbortSignal;
};

/**
 * Headless gemini-cli: the prompt goes on stdin (non-TTY stdin = headless), never in deck's argv. `--skip-trust`
 * because an untrusted folder refuses headless runs; `-s` (macOS seatbelt, profile from geminiEnv) limits writes to
 * the workspace. Effort has no CLI flag.
 */
export function geminiArgs(req: Pick<GeminiTurnRequest, 'resumeSessionId' | 'model' | 'sandbox'>, seatbelt: boolean): string[] {
  return [
    '-o', 'stream-json', '--skip-trust',
    '-m', GEMINI_CLI_ALIAS[req.model],
    '--approval-mode', req.sandbox === 'workspace-write' ? 'auto_edit' : 'plan',
    ...(seatbelt ? ['-s'] : []),
    ...(req.resumeSessionId ? ['--resume', req.resumeSessionId] : []),
  ];
}

/** `stats.input_tokens` includes `cached`; deck reports them apart like Anthropic usage. */
function usageOf(stats: unknown): TurnUsage {
  const r = (stats ?? {}) as Rec;
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  const cached = n('cached');
  return { inputTokens: Math.max(0, n('input_tokens') - cached), outputTokens: n('output_tokens'), cacheReadTokens: cached, cacheCreationTokens: 0 };
}

function errorMessage(e: unknown): string | null {
  const r = (e && typeof e === 'object' ? e : {}) as Rec;
  return typeof r.message === 'string' && r.message ? r.message : null;
}

/** `gemini -o stream-json` (gemini-cli 0.62): init, message, tool_use, tool_result, error, result — see docs/gemini-spike.md. */
export class GeminiEventMapper {
  sessionId: string | null;
  private text = '';
  private lastError: string | null = null;
  private done = false;

  constructor(private readonly model: string, resumeSessionId: string | null) {
    this.sessionId = resumeSessionId;
  }

  get sawResult(): boolean {
    return this.done;
  }

  map(ev: unknown): EngineEvent[] {
    if (!ev || typeof ev !== 'object') return [];
    const e = ev as Rec;
    switch (e.type) {
      case 'init': {
        if (typeof e.session_id !== 'string' || !e.session_id) return [];
        this.sessionId = e.session_id;
        return [{ kind: 'init', sessionId: e.session_id, model: typeof e.model === 'string' ? e.model : this.model }];
      }
      case 'message': {
        if (e.role !== 'assistant' || typeof e.content !== 'string' || !e.content) return [];
        this.text += e.content;
        return [{ kind: 'delta', text: e.content }];
      }
      case 'tool_use':
        return [{ kind: 'tool_call', toolUseId: String(e.tool_id ?? ''), name: String(e.tool_name ?? 'tool'), input: e.parameters ?? {} }];
      case 'tool_result': {
        const isError = e.status === 'error';
        const content = typeof e.output === 'string' ? e.output : (errorMessage(e.error) ?? '');
        return [{ kind: 'tool_result', toolUseId: String(e.tool_id ?? ''), content, isError }];
      }
      case 'error': {
        const msg = typeof e.message === 'string' ? e.message : JSON.stringify(e);
        if (e.severity !== 'warning') this.lastError = msg;
        return [{ kind: 'notice', message: msg }];
      }
      case 'result': {
        this.done = true;
        const ok = e.status === 'success';
        return [this.result(ok, usageOf(e.stats), ok ? null : (errorMessage(e.error) ?? this.lastError ?? 'gemini 실패'))];
      }
      default:
        return [];
    }
  }

  result(ok: boolean, usage: TurnUsage, errorText: string | null): EngineResult {
    return {
      kind: 'result', sessionId: this.sessionId, ok, text: ok ? this.text : '', usage,
      errorText: ok ? null : (errorText ?? this.lastError), stderr: null, errorKind: null, terminalReason: ok ? 'completed' : null,
    };
  }
}

export class GeminiEngine {
  private readonly spawnFn: SpawnFn;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly seatbelt: boolean;

  constructor(readonly bin: string, /** deck's config dir: the accounts live under `<configDir>/gemini/`. */ private readonly configDir: string, opts: { spawnFn?: SpawnFn; baseEnv?: NodeJS.ProcessEnv; seatbelt?: boolean } = {}) {
    this.spawnFn = opts.spawnFn ?? ((b, args, o) => nodeSpawn(b, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] }));
    this.baseEnv = opts.baseEnv ?? process.env;
    // gemini-cli's `-s` is sandbox-exec on macOS; elsewhere it needs docker/podman, so only the approval mode guards.
    this.seatbelt = opts.seatbelt ?? process.platform === 'darwin';
  }

  async *runTurn(req: GeminiTurnRequest): AsyncIterable<EngineEvent> {
    const mapper = new GeminiEventMapper(GEMINI_CLI_ALIAS[req.model], req.resumeSessionId);
    if (req.signal.aborted) {
      yield { ...mapper.result(false, ZERO_USAGE, '중단됨'), terminalReason: 'aborted' };
      return;
    }
    if (req.resumeSessionId !== null && !UUID_RE.test(req.resumeSessionId)) {
      yield mapper.result(false, ZERO_USAGE, '잘못된 세션 ID 형식');
      return;
    }
    const child = this.spawnFn(this.bin, geminiArgs(req, this.seatbelt), { cwd: req.cwd, env: geminiEnv(req.account, this.baseEnv, this.configDir) });
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer | string) => { stderrTail = (stderrTail + String(chunk)).slice(-STDERR_MAX); });
    child.stdin?.on('error', () => {});
    let exited = false;
    let spawnError: string | null = null;
    const exit = new Promise<number | null>((resolve) => {
      child.once('exit', (code: number | null) => { exited = true; resolve(code); });
      child.once('error', (err: Error) => { exited = true; spawnError = err.message; resolve(null); });
    });
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      killTimer.unref?.();
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    if (req.signal.aborted) onAbort();
    try {
      child.stdin?.end(req.prompt);
      if (child.stdout) {
        const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        for await (const line of rl) {
          if (!line.trim()) continue;
          let parsed: unknown;
          try { parsed = JSON.parse(line); } catch { continue; }
          for (const ev of mapper.map(parsed)) yield ev.kind === 'result' && !ev.ok ? { ...ev, stderr: stderrTail || null } : ev;
        }
      }
      const code = await exit;
      if (!mapper.sawResult) {
        const aborted = req.signal.aborted;
        yield { ...mapper.result(false, ZERO_USAGE, aborted ? '중단됨' : spawnError !== null ? `gemini 실행 실패: ${spawnError}` : `gemini 종료 코드 ${code ?? '?'}`), stderr: stderrTail || null, terminalReason: aborted ? 'aborted' : null };
      }
    } finally {
      req.signal.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (!exited) child.kill('SIGTERM');
    }
  }
}

function isExecutable(p: string): boolean {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

/** `DECK_GEMINI_BIN` (as-is when executable) → each `PATH` entry → `~/.local/bin/gemini`. Null = Gemini disabled. deck never logs in. */
export function resolveGeminiBin(env: NodeJS.ProcessEnv, home: string, existsFn: (p: string) => boolean = isExecutable): string | null {
  if (env.DECK_GEMINI_BIN) return existsFn(env.DECK_GEMINI_BIN) ? env.DECK_GEMINI_BIN : null;
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const p = path.join(dir, 'gemini');
    if (existsFn(p)) return p;
  }
  const local = path.join(home, '.local', 'bin', 'gemini');
  return existsFn(local) ? local : null;
}

/** Logged in = the account's OAuth file exists. Existence only: deck never opens it. */
export function geminiLoggedIn(account: GeminiAccount, configDir: string, existsFn: (p: string) => boolean = fs.existsSync): boolean {
  return existsFn(geminiCredFile(account, configDir));
}
