import fs from 'node:fs/promises';
import path from 'node:path';
import { GEMINI_ACCOUNTS, GEMINI_LABEL, isGeminiAccount, type Account, type AccountNames, type GeminiAccount, type ProjectsRoots } from '../../shared/accounts';
import { AUTO_EFFORT, DEFAULT_CODEX_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_MODEL, DEFAULT_SANDBOX, IMPORTED_DEFAULT_MODEL, defaultSandbox, effortFor, isClaudeModel, isCodexModel, isGeminiModel, type ClaudeModel, type CodexModel, type CodexSandbox, type Effort, type EngineChoice, type GeminiModel, type ModelChoice } from '../../shared/models';
import { sdkPermMode, type PermMode } from '../../shared/permission';
import type { RoutingPolicy, ServerMessage, TurnPrompt } from '../../shared/protocol';
import { promptWithFiles, type Attachment, type AttachmentStore } from '../attachments/AttachmentStore';
import { ZERO_USAGE, type BgTaskInfo, type PermissionDecision, type QuestionAnswers, type TurnUsage } from '../../shared/turn-types';
import { appendAudit, hashInput } from '../audit';
import type { CodexEngine } from '../engine/CodexEngine';
import type { GeminiEngine } from '../engine/GeminiEngine';
import { findRolloutFile, readRolloutRateLimits } from '../engine/codexRollout';
import { ruleString, sessionUpdates, type BgTask, type Engine, type EngineEvent, type EngineResult, type LiveInput, type PermissionRequest, type QuestionRequest, type RateLimitSignal } from '../engine/Engine';
import { COOLDOWN_MS, classifyFailure } from '../engine/limitDetect';
import { StreamRedactor, displayError, redactSecrets } from '../engine/redact';
import { chooseAccount, routeLogLine } from '../routing/AccountRouter';
import { chooseAutoModel } from '../routing/AutoModel';
import { chooseEngine } from '../routing/EngineChoice';
import { readAllCooldownsMs, writeCooldown } from '../routing/cooldown';
import { resolveModel } from '../routing/ModelPolicy';
import type { SessionIndex } from '../sessions/SessionIndex';
import { findCopies, resolveCopies } from '../sessions/copies';
import { CODEX_ARCHIVED_NOTICE, importBlockReason, liveRolloutNotice, rolloutActiveAgeMs } from '../sessions/CodexImports';
import { elsewhereNotice } from '../sessions/elsewhereNotice';
import { scanForeign } from '../sessions/foreignWrites';
import { backupDivergedAndMove } from '../sessions/SessionFork';
import { isAncestor, moveSession } from '../sessions/SessionMover';
import { moveToTrash, restoreFromTrash } from '../sessions/SessionTrash';
import { projectSlug } from '../sessions/slug';
import type { UsageService } from '../usage/UsageService';
import { usageOf } from '../../shared/usage-types';
import { isCodexState, isGeminiState, type ClaudeSessionState, type CodexSessionState, type GeminiSessionState, type SessionState, type SessionStateStore } from './SessionState';

export type TurnSink = {
  emit(msg: ServerMessage): void;
  askPermission(req: PermissionRequest & { turnId: string; sessionId: string | null; cwd: string }): Promise<PermissionDecision>;
  /** D8: an AskUserQuestion card; null = unanswered (timeout, abort, turn end). */
  askQuestion(req: QuestionRequest & { turnId: string; sessionId: string | null; cwd: string }): Promise<QuestionAnswers | null>;
  signal: AbortSignal;
};

export type TurnParams = {
  turnId: string;
  cwd: string;
  sessionId: string | null;
  text: string;
  /** Claude or GPT model; a model of the other engine is ignored (the session's default applies). 'auto' = 자동 (new Claude sessions). */
  model?: ModelChoice;
  /** Reasoning effort for this turn; dropped if the resolved model does not support it. */
  effort?: Effort;
  /** New sessions only (D3). */
  engine?: EngineChoice;
  /** New Codex sessions only (D2). */
  sandbox?: CodexSandbox;
  /** Ids from POST /api/attachments (D7). */
  attachments?: string[];
  /** New Claude sessions only: the account to pin (existing sessions keep their stored pin). */
  accountPin?: Account | null;
  /** New Claude sessions only: the mode picked before the first send (existing sessions keep their stored mode). */
  permissionMode?: PermMode;
  /** 새 세션으로 이어가기: the handoff-note turn — Claude runs it with every tool call denied (TurnRequest.noTools). */
  handoff?: boolean;
  /**
   * 메시지 편집 갈래 (new sessions only): fork Claude session `from` at chain entry `at` (the entry the edited
   * message followed) into a new session; `text` replaces that message. The fork keeps the parent's cwd, pin,
   * model and grants. The parent's transcript is never written.
   */
  fork?: { from: string; at: string };
};

export type TurnRunnerDeps = {
  engine: Engine;
  /** Null = Codex disabled (D11); tests inject a fake with just runTurn. */
  codex: Pick<CodexEngine, 'runTurn'> | null;
  /** Null = gemini-cli not installed. `loggedIn` checks only that the account's OAuth file exists (read per turn). */
  gemini?: { engine: Pick<GeminiEngine, 'runTurn'>; loggedIn: (account: GeminiAccount) => boolean } | null;
  /** Null = no attachment store; any attachment id then fails the turn as missing. */
  attachments: AttachmentStore | null;
  codexSessionsRoot: string;
  usage: UsageService;
  index: SessionIndex;
  store: SessionStateStore;
  cooldownDir: string;
  protectedAccount: Account | null;
  auditFile: string;
  /** The mode for new sessions and sessions with no stored mode (read per turn / per new GPT session); absent = 'default'. */
  defaultPermissionMode?: () => PermMode;
  /** 자동 routing policy (DeckSettings.routingPolicy, read per turn); absent = 'balance'. */
  routingPolicy?: () => RoutingPolicy;
  /** One line per routed Claude turn (main: console.log); absent = not logged. */
  routeLog?: (line: string) => void;
  /** A session's mode changed during a turn (approved plan, 이 세션's "allow all edits") or via setPermissionMode. */
  onPermissionMode?: (sessionId: string, mode: PermMode) => void;
  /** Which Claude accounts exist, their order and labels. */
  accounts: AccountNames;
  /** `projects` dir of each configured account (retired included). */
  projectsRoots: ProjectsRoots;
  /**
   * The profile Claude Desktop and a plain `claude --resume` use (A). After every Claude turn that ran
   * elsewhere the session is mirrored back into it (append-only, prefix-checked). Absent/null = no write-back.
   */
  homeAccount?: Account | null;
  /** While a session is held open for background work: at most one write-back per this many ms (default 20 s). */
  mirrorThrottleMs?: number;
  move?: typeof moveSession;
  /** A diverged copy in the target profile (not home/protected) is backed up and overwritten so the move can go on. */
  replaceDiverged?: typeof backupDivergedAndMove;
  /** The session list changed on disk (a fork was written): rescan done, tell the clients. */
  onIndexChanged?: () => void;
  findRollout?: typeof findRolloutFile;
  readRateLimits?: typeof readRolloutRateLimits;
  now?: () => number;
  maxRetries?: number;
};

/** What a turn the user stopped says, whatever the engine threw on the way out (the UI hides it as an error line). */
export const ABORTED = '중단됨';
/** The abort reason deck's shutdown (ws abortAll) stops running turns with. */
export const SHUTDOWN_ABORT = 'deck-shutdown';
/** A turn cut by the server going down: shown (unlike a user's stop, which the UI hides as exactly ABORTED). */
export const SHUTDOWN_ABORTED = '서버가 다시 시작되어 중단됨';
/** The error text of an aborted turn: the user's stop (interrupt, 지금 전송; also a recycle) vs. the server shutting down. */
export const abortedText = (signal: AbortSignal): string => (signal.reason === SHUTDOWN_ABORT ? SHUTDOWN_ABORTED : ABORTED);

/** gemini-cli's quota / 429 errors (TerminalQuotaError, RESOURCE_EXHAUSTED); matched on the CLI's result error only. */
const GEMINI_LIMIT_RE = /\bRESOURCE_EXHAUSTED\b|exhausted your (daily )?quota|\bQuota exceeded\b|"code"\s*:\s*429\b/i;

/** `rest`: the engine stream after the first result (background continuations); `live`: its input handle. */
type Attempt = {
  result: EngineResult | null; rateLimit: RateLimitSignal | null; sessionId: string | null; compacted: boolean; initCwd: string | null;
  rest: AsyncIterator<EngineEvent>; live: LiveInput | null; bgTasks: string[];
};

/** A user message for a session whose process is still open for background work (see `followUp`). */
export type FollowUpParams = { turnId: string; text: string; attachments?: string[]; model?: ModelChoice; clientRef?: string };

/** The mutable "which deck turn is the process working for now" — permission cards and events follow it. */
type Cursor = { turnId: string };

type LiveSession = { submit(f: FollowUpParams, attachments: Attachment[]): boolean; /** When the process was started: it has read nothing another process wrote after this. */ since: number; /** Per transcript copy: the offset the foreign-write check found clean up to. */ clean: Map<string, number> };

/** What 이 세션 accepted: allow rules as rule strings and added directories (its acceptEdits becomes the session's mode). */
type SessionGrants = { rules: string[]; dirs: string[] };

/** A Claude turn's live permission mode: read per tool call, changed mid-turn by setPermissionMode or an approved plan. */
type ModeRef = { mode: PermMode };

function addGrants(g: SessionGrants, pr: PermissionRequest): void {
  // The same sanitized set the engine returned to the SDK: nothing broader is ever remembered.
  for (const u of sessionUpdates(pr)) {
    if (u.type === 'addRules') {
      for (const r of u.rules) {
        const rule = ruleString(r);
        if (!g.rules.includes(rule)) g.rules.push(rule);
      }
    } else if (u.type === 'addDirectories') {
      for (const d of u.directories) if (!g.dirs.includes(d)) g.dirs.push(d);
    }
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

/** First non-empty line of the prompt, ≤ 80 chars — the sidebar title of a Codex session (D4). */
/** Background task detail for the wire: age instead of a start time (the client's clock may differ). */
function bgInfo(detail: BgTask[] | undefined, now: number): BgTaskInfo[] | undefined {
  return detail?.map((t) => ({ id: t.id, description: t.description, type: t.type, ageMs: Math.max(0, now - t.startedAtMs) }));
}

/** Events that leave held thinking text held: more thinking, and the meters that tick between its deltas. */
function holdsThinking(ev: EngineEvent): boolean {
  return (ev.kind === 'thinking' && !!ev.text && !ev.redacted) || ev.kind === 'progress' || ev.kind === 'rate_limit';
}

function taskDoneOf(ev: Extract<EngineEvent, { kind: 'task_done' }>) {
  return {
    status: ev.status, summary: redactSecrets(ev.summary),
    ...(ev.taskId ? { taskId: ev.taskId } : {}),
    ...(ev.toolUseId !== undefined ? { toolUseId: ev.toolUseId } : {}),
    ...(ev.usage ? { usage: ev.usage } : {}),
  };
}

function titleOf(text: string): string {
  const first = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return first.length > 80 ? first.slice(0, 80) : first || '(제목 없음)';
}

export class TurnRunner {
  private readonly move: typeof moveSession;
  private readonly replaceDiverged: typeof backupDivergedAndMove;
  private readonly now: () => number;
  private readonly maxRetries: number;
  private readonly findRollout: typeof findRolloutFile;
  private readonly readRateLimits: typeof readRolloutRateLimits;
  private gptCooldownUntil: number | null = null;
  /** Claude sessions whose process stays open for background work, by session id. */
  private readonly live = new Map<string, LiveSession>();
  /** The engine input handle of each running Claude turn, by its first turn id (per-task stop). */
  private readonly inputs = new Map<string, LiveInput>();
  /**
   * Steers of each running Claude turn's process, by its first turn id: `pending` = written, not yet seen reaching
   * the model (steerId → prompt); `ids` = every steerId ever taken, so each is answered exactly once.
   */
  private readonly steering = new Map<string, { pending: Map<string, TurnPrompt>; ids: Set<string> }>();
  /** The live mode of each running Claude turn and the session it is for, by its first turn id. */
  private readonly modes = new Map<string, { ref: ModeRef; sessionId: () => string | null }>();
  /** In-memory, per Gemini account, after a quota failure: new Gemini sessions open on the other account. */
  private geminiCooldownUntil: Partial<Record<GeminiAccount, number>> = {};
  /** Home write-backs in flight, by session id (serialized per session; the next turn waits for it). */
  private readonly mirrors = new Map<string, Promise<void>>();
  /** Notices already shown, `${sessionId}\0${message}` — a lasting divergence is told once, not every turn. */
  private readonly noted = new Set<string>();
  /** Home write-back failures already logged, `${sessionId}\0${reason}` — logged once, until a write-back of that session succeeds. */
  private readonly writeBackLogged = new Set<string>();
  /** When each session's last write-back was started (wall clock), and a trailing one due while throttled. */
  private readonly mirrorAt = new Map<string, number>();
  private readonly mirrorTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Claude sessions with a deck turn running now (its process may write the jsonl at any moment), counted: an edit-fork
   * reading its parent and the parent's own turn each hold it, so the first to end does not unmark the other.
   */
  private readonly active = new Map<string, number>();
  /** When deck itself last wrote a transcript (its turn's process closed, a move/write-back), by resolved path. In memory only. */
  private readonly deckWroteAt = new Map<string, number>();

  private readonly accounts: AccountNames;
  /** `projects` dir by account, in configured order. */
  private readonly roots: ReadonlyMap<Account, string>;

  constructor(private readonly deps: TurnRunnerDeps) {
    this.accounts = deps.accounts;
    this.roots = new Map(deps.projectsRoots.map((r) => [r.id, r.dir]));
    const move = deps.move ?? moveSession;
    this.move = async (o) => {
      const r = await move(o);
      if (r.ok) this.deckWroteAt.set(path.resolve(r.targetFile), this.now());
      return r;
    };
    this.replaceDiverged = deps.replaceDiverged ?? backupDivergedAndMove;
    this.now = deps.now ?? (() => Date.now());
    this.maxRetries = deps.maxRetries ?? 2;
    this.findRollout = deps.findRollout ?? findRolloutFile;
    this.readRateLimits = deps.readRateLimits ?? readRolloutRateLimits;
  }

  /**
   * A message for a session that is busy only because its process waits for background work:
   * it is written into that process's input (streaming-input mode — the CLI takes it as the next
   * user turn; the background tasks keep running). While a background continuation is streaming
   * the message waits in deck and goes in right after that continuation's result. Same process,
   * so the account and model stay those of the running process. False = no such process
   * (the caller refuses the send as busy).
   */
  followUp(sessionId: string, f: FollowUpParams): boolean {
    const entry = this.live.get(sessionId);
    if (!entry) return false;
    let attachments: Attachment[] = [];
    if (f.attachments?.length) {
      const r = this.deps.attachments?.resolve([...new Set(f.attachments)]) ?? { found: [], missing: f.attachments };
      if (r.missing.length) return false;
      attachments = r.found;
    }
    return entry.submit(f, attachments);
  }

  /**
   * Whether the session's held-open process (see `followUp`) is behind: since it started, some copy of the transcript
   * gained main-chain entries deck did not write (Claude Desktop / a terminal CLI went on with the session). That
   * process would answer from before them; a new one resumes from the newest copy (`reconcile`). False when no
   * process is held open — every ordinary turn starts a new process that reads the transcript as it is. Never throws.
   */
  async foreignWrites(sessionId: string): Promise<boolean> {
    const entry = this.live.get(sessionId);
    const st = this.deps.store.get(sessionId);
    if (!entry || !st || isCodexState(st) || isGeminiState(st)) return false;
    try {
      const copies = await findCopies(this.deps.projectsRoots, sessionId, st.projectDir, st.account);
      for (const c of copies) {
        const from = entry.clean.get(c.file);
        // Never scanned: the stat spares the read (2 s of slack for file systems that keep whole-second mtimes).
        if (from === undefined && c.mtimeMs < entry.since - 2000) continue;
        // Scanned before: only what was appended since is read, so a process held open for hours costs each send the same.
        const r = await scanForeign(c.file, entry.since, from ?? 0);
        if (r.foreign) return true;
        entry.clean.set(c.file, r.end);
      }
    } catch (err) {
      console.error('deck: foreign write check failed', err instanceof Error ? err.message : err);
    }
    return false;
  }

  /** Resolves when every home write-back started so far has finished (tests, shutdown). */
  async mirrorsSettled(): Promise<void> {
    while (this.mirrors.size) await Promise.all([...this.mirrors.values()]);
  }

  /** True the first time `message` is seen for this session (a lasting state is told once). */
  private firstNote(sessionId: string, message: string): boolean {
    const key = `${sessionId}\0${message}`;
    if (this.noted.has(key)) return false;
    this.noted.add(key);
    return true;
  }

  private noteOnce(sink: TurnSink, turnId: string, state: { sessionId: string; cwd: string }, message: string): void {
    if (!this.firstNote(state.sessionId, message)) return;
    sink.emit({ type: 'turn_notice', turnId, sessionId: state.sessionId, cwd: state.cwd, message });
  }

  private label(account: Account): string {
    return this.accounts.label(account);
  }

  /** The account's `projects` dir. Throws for an account that is not configured (a stored session of a removed one). */
  private rootOf(account: Account): string {
    const root = this.roots.get(account);
    if (root === undefined) throw new Error(`설정에 없는 계정: ${account}`);
    return root;
  }

  /**
   * After a Claude turn (its process closed, the jsonl flushed): copy the session back into the home
   * profile so Claude Desktop / `claude --resume` there see it. Runs in the background; a failure is a
   * notice on the turn, never a turn failure. A home copy that went its own way is left untouched.
   */
  private scheduleMirror(sessionId: string, sink: TurnSink, turnId: string): void {
    const home = this.deps.homeAccount;
    if (!home) return;
    clearTimeout(this.mirrorTimers.get(sessionId));
    this.mirrorTimers.delete(sessionId);
    this.mirrorAt.set(sessionId, Date.now());
    this.serialize(sessionId, () => this.mirrorHome(sessionId, home, sink, turnId)).catch((err: unknown) => console.error('deck: home write-back failed', err instanceof Error ? err.message : err));
  }

  /** Runs `fn` after every write-back / fork resolution already queued for this session. */
  private serialize<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.mirrors.get(sessionId) ?? Promise.resolve()).then(fn);
    const done = run.then(() => undefined, () => undefined);
    this.mirrors.set(sessionId, done);
    void done.then(() => { if (this.mirrors.get(sessionId) === done) this.mirrors.delete(sessionId); });
    return run;
  }

  /**
   * A result while the process stays open for background work (sessions are held open for a long
   * time): write back now, or — within the throttle window — once when it ends. The final one at
   * close is scheduled by runClaude regardless.
   */
  private mirrorSoon(sessionId: string, sink: TurnSink, turnId: string): void {
    if (!this.deps.homeAccount || this.mirrorTimers.has(sessionId)) return;
    const wait = (this.mirrorAt.get(sessionId) ?? -Infinity) + (this.deps.mirrorThrottleMs ?? 20_000) - Date.now();
    if (wait <= 0) { this.scheduleMirror(sessionId, sink, turnId); return; }
    const t = setTimeout(() => this.scheduleMirror(sessionId, sink, turnId), wait);
    t.unref?.();
    this.mirrorTimers.set(sessionId, t);
  }

  /** deck's copy and the home profile's copy of a session, when deck runs it on another profile. */
  private async forkPair(sessionId: string): Promise<{ st: ClaudeSessionState; home: Account; deckFile: string; homeDir: string; homeFile: string } | null> {
    const home = this.deps.homeAccount;
    const st = this.deps.store.get(sessionId);
    if (!home || !st || isCodexState(st) || isGeminiState(st) || st.account === home) return null;
    const homeDir = path.join(this.rootOf(home), path.basename(st.projectDir));
    return { st, home, deckFile: path.join(st.projectDir, `${sessionId}.jsonl`), homeDir, homeFile: path.join(homeDir, `${sessionId}.jsonl`) };
  }

  /**
   * Whether deck's copy and the home copy (Claude Desktop) went their own ways — neither contains the other.
   * Null: not a deck Claude session run outside the home profile.
   */
  async forkStatus(sessionId: string): Promise<{ diverged: boolean; deckAccount: Account; homeAccount: Account } | null> {
    const pair = await this.forkPair(sessionId);
    if (!pair) return null;
    const both = (await exists(pair.deckFile)) && (await exists(pair.homeFile));
    const diverged = both && !(await isAncestor(pair.homeFile, pair.deckFile)) && !(await isAncestor(pair.deckFile, pair.homeFile));
    return { diverged, deckAccount: pair.st.account, homeAccount: pair.home };
  }

  /**
   * "Desktop에서 열기": bring the home profile's copy up to date now (the same write-back as after a turn, awaited)
   * so `claude://resume?session=` finds the current conversation. `busy`: a CLI process of deck's still holds the session.
   */
  async openInDesktop(sessionId: string): Promise<{ ok: true; busy: boolean } | { ok: false; reason: 'unsupported' | 'diverged' | 'failed'; error?: string }> {
    const st = this.deps.store.get(sessionId);
    if (st && (isCodexState(st) || isGeminiState(st))) return { ok: false, reason: 'unsupported' };
    const busy = this.active.has(sessionId) || this.live.has(sessionId);
    const home = this.deps.homeAccount;
    if (!st || !home || st.account === home) return { ok: true, busy };
    return this.serialize(sessionId, async () => {
      const r = await this.move({ sessionId, sourceProjectDir: st.projectDir, targetProjectsRoot: this.rootOf(home), ignoreOtherDirs: true });
      if (r.ok) return { ok: true as const, busy };
      // The home copy already contains ours: it is the newer one, nothing to write back.
      if (r.diverged && (await isAncestor(path.join(st.projectDir, `${sessionId}.jsonl`), path.join(this.rootOf(home), path.basename(st.projectDir), `${sessionId}.jsonl`)).catch(() => false))) return { ok: true as const, busy };
      return r.diverged ? { ok: false as const, reason: 'diverged' as const } : { ok: false as const, reason: 'failed' as const, error: r.error };
    });
  }

  /**
   * The user's answer to a divergence. `keep: 'deck'` — the home copy (and its `<id>/` dir) is renamed to
   * `*.deck-fork-<ts>` and deck's copy is written there; `keep: 'home'` — the same on deck's side, adopting
   * the home copy. Nothing is deleted. Adopting the home copy needs the deck process gone (it would keep
   * appending to the old file); on failure the backups are put back.
   */
  async resolveFork(sessionId: string, keep: 'deck' | 'home'): Promise<{ ok: true; backup: string } | { ok: false; error: string }> {
    return this.serialize(sessionId, async () => {
      const pair = await this.forkPair(sessionId);
      if (!pair || !(await this.forkStatus(sessionId))?.diverged) return { ok: false as const, error: '갈라진 사본이 없습니다' };
      if (keep === 'home' && (this.active.has(sessionId) || this.live.has(sessionId))) {
        return { ok: false as const, error: 'deck 에서 이 세션이 실행 중입니다 — 끝난 뒤 다시 시도하세요' };
      }
      const [srcDir, dstDir] = keep === 'deck' ? [pair.st.projectDir, pair.homeDir] : [pair.homeDir, pair.st.projectDir];
      const stamp = `deck-fork-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const file = path.join(dstDir, `${sessionId}.jsonl`);
      const dir = path.join(dstDir, sessionId);
      const moved: [string, string][] = [];
      try {
        for (const [from, to] of [[file, `${file}.${stamp}`], [dir, `${dir}.${stamp}`]] as const) {
          if (!(await exists(from))) continue;
          await fs.rename(from, to);
          moved.push([from, to]);
        }
        const r = await this.move({ sessionId, sourceProjectDir: srcDir, targetProjectsRoot: path.dirname(dstDir), ignoreOtherDirs: true });
        if (!r.ok) throw new Error(r.error);
      } catch (err) {
        for (const [from, to] of moved.reverse()) if (!(await exists(from))) await fs.rename(to, from).catch(() => undefined);
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
      for (const k of [...this.noted]) if (k.startsWith(`${sessionId}\0`)) this.noted.delete(k);
      return { ok: true as const, backup: `${file}.${stamp}` };
    });
  }

  /**
   * 삭제: every profile's copy of a Claude session goes to that profile's `session-trash/` (moved, never unlinked;
   * pruned after the backup retention). Refused while deck runs it (turn or background process) or while
   * another program (Desktop/CLI) seems to have it open. Returns the undo handle.
   */
  async trashSession(sessionId: string): Promise<{ ok: true; trashId: string } | { ok: false; error: string }> {
    return this.serialize(sessionId, async () => {
      const st = this.deps.store.get(sessionId);
      if (st && (isCodexState(st) || isGeminiState(st))) return { ok: false as const, error: 'Claude 대화만 삭제할 수 있습니다' };
      const e = this.deps.index.lookup(sessionId);
      if (!st && (!e || e.account === 'gpt' || isGeminiAccount(e.account) || e.imported)) return { ok: false as const, error: 'Claude 대화만 삭제할 수 있습니다' };
      if (this.active.has(sessionId) || this.live.has(sessionId)) return { ok: false as const, error: '실행 중인 대화는 삭제할 수 없습니다 — 끝난 뒤 다시 시도하세요' };
      const base: ClaudeSessionState = st ?? { sessionId, cwd: e!.cwd, account: e!.account as Account, projectDir: e!.projectDir, lastTurnAtMs: null, justCompacted: false, defaultModel: IMPORTED_DEFAULT_MODEL };
      if ((await this.openElsewhere(base)) !== null) return { ok: false as const, error: '다른 곳(Desktop/CLI)에서 열려 있는 것 같아 삭제하지 않았습니다' };
      const copies = await findCopies(this.deps.projectsRoots, sessionId, base.projectDir, base.account).catch(() => []);
      try {
        const r = await moveToTrash({ sessionId, projectDirs: copies.map((c) => c.projectDir), nowMs: this.now() });
        return { ok: true as const, trashId: r.trashId };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  /** 되돌리기 for trashSession. */
  async restoreSession(trashId: string): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    try {
      const r = await restoreFromTrash({ trashId, projectsRoots: [...this.roots.values()] });
      return { ok: true, sessionId: r.sessionId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async mirrorHome(sessionId: string, home: Account, sink: TurnSink, turnId: string): Promise<void> {
    const st = this.deps.store.get(sessionId);
    if (!st || isCodexState(st) || isGeminiState(st) || st.account === home) return;
    // Only the same-named dir is refreshed: a stale copy under an older dir spelling must not block it (nor is it touched).
    const r = await this.move({ sessionId, sourceProjectDir: st.projectDir, targetProjectsRoot: this.rootOf(home), ignoreOtherDirs: true });
    if (r.ok) {
      // A later failure (of any reason) is news again.
      for (const k of [...this.writeBackLogged]) if (k.startsWith(`${sessionId}\0`)) this.writeBackLogged.delete(k);
      return;
    }
    // The home copy already contains ours (Desktop went on, deck added nothing): the next turn pulls it in.
    if (r.diverged && (await isAncestor(path.join(st.projectDir, `${sessionId}.jsonl`), path.join(this.rootOf(home), path.basename(st.projectDir), `${sessionId}.jsonl`)).catch(() => false))) return;
    // Once per process for a given session and reason: a lasting state would otherwise log on every turn.
    const logKey = `${sessionId}\0${r.diverged ? 'diverged' : r.error}`;
    if (!this.writeBackLogged.has(logKey)) {
      this.writeBackLogged.add(logKey);
      console.error(`deck: home write-back of ${sessionId} to ${this.label(home)} failed: ${r.error}`);
    }
    this.noteOnce(sink, turnId, st, r.diverged
      ? `다른 곳(Desktop/CLI)에서 따로 이어진 대화가 있어 갈라졌습니다 — ${this.label(home)} 계정 사본은 덮어쓰지 않았습니다 (머리글의 '갈라짐' 메뉴에서 어느 쪽으로 맞출지 고를 수 있습니다)`
      : `${this.label(home)} 계정 사본 갱신 실패(${r.error}) — 대화는 계속됩니다`);
  }

  /**
   * Before a turn: the same session may have moved on in another profile (Claude Desktop on A).
   * A copy that contains ours is pulled into the profile deck last used (so routing is unchanged);
   * if that copy cannot be written, the session follows it instead. Truly diverged copies are never
   * merged or overwritten: the one with the latest conversation timestamp is used (a tie → deck's, not the
   * home copy) and the user is told.
   */
  private async reconcile(state: ClaudeSessionState, say: (message: string) => void): Promise<ClaudeSessionState> {
    try {
      const copies = await findCopies(this.deps.projectsRoots, state.sessionId, state.projectDir, state.account);
      // No copy where deck left it: nothing to compare against (locateProjectDir / the engine handle that).
      if (copies[0]?.projectDir !== state.projectDir || copies.length < 2) return state;
      const r = (await resolveCopies(copies, undefined, { home: this.deps.homeAccount }))!;
      if (r.heads.length > 1) {
        // Desktop's (home/protected) copy is never overwritten; a B/C copy is, once the session moves there (relocate backs it up first).
        const others = r.heads.filter((h) => h !== r.best).map((h) => h.account);
        const kept = others.filter((a) => a === this.deps.homeAccount || a === this.deps.protectedAccount);
        const replaced = others.filter((a) => !kept.includes(a));
        const names = (as: Account[]) => as.map((a) => this.label(a)).join('·');
        const parts = [
          ...(kept.length ? [`${names(kept)} 계정 사본은 덮어쓰지 않아요 (머리글의 '갈라짐' 메뉴에서 맞출 수 있습니다)`] : []),
          ...(replaced.length ? [`${names(replaced)} 계정 사본은 그 계정으로 옮길 때 백업해 두고 덮어써요`] : []),
        ];
        const message = `다른 곳(Desktop/CLI)에서 따로 이어진 대화가 있어 갈라졌습니다 — 가장 최근 대화가 있는 ${this.label(r.best.account)} 계정 사본으로 이어가고, ${parts.join(', ')}`;
        if (this.firstNote(state.sessionId, message)) say(message);
      }
      if (r.best.projectDir === state.projectDir) return state;
      if (!r.heads.includes(copies[0]!)) {
        // Ours is an older prefix of the winner: refresh it in place (moveSession accepts only that).
        const m = await this.move({ sessionId: state.sessionId, sourceProjectDir: r.best.projectDir, targetProjectsRoot: this.rootOf(state.account) });
        if (m.ok && path.resolve(m.targetDir) === path.resolve(state.projectDir)) return state;
      }
      const next = { ...state, account: r.best.account, projectDir: r.best.projectDir };
      await this.deps.store.set(next);
      return next;
    } catch (err) {
      console.error('deck: session copy check failed', err instanceof Error ? err.message : err);
      return state;
    }
  }

  /**
   * Stop one background task of a running Claude turn (`turnId` = the turn's first id). False when the
   * turn has no open process or the SDK cannot stop single tasks (the caller falls back to interrupt).
   */
  async stopTask(turnId: string, taskId: string): Promise<boolean> {
    const l = this.inputs.get(turnId);
    if (!l?.stopTask) return false;
    try {
      return await l.stopTask(taskId);
    } catch (err) {
      console.error('deck: stopTask failed', err instanceof Error ? err.message : err);
      return false;
    }
  }

  /**
   * A message typed while Claude turn `turnId` (its first id) runs, written into its process with priority 'next': the
   * CLI folds it in at the next tool boundary, or runs it right after the turn. `steer_delivered` (with `prompt`) is
   * emitted once it reaches the model; `steer_rejected` if the process ends or the turn retries first. Never resent by a
   * retry or failover. False = cannot go in now (no running Claude process, a handoff turn, attachment gone, input
   * closed, retrying). Null = already answered (a repeated steerId, or settled while being written): say nothing more.
   */
  async steer(turnId: string, s: { steerId: string; text: string; attachments?: string[]; prompt: TurnPrompt }): Promise<boolean | null> {
    const l = this.inputs.get(turnId);
    const st = this.steering.get(turnId);
    if (st?.ids.has(s.steerId)) return null;
    if (!l?.steer || !st) return false;
    let attachments: Attachment[] = [];
    if (s.attachments?.length) {
      const r = this.deps.attachments?.resolve([...new Set(s.attachments)]) ?? { found: [], missing: s.attachments };
      if (r.missing.length) return false;
      attachments = r.found;
    }
    // Registered before the write: the CLI may echo it back before the write resolves.
    st.ids.add(s.steerId);
    st.pending.set(s.steerId, s.prompt);
    try {
      if (await l.steer({ text: s.text, attachments }, s.steerId)) return true;
    } catch (err) {
      console.error('deck: steer failed', err instanceof Error ? err.message : err);
    }
    // Rejected (process ended, retry) or delivered meanwhile: that answer stands.
    return st.pending.delete(s.steerId) ? false : null;
  }

  private steerDelivered(turnId: string, steerId: string, sink: TurnSink, scope: { turnId: string; sessionId: string | null; cwd: string }): void {
    const pending = this.steering.get(turnId)?.pending;
    const prompt = pending?.get(steerId);
    if (!pending || !prompt) return;
    pending.delete(steerId);
    sink.emit({ type: 'steer_delivered', ...scope, steerId, prompt });
  }

  /**
   * Every steer of `turnId` still waiting goes back to its device (sent after the turn instead).
   * Known edge: a steer the CLI already folded in just before an interrupt / crash whose echo never came out is
   * rejected here too, so the device sends it again after the turn — the model sees it twice. Rarer than losing it.
   */
  private rejectSteers(turnId: string, sink: TurnSink, scope: { turnId: string; sessionId: string | null; cwd: string }, message: string): void {
    const pending = this.steering.get(turnId)?.pending;
    if (!pending) return;
    for (const steerId of pending.keys()) sink.emit({ type: 'steer_rejected', ...scope, steerId, message });
    pending.clear();
  }

  private bgExtra(turnId: string, detail: BgTask[] | undefined): { detail?: BgTaskInfo[]; canStop?: boolean } {
    const info = bgInfo(detail, this.now());
    return { ...(info ? { detail: info } : {}), ...(this.canStopTasks(turnId) ? { canStop: true } : {}) };
  }

  /** Whether `turnId` (a turn's first id) can stop single tasks. */
  canStopTasks(turnId: string): boolean {
    return typeof this.inputs.get(turnId)?.stopTask === 'function';
  }

  /** Session ids whose process is held open for background work. */
  backgroundSessions(): string[] {
    return [...this.live.keys()];
  }

  /**
   * 이 세션은 B 써: pins a Claude session to an account (null = 자동), applied from its next turn (which moves it there).
   * A session deck has no state for yet (seen only in the index) gets one. False = not a Claude session deck knows.
   */
  async setAccountPin(sessionId: string, pin: Account | null): Promise<boolean> {
    const { store, index } = this.deps;
    if (pin !== null && !this.accounts.list().includes(pin)) return false;
    if (!store.get(sessionId)) {
      const e = index.lookup(sessionId);
      if (!e || e.account === 'gpt' || isGeminiAccount(e.account)) return false;
      await store.set({ sessionId, cwd: e.cwd, account: e.account, projectDir: e.projectDir, lastTurnAtMs: null, justCompacted: false, defaultModel: IMPORTED_DEFAULT_MODEL, ...(pin ? { accountPin: pin } : {}) });
      return true;
    }
    return store.setAccountPin(sessionId, pin);
  }

  private defaultMode(): PermMode {
    return this.deps.defaultPermissionMode?.() ?? 'default';
  }

  /** The mode a Claude session's next tool call runs in: its running turn's, else the stored one, else the default. */
  permissionModeOf(sessionId: string): PermMode {
    for (const m of this.modes.values()) if (m.sessionId() === sessionId) return m.ref.mode;
    const st = this.deps.store.get(sessionId);
    return (st && !isCodexState(st) && !isGeminiState(st) ? st.mode : undefined) ?? this.defaultMode();
  }

  /**
   * The picker / Shift+Tab: stores a Claude session's mode and applies it to its running turn at once (tool calls read
   * it per call; the process gets Query.setPermissionMode). False = not a Claude session deck knows.
   */
  async setPermissionMode(sessionId: string, mode: PermMode): Promise<boolean> {
    const { store, index } = this.deps;
    const st = store.get(sessionId);
    if (!st) {
      const e = index.lookup(sessionId);
      if (!e || e.account === 'gpt' || isGeminiAccount(e.account)) return false;
      await store.set({ sessionId, cwd: e.cwd, account: e.account, projectDir: e.projectDir, lastTurnAtMs: null, justCompacted: false, defaultModel: IMPORTED_DEFAULT_MODEL, mode });
    } else if (isCodexState(st) || isGeminiState(st)) {
      return false;
    } else {
      await store.set({ ...st, mode });
    }
    for (const [turnId, m] of this.modes) {
      if (m.sessionId() !== sessionId || m.ref.mode === mode) continue;
      m.ref.mode = mode;
      await this.inputs.get(turnId)?.setPermissionMode?.(sdkPermMode(mode)).catch((err: unknown) => console.error('deck: setPermissionMode failed', err instanceof Error ? err.message : err));
    }
    return true;
  }

  /** A turn changed its own mode (the SDK already switched): remember it for the session and tell the clients. */
  private async applyMode(sessionId: string | null, ref: ModeRef, mode: PermMode): Promise<void> {
    ref.mode = mode;
    if (!sessionId) return;
    const st = this.deps.store.get(sessionId);
    if (st && !isCodexState(st) && !isGeminiState(st) && st.mode !== mode) {
      await this.deps.store.set({ ...st, mode }).catch((err: unknown) => console.error('deck: saving the permission mode failed', err instanceof Error ? err.message : err));
    }
    this.deps.onPermissionMode?.(sessionId, mode);
  }

  /** D3: set after a Codex limit failure; consulted by chooseEngine for 'auto'. In memory only. */
  gptCooldownUntilMs(): number | null {
    return this.gptCooldownUntil;
  }

  /**
   * Moves the session into `to`'s profile. A copy there that went its own way (the same id continued in two
   * places) is backed up to that profile's `session-backups/` and overwritten with ours (the copy reconcile chose),
   * then the move is retried — except in the home/protected profile (Desktop's), whose copy is never touched.
   * Notices go through `say` (the caller shows them on the turn).
   */
  private async relocate(state: ClaudeSessionState, to: Account, say: (message: string) => void): Promise<ClaudeSessionState | null> {
    const req = { sessionId: state.sessionId, sourceProjectDir: state.projectDir, targetProjectsRoot: this.rootOf(to) };
    let r = await this.move(req);
    let replaced: string | null = null;
    if (!r.ok && r.diverged) {
      // The target copy merely extends ours (it is ahead, not diverged): continue from it, as openInDesktop does.
      const targetDir = path.join(this.rootOf(to), path.basename(state.projectDir));
      if (await isAncestor(path.join(state.projectDir, `${state.sessionId}.jsonl`), path.join(targetDir, `${state.sessionId}.jsonl`)).catch(() => false)) {
        const next = { ...state, account: to, projectDir: targetDir };
        await this.deps.store.set(next);
        say('다른 계정에 더 최신 대화가 있어 그걸로 이어가요');
        return next;
      }
      if (to === this.deps.homeAccount || to === this.deps.protectedAccount) {
        say(`${this.label(to)} 계정(Desktop)에 따로 이어진 대화가 있어 그 사본은 그대로 두었어요 — ${this.label(state.account)} 계정에서 이어가요`);
        return null;
      }
      const refuse = [this.deps.homeAccount, this.deps.protectedAccount].filter((a): a is Account => !!a).map((a) => this.rootOf(a));
      const f = await this.replaceDiverged({ ...req, refuseProjectsRoots: refuse, move: this.move });
      if (f.ok) {
        r = f.move;
        console.log(`deck: ${state.sessionId} 의 ${this.label(to)} 계정 사본이 갈라져 백업(${f.backupDir}) 뒤 덮어씀`);
        replaced = `${this.label(to)} 계정에 따로 이어진 사본이 있어 백업해 두고 이 대화로 덮어썼어요 (백업: ${f.backupDir} — 자동 정리되지 않아요)`;
        if (f.keptAside.length) {
          console.error(`deck: ${state.sessionId} 의 옮겨 둔 원래 사본이 백업 뒤에 바뀌어 지우지 않음: ${f.keptAside.join(', ')}`);
          replaced += ' (옮기는 사이 바뀐 원래 사본은 지우지 않고 남겨 두었어요)';
        }
      } else {
        console.error(`deck: replacing the diverged copy of ${state.sessionId} in ${this.label(to)} failed (${f.restored ? 'restored' : 'NOT restored'}, backup ${f.backupDir ?? '-'}): ${f.error}`);
        r = { ok: false, error: f.restored ? f.error : `${f.error} · 백업: ${f.backupDir ?? '없음'}` };
      }
    }
    if (!r.ok) {
      say(`세션을 ${this.label(to)} 계정으로 옮기지 못해 ${this.label(state.account)} 계정에서 이어가요 (${r.error})`);
      return null;
    }
    const next = { ...state, account: to, projectDir: r.targetDir };
    await this.deps.store.set(next);
    if (replaced) say(replaced);
    return next;
  }

  /**
   * 메시지 편집 갈래 when the parent's account cannot take the turn: the parent is copied into `to`'s profile by the
   * safe mover (source never written) and the fork made from that copy. The parent itself is not relocated: its stored
   * state keeps its account and folder.
   */
  private async copyForFork(state: ClaudeSessionState, to: Account, say: (message: string) => void, why = `${this.label(state.account)} 계정을 지금 쓸 수 없어`): Promise<ClaudeSessionState | null> {
    const r = await this.move({ sessionId: state.sessionId, sourceProjectDir: state.projectDir, targetProjectsRoot: this.rootOf(to) });
    if (!r.ok) {
      say(`갈래를 ${this.label(to)} 계정에 만들지 못해 ${this.label(state.account)} 계정에서 만들어요 (${r.error})`);
      return null;
    }
    say(`${why} 대화를 ${this.label(to)} 계정에 복사해 갈래를 만들어요 — 원래 대화는 ${this.label(state.account)} 계정에 그대로 있어요`);
    return { ...state, account: to, projectDir: r.targetDir };
  }

  /**
   * A copy of the session (deck's or another profile's) was written in the last 2 minutes, after deck's own
   * last turn or write, with no deck process holding it: Desktop or a CLI probably has it open. Stat only.
   * Returns how long ago the newest such copy was written, else null.
   */
  private async openElsewhere(state: ClaudeSessionState): Promise<number | null> {
    if (this.live.has(state.sessionId)) return null;
    const now = this.now();
    const copies = await findCopies(this.deps.projectsRoots, state.sessionId, state.projectDir, state.account).catch(() => []);
    // A clearly future mtime is clock skew, not a writer.
    const ages = copies.filter((c) => {
      const deckAt = Math.max(state.lastTurnAtMs ?? 0, this.deckWroteAt.get(path.resolve(c.file)) ?? 0);
      return now - c.mtimeMs < 120_000 && now - c.mtimeMs > -5_000 && c.mtimeMs > deckAt + 5_000;
    }).map((c) => Math.max(0, now - c.mtimeMs));
    return ages.length ? Math.min(...ages) : null;
  }

  private async attempt(p: TurnParams, account: Account, model: ClaudeModel, cwd: string, resumeSessionId: string | null, forkAt: string | null, sink: TurnSink, grants: SessionGrants, modeRef: ModeRef, attachments: Attachment[], cur: Cursor): Promise<Attempt> {
    const scope = () => ({ turnId: cur.turnId, sessionId: out.sessionId, cwd });
    // The effort applies to the resolved model (a Fable → Opus downgrade keeps it when Opus supports it).
    const effort = effortFor(model, p.effort);
    const events = this.deps.engine.runTurn({
      account,
      cwd,
      resumeSessionId,
      ...(forkAt ? { forkAt } : {}),
      model,
      ...(effort ? { effort } : {}),
      prompt: p.text,
      attachments,
      signal: sink.signal,
      allowRules: [...grants.rules],
      allowDirs: [...grants.dirs],
      ...(sdkPermMode(modeRef.mode) !== 'default' ? { permissionMode: sdkPermMode(modeRef.mode) as 'acceptEdits' | 'plan' } : {}),
      onPermission: async (pr) => {
        const decision = await sink.askPermission({ turnId: cur.turnId, sessionId: out.sessionId, cwd, ...pr });
        if (pr.toolName === 'ExitPlanMode') {
          // The plan card: 'session' = approve with edits auto-accepted, 'once' = approve and ask every time.
          if (decision !== 'deny') await this.applyMode(out.sessionId, modeRef, decision === 'session' ? 'acceptEdits' : 'default');
        } else if (decision === 'session') {
          addGrants(grants, pr);
          // The engine hands the SDK this setMode from whatever mode the turn is in (plan included): deck follows it.
          if (modeRef.mode !== 'acceptEdits' && sessionUpdates(pr).some((u) => u.type === 'setMode' && u.mode === 'acceptEdits')) await this.applyMode(out.sessionId, modeRef, 'acceptEdits');
        }
        // Review M6: the audit log is best-effort; losing it must not lose the user's answer.
        try {
          await appendAudit(this.deps.auditFile, { ts: new Date(this.now()).toISOString(), turnId: cur.turnId, sessionId: out.sessionId, toolName: pr.toolName, decision, source: 'user', inputSha256: hashInput(pr.input) });
        } catch (err) {
          console.error('deck: audit log write failed', err instanceof Error ? err.message : err);
        }
        return decision;
      },
      // 모두 자동 승인 is read per call, so a mode change mid-turn applies to the next tool call.
      autoApprove: () => modeRef.mode === 'bypassPermissions',
      onAutoApproved: async (pr) => {
        try {
          await appendAudit(this.deps.auditFile, { ts: new Date(this.now()).toISOString(), turnId: cur.turnId, sessionId: out.sessionId, toolName: pr.toolName, decision: 'auto', source: 'auto', inputSha256: hashInput(pr.input) });
        } catch (err) {
          console.error('deck: audit log write failed', err instanceof Error ? err.message : err);
        }
      },
      // Every other tool call (run or refused by a rule / the mode without a prompt, or by the handoff hook): one line each.
      onToolAudit: async (t) => {
        try {
          await appendAudit(this.deps.auditFile, { ts: new Date(this.now()).toISOString(), turnId: cur.turnId, sessionId: out.sessionId, toolName: t.toolName, decision: t.decision, source: t.source, inputSha256: hashInput(t.input) });
        } catch (err) {
          console.error('deck: audit log write failed', err instanceof Error ? err.message : err);
        }
      },
      onQuestion: async (q) => {
        const answers = await sink.askQuestion({ turnId: cur.turnId, sessionId: out.sessionId, cwd, ...q });
        try {
          await appendAudit(this.deps.auditFile, { ts: new Date(this.now()).toISOString(), turnId: cur.turnId, sessionId: out.sessionId, toolName: 'AskUserQuestion', decision: answers ? 'answered' : 'deny', source: 'user', inputSha256: hashInput(q.questions) });
        } catch (err) {
          console.error('deck: audit log write failed', err instanceof Error ? err.message : err);
        }
        return answers;
      },
      onQuestionMalformed: async (input) => {
        try {
          const questions = input && typeof input === 'object' ? (input as { questions?: unknown }).questions : input;
          await appendAudit(this.deps.auditFile, { ts: new Date(this.now()).toISOString(), turnId: cur.turnId, sessionId: out.sessionId, toolName: 'AskUserQuestion', decision: 'deny', source: 'deck', inputSha256: hashInput(questions) });
        } catch (err) {
          console.error('deck: audit log write failed', err instanceof Error ? err.message : err);
        }
      },
      onLive: (l) => { out.live = l; this.inputs.set(p.turnId, l); },
      ...(p.handoff ? { noTools: true } : {}),
    });
    const rest = events[Symbol.asyncIterator]();
    // A fork's id is the one init reports, never the parent's.
    const out: Attempt = { result: null, rateLimit: null, sessionId: forkAt ? null : resumeSessionId, compacted: false, initCwd: null, rest, live: null, bgTasks: [] };
    this.modes.set(p.turnId, { ref: modeRef, sessionId: () => out.sessionId });
    // The first result ends the attempt; whatever follows (background continuations) is `rest`.
    const { emitThinking, flushThinking } = this.thinkingStream(sink, scope);
    try {
      while (!out.result) {
        const n = await rest.next();
        if (n.done) break;
        const ev = n.value;
        if (!holdsThinking(ev)) flushThinking();
        switch (ev.kind) {
          case 'init': out.sessionId = ev.sessionId; if (ev.cwd) out.initCwd = ev.cwd; break;
          case 'background': out.bgTasks = ev.tasks; sink.emit({ type: 'turn_background', ...scope(), tasks: ev.tasks, ...this.bgExtra(p.turnId, ev.detail) }); break;
          case 'continue': break;
          case 'progress': sink.emit({ type: 'turn_progress', ...scope(), outputTokens: ev.outputTokens, phase: ev.phase }); break;
          case 'sub_tool_call': sink.emit({ type: 'sub_tool_call', ...scope(), parentToolUseId: ev.parentToolUseId, toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
          case 'sub_tool_result': sink.emit({ type: 'sub_tool_result', ...scope(), parentToolUseId: ev.parentToolUseId, toolUseId: ev.toolUseId, isError: ev.isError }); break;
          case 'task_update': { const { kind: _k, ...u } = ev; sink.emit({ type: 'task_update', ...scope(), ...u, ...(u.summary ? { summary: redactSecrets(u.summary) } : {}) }); break; }
          case 'delta': sink.emit({ type: 'delta', ...scope(), text: ev.text }); break;
          case 'thinking': emitThinking(ev); break;
          case 'tool_call': sink.emit({ type: 'tool_call', ...scope(), toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
          case 'tool_result': sink.emit({ type: 'tool_result', ...scope(), toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }); break;
          case 'rate_limit':
            out.rateLimit = ev.info;
            this.deps.usage.applyTurn(account, { ...(ev.info.fiveHour ? { fiveHour: ev.info.fiveHour } : {}), ...(ev.info.weekly ? { weekly: ev.info.weekly } : {}) });
            break;
          case 'compact': out.compacted = true; break;
          case 'notice': sink.emit({ type: 'turn_notice', ...scope(), message: redactSecrets(ev.message) }); break;
          case 'system': sink.emit({ type: 'turn_system', ...scope(), source: ev.source, label: ev.label, text: redactSecrets(ev.text) }); break;
          case 'task_done': sink.emit({ type: 'task_done', ...scope(), ...taskDoneOf(ev) }); break;
          case 'steer_delivered': this.steerDelivered(p.turnId, ev.id, sink, scope()); break;
          case 'result': out.result = ev; if (ev.sessionId) out.sessionId = ev.sessionId; break;
        }
      }
    } finally {
      // also when the engine stream throws: the held tail goes out (redacted), never lost
      flushThinking();
    }
    return out;
  }

  /**
   * Thinking deltas redacted as one stream, so a secret split across deltas is still caught: text that
   * may still be part of a match is held until the next delta, a new block, or any other event.
   * Never emits an empty chunk for held text (empty = "a block started" to the UI).
   */
  private thinkingStream(sink: TurnSink, scope: () => { turnId: string; sessionId: string | null; cwd: string }) {
    const r = new StreamRedactor();
    const flushThinking = () => { const text = r.flush(); if (text) sink.emit({ type: 'thinking', ...scope(), text }); };
    const emitThinking = (ev: Extract<EngineEvent, { kind: 'thinking' }>) => {
      if (ev.text && !ev.redacted) {
        const text = r.push(ev.text);
        if (text) sink.emit({ type: 'thinking', ...scope(), text });
        return;
      }
      flushThinking();
      sink.emit({ type: 'thinking', ...scope(), text: redactSecrets(ev.text), ...(ev.redacted ? { redacted: true } : {}) });
    };
    return { emitThinking, flushThinking };
  }

  /**
   * After the turn's own result: while the process stays open for background work, stream what
   * it does next into the same pane. Each later result closes a segment — a background
   * continuation (new turn id `<turnId>:bg<n>`, reason 백그라운드 계속) or a follow-up the user
   * sent meanwhile (its own turn id). Ends when the engine stream ends (no live task left, cap,
   * grace, abort).
   */
  private async followThrough(c: { p: TurnParams; a: Attempt; cur: Cursor; sink: TurnSink; account: Account; model: ClaudeModel; cwd: string; sessionId: string; grants: SessionGrants; startedAt: number }): Promise<void> {
    const { p, a, cur, sink, account, model, cwd, sessionId, grants, startedAt } = c;
    const scope = () => ({ turnId: cur.turnId, sessionId, cwd });
    type Seg = { turnId: string; reason: string; modelNote: string | null };
    let seg: Seg | null = null;
    let n = 0;
    let steered = 0;
    let tasks = a.bgTasks;
    const queue: { f: FollowUpParams; attachments: Attachment[] }[] = [];
    const open = (turnId: string, reason: string, modelNote: string | null, clientRef?: string) => {
      seg = { turnId, reason, modelNote };
      cur.turnId = turnId;
      sink.emit({ type: 'turn_started', turnId, sessionId, cwd, account, model, reason, attempt: 0, engine: 'claude', ...(clientRef ? { clientRef } : {}) });
    };
    const openBackground = () => {
      open(`${p.turnId}:bg${++n}`, '백그라운드 계속', null);
      sink.emit({ type: 'turn_notice', ...scope(), message: '백그라운드 계속 — 백그라운드 작업이 끝나 이어서 진행합니다' });
    };
    const sendFollowUp = (f: FollowUpParams, attachments: Attachment[]) => {
      const note = isClaudeModel(f.model) && f.model !== model ? '백그라운드 대기 중인 프로세스의 모델 유지' : null;
      open(f.turnId, '백그라운드 대기 중 이어 보냄', note, f.clientRef);
      const turnId = f.turnId;
      // Its turn_started recorded the ref as accepted: an error carrying it takes that back (ws), so a resent copy goes in.
      const failed = (errorText: string) => {
        seg = null;
        sink.emit({ type: 'turn_result', turnId, sessionId, cwd, ok: false, text: '', badge: null, errorText });
        if (f.clientRef) sink.emit({ type: 'error', turnId, message: errorText, clientRef: f.clientRef });
      };
      void (a.live?.send({ text: f.text, attachments }) ?? Promise.resolve(false)).then((ok) => {
        if (ok || seg?.turnId !== turnId) return;
        failed('세션 프로세스가 방금 끝나 보내지 못했습니다 — 다시 보내 주세요');
      }, () => {
        if (seg?.turnId !== turnId) return;
        failed('메시지를 보내지 못했습니다');
      });
    };
    const saveState = async (ok: boolean) => {
      const st = this.deps.store.get(sessionId);
      if (!st || isCodexState(st) || isGeminiState(st)) return;
      await this.deps.store.set({
        ...st,
        ...(ok ? { lastTurnAtMs: this.now() } : {}),
        ...(grants.rules.length ? { allowRules: [...grants.rules] } : {}),
        ...(grants.dirs.length ? { allowDirs: [...grants.dirs] } : {}),
      });
    };
    // Follow-ups are taken only while background work holds the process open (else it closes right after this result).
    if (a.live && a.bgTasks.length) {
      this.live.set(sessionId, {
        since: startedAt,
        clean: new Map(),
        submit: (f, attachments) => {
          if (seg) queue.push({ f, attachments });
          else sendFollowUp(f, attachments);
          return true;
        },
      });
    }
    const { emitThinking, flushThinking } = this.thinkingStream(sink, scope);
    try {
      for (;;) {
        const next = await a.rest.next();
        if (next.done) break;
        const ev = next.value;
        // Held thinking text belongs to the segment it streamed in: out before any other event (or a new segment).
        if (!holdsThinking(ev)) flushThinking();
        // Output with no segment open (e.g. a continuation racing a follow-up) still gets a turn of its own.
        const needSeg = ev.kind === 'delta' || ev.kind === 'tool_call' || ev.kind === 'tool_result' || ev.kind === 'result';
        // A steer the CLI ran as its own turn (no tool boundary came before the result): a segment of its own.
        if (ev.kind === 'steer_delivered' && !seg) open(`${p.turnId}:s${++steered}`, '실행 중 보낸 메시지', null);
        if ((ev.kind === 'continue' && !seg) || (needSeg && !seg)) openBackground();
        switch (ev.kind) {
          case 'steer_delivered': this.steerDelivered(p.turnId, ev.id, sink, scope()); break;
          case 'background': tasks = ev.tasks; sink.emit({ type: 'turn_background', ...scope(), tasks, ...this.bgExtra(p.turnId, ev.detail) }); break;
          case 'progress': if (seg) sink.emit({ type: 'turn_progress', ...scope(), outputTokens: ev.outputTokens, phase: ev.phase }); break;
          case 'sub_tool_call': sink.emit({ type: 'sub_tool_call', ...scope(), parentToolUseId: ev.parentToolUseId, toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
          case 'sub_tool_result': sink.emit({ type: 'sub_tool_result', ...scope(), parentToolUseId: ev.parentToolUseId, toolUseId: ev.toolUseId, isError: ev.isError }); break;
          case 'task_update': { const { kind: _k, ...u } = ev; sink.emit({ type: 'task_update', ...scope(), ...u, ...(u.summary ? { summary: redactSecrets(u.summary) } : {}) }); break; }
          case 'delta': sink.emit({ type: 'delta', ...scope(), text: ev.text }); break;
          case 'thinking': emitThinking(ev); break;
          case 'tool_call': sink.emit({ type: 'tool_call', ...scope(), toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
          case 'tool_result': sink.emit({ type: 'tool_result', ...scope(), toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }); break;
          case 'notice': sink.emit({ type: 'turn_notice', ...scope(), message: redactSecrets(ev.message) }); break;
          case 'system': sink.emit({ type: 'turn_system', ...scope(), source: ev.source, label: ev.label, text: redactSecrets(ev.text) }); break;
          // A background task settled while the process waits: the push (PushNotifier) fires here, not only inside the turn.
          case 'task_done': sink.emit({ type: 'task_done', ...scope(), ...taskDoneOf(ev) }); break;
          case 'rate_limit': this.deps.usage.applyTurn(account, { ...(ev.info.fiveHour ? { fiveHour: ev.info.fiveHour } : {}), ...(ev.info.weekly ? { weekly: ev.info.weekly } : {}) }); break;
          case 'result': {
            const s = seg as Seg | null;
            seg = null;
            if (s) {
              sink.emit({ type: 'turn_result', turnId: s.turnId, sessionId, cwd, ok: ev.ok, text: ev.text, badge: { account, model, reason: s.reason, usage: ev.usage, modelNote: s.modelNote }, errorText: ev.ok ? null : sink.signal.aborted ? abortedText(sink.signal) : displayError(ev.errorText, ev.stderr) });
            }
            await saveState(ev.ok);
            this.mirrorSoon(sessionId, sink, s?.turnId ?? cur.turnId);
            // Sent before the engine resumes, so it sees the message outstanding and keeps the input open.
            const q = queue.shift();
            if (q) sendFollowUp(q.f, q.attachments);
            break;
          }
          case 'init': case 'compact': case 'continue': break;
        }
      }
    } finally {
      flushThinking();
      this.live.delete(sessionId);
      const s = seg as Seg | null;
      if (s) sink.emit({ type: 'turn_result', turnId: s.turnId, sessionId, cwd, ok: false, text: '', badge: { account, model, reason: s.reason, usage: ZERO_USAGE, modelNote: s.modelNote }, errorText: sink.signal.aborted ? abortedText(sink.signal) : '결과 없이 끝났습니다' });
      for (const q of queue) sink.emit({ type: 'error', turnId: q.f.turnId, message: '세션 프로세스가 끝나 보내지 못했습니다 — 다시 보내 주세요', ...(q.f.clientRef ? { clientRef: q.f.clientRef } : {}) });
      if (tasks.length) sink.emit({ type: 'turn_background', ...scope(), tasks: [], detail: [] });
    }
  }

  /**
   * Review I7: the directory the jsonl really lives in. The CLI slugs its realpath'd cwd
   * (and NFC/NFD spellings of the same name differ), so a guess from our cwd string is only
   * a candidate: confirm the file is there, else look for it under the account's root.
   */
  private async locateProjectDir(sessionId: string, account: Account, candidate: string): Promise<string> {
    if (await exists(path.join(candidate, `${sessionId}.jsonl`))) return candidate;
    const root = this.rootOf(account);
    const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const d of dirs) {
      if (d.isDirectory() && (await exists(path.join(root, d.name, `${sessionId}.jsonl`)))) return path.join(root, d.name);
    }
    return candidate;
  }

  async run(p: TurnParams, sink: TurnSink): Promise<void> {
    const { deps } = this;
    // D7: only store-resolved attachments (server-side paths in the private dir) ever reach an engine.
    let attachments: Attachment[] = [];
    if (p.attachments?.length) {
      const ids = [...new Set(p.attachments)];
      const r = deps.attachments?.resolve(ids) ?? { found: [], missing: ids };
      if (r.missing.length) { sink.emit({ type: 'error', turnId: p.turnId, message: `첨부를 찾을 수 없습니다: ${r.missing.join(', ')}` }); return; }
      attachments = r.found;
    }
    let state: SessionState | null = null;
    let notice: string | null = null;
    if (p.fork && !p.sessionId) {
      // 메시지 편집 갈래: a Claude session only (Codex / Gemini cannot resume at an entry).
      const st = deps.store.get(p.fork.from);
      const e = st ? null : deps.index.lookup(p.fork.from);
      const parent: SessionState | null = st ?? (e && !(e.account === 'gpt' || isGeminiAccount(e.account)) ? { sessionId: e.sessionId, cwd: e.cwd, account: e.account, projectDir: e.projectDir, lastTurnAtMs: null, justCompacted: false, defaultModel: IMPORTED_DEFAULT_MODEL } : null);
      if (!parent || isCodexState(parent) || isGeminiState(parent)) { sink.emit({ type: 'error', turnId: p.turnId, message: `편집할 Claude 세션을 찾을 수 없습니다: ${p.fork.from}` }); return; }
      return this.runClaude(p, parent, sink, '메시지 편집', attachments);
    }
    if (p.sessionId) {
      state = deps.store.get(p.sessionId);
      // A deck Codex thread Codex has since archived (its rollout moved to archived_sessions): view only, like an archived import.
      if (state && isCodexState(state) && (await deps.index.freshCodexImport(p.sessionId))?.codexArchived) { sink.emit({ type: 'error', turnId: p.turnId, message: CODEX_ARCHIVED_NOTICE }); return; }
      // Checked live: a thread archived / unarchived in Codex or a folder that came back since the last scan is rescanned first.
      const imported = state ? null : await deps.index.freshCodexImport(p.sessionId);
      if (imported) {
        // Folder gone (codex cannot spawn there) or archived in Codex (resume by id is not assured): view only.
        const blocked = await importBlockReason(imported);
        if (blocked) { sink.emit({ type: 'error', turnId: p.turnId, message: blocked }); return; }
        // A Codex Desktop / CLI thread: resumed in its own cwd under deck's sandbox; stored as a deck Codex session after this turn.
        state = {
          engine: 'codex', sessionId: imported.sessionId, cwd: imported.cwd, lastTurnAtMs: null, justCompacted: false,
          defaultModel: isCodexModel(p.model) ? p.model : DEFAULT_CODEX_MODEL, sandbox: p.sandbox ?? defaultSandbox(this.defaultMode() === 'bypassPermissions'),
          rolloutFile: imported.file, createdAtMs: this.now(), title: imported.title,
        };
        const age = await rolloutActiveAgeMs(imported.file, this.now());
        if (age !== null) notice = liveRolloutNotice(imported.title, age);
      } else if (!state) {
        const e = deps.index.lookup(p.sessionId);
        // Codex sessions always have a state entry (D4); a 'gpt' index entry without one is a bug, not a resumable session.
        if (!e || e.account === 'gpt' || isGeminiAccount(e.account)) { sink.emit({ type: 'error', turnId: p.turnId, message: `세션을 찾을 수 없습니다: ${p.sessionId}` }); return; }
        state = { sessionId: e.sessionId, cwd: e.cwd, account: e.account, projectDir: e.projectDir, lastTurnAtMs: null, justCompacted: false, defaultModel: IMPORTED_DEFAULT_MODEL };
      }
    }
    if (state && isCodexState(state)) return this.runCodex(p, state, sink, 'GPT 세션', attachments, notice);
    if (state && isGeminiState(state)) return this.runGemini(p, state, sink, `Gemini 세션 · ${GEMINI_LABEL[state.account]}`, attachments);
    // Gemini is explicit only: chooseEngine (자동) never sees it.
    if (!state && p.engine === 'gemini') return this.runGemini(p, null, sink, 'Gemini 지정', attachments);
    if (!state) {
      const pick = chooseEngine({
        choice: p.engine ?? 'claude', usage: deps.usage.routingSnapshot(), nowMs: this.now(), codexAvailable: deps.codex !== null,
        gptCooldownUntilMs: this.gptCooldownUntil, cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, this.now(), this.accounts.list()), protectedAccount: deps.protectedAccount, accounts: this.accounts,
      });
      if (pick.engine === 'codex') return this.runCodex(p, null, sink, pick.reason, attachments);
      // Only a non-default choice earns a prefix, so Plan 1 badges read exactly as before.
      const enginePrefix = p.engine && p.engine !== 'claude' ? pick.reason : null;
      if (p.model === 'auto') {
        // 자동: decided once, here, for the new session; later turns keep it as the session default (prompt cache).
        const auto = chooseAutoModel({ text: p.text, attachmentCount: attachments.length, usage: deps.usage.routingSnapshot(), nowMs: this.now(), cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, this.now(), this.accounts.list()), protectedAccount: deps.protectedAccount, accounts: this.accounts });
        return this.runClaude({ ...p, model: auto.model, effort: p.effort ?? auto.effort }, null, sink, enginePrefix ? `${enginePrefix} · ${auto.reason}` : auto.reason, attachments, auto.model);
      }
      return this.runClaude(p, null, sink, enginePrefix, attachments);
    }
    return this.runClaude(p, state, sink, null, attachments);
  }

  /** D2/D3: one ChatGPT account — no routing, no session move, no retry; sandbox + approval never. */
  private async runCodex(p: TurnParams, state: CodexSessionState | null, sink: TurnSink, reason: string, attachments: Attachment[], notice: string | null = null): Promise<void> {
    const { deps } = this;
    const cwd = state?.cwd ?? p.cwd;
    // A per-turn Codex model wins on resume too (like Claude's per-turn model); the session's stored default is kept.
    const model: CodexModel = isCodexModel(p.model) ? p.model : (state?.defaultModel ?? DEFAULT_CODEX_MODEL);
    const sandbox: CodexSandbox = state?.sandbox ?? p.sandbox ?? defaultSandbox(this.defaultMode() === 'bypassPermissions');
    // Task 2 follow-up: the id is either the stored one (itself CLI-reported) or what the CLI reports via init
    // (thread.started) — never the result's sessionId, which echoes a rejected resume id.
    let sessionId: string | null = state?.sessionId ?? null;
    const scope = () => ({ turnId: p.turnId, sessionId, cwd });
    const badge = (usage: TurnUsage) => ({ account: 'gpt' as const, model, reason, usage, modelNote: null });
    if (!deps.codex) { sink.emit({ type: 'turn_result', ...scope(), ok: false, text: '', badge: badge(ZERO_USAGE), errorText: 'codex CLI 를 찾을 수 없습니다' }); return; }
    if (sink.signal.aborted) { sink.emit({ type: 'turn_result', ...scope(), ok: false, text: '', badge: badge(ZERO_USAGE), errorText: abortedText(sink.signal) }); return; }
    sink.emit({ type: 'turn_started', ...scope(), account: 'gpt', model, reason, attempt: 0, engine: 'codex' });
    if (notice) sink.emit({ type: 'turn_notice', ...scope(), message: notice });
    let result: EngineResult | null = null;
    const effort = effortFor(model, p.effort);
    const createdAtMs = state?.createdAtMs ?? this.now();
    for await (const ev of deps.codex.runTurn({ cwd, resumeThreadId: state?.sessionId ?? null, model, sandbox, ...(effort ? { effort } : {}), prompt: promptWithFiles(p.text, attachments), imagePaths: attachments.filter((a) => a.isImage).map((a) => a.path), signal: sink.signal })) {
      switch (ev.kind) {
        case 'init':
          sessionId = ev.sessionId;
          // A new thread is recorded as soon as the CLI names it: its rollout is a `codex exec` one, and the
          // import list (자동 실행) must not show deck's own thread while this first turn is still running.
          if (!state && !deps.store.get(sessionId)) {
            await deps.store.set({
              engine: 'codex', sessionId, cwd, lastTurnAtMs: null, justCompacted: false, defaultModel: model, sandbox,
              rolloutFile: null, createdAtMs, title: titleOf(p.text),
            }).catch((err: unknown) => console.error('deck: recording the new Codex thread failed', err instanceof Error ? err.message : err));
          }
          break;
        case 'delta': sink.emit({ type: 'delta', ...scope(), text: ev.text }); break;
        case 'tool_call': sink.emit({ type: 'tool_call', ...scope(), toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
        case 'tool_result': sink.emit({ type: 'tool_result', ...scope(), toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }); break;
        case 'notice': sink.emit({ type: 'turn_notice', ...scope(), message: redactSecrets(ev.message) }); break;
        case 'result': result = ev; break;
        case 'rate_limit': case 'compact': case 'task_done': case 'background': case 'continue': case 'progress': case 'sub_tool_call': case 'sub_tool_result': case 'task_update': case 'system': break;
      }
    }
    const res: EngineResult = result ?? { kind: 'result', sessionId, ok: false, text: '', usage: ZERO_USAGE, errorText: '엔진이 결과 없이 종료했습니다', stderr: null, errorKind: null, terminalReason: null };
    if (sessionId) {
      const rolloutFile = state?.rolloutFile ?? (await this.findRollout(deps.codexSessionsRoot, sessionId).catch(() => null));
      const next: CodexSessionState = {
        engine: 'codex', sessionId, cwd, lastTurnAtMs: res.ok ? this.now() : (state?.lastTurnAtMs ?? null), justCompacted: false,
        defaultModel: state?.defaultModel ?? model, sandbox, rolloutFile, createdAtMs, title: state?.title ?? titleOf(p.text),
      };
      await deps.store.set(next);
      // D5: the rollout's token_count.rate_limits is the only per-turn GPT usage signal.
      if (rolloutFile) {
        const w = await this.readRateLimits(rolloutFile).catch(() => null);
        if (w) deps.usage.applyTurn('gpt', w);
      }
    }
    if (!res.ok && classifyFailure({ ok: false, errorText: res.errorText, errorKind: res.errorKind, rateLimitStatus: null }) === 'limit') this.gptCooldownUntil = this.now() + COOLDOWN_MS.limit;
    sink.emit({ type: 'turn_result', ...scope(), ok: res.ok, text: res.text, badge: badge(res.usage), errorText: res.ok ? null : sink.signal.aborted ? abortedText(sink.signal) : displayError(res.errorText, res.stderr) });
  }

  /** Explicit Gemini: a new session takes the first logged-in, non-cooled account (g1, then g2) and stays on it. */
  private async runGemini(p: TurnParams, state: GeminiSessionState | null, sink: TurnSink, reason: string, attachments: Attachment[]): Promise<void> {
    const { deps } = this;
    const cwd = state?.cwd ?? p.cwd;
    const model: GeminiModel = isGeminiModel(p.model) ? p.model : (state?.defaultModel ?? DEFAULT_GEMINI_MODEL);
    const sandbox: CodexSandbox = state?.sandbox ?? p.sandbox ?? defaultSandbox(this.defaultMode() === 'bypassPermissions');
    let sessionId: string | null = state?.sessionId ?? null;
    const scope = () => ({ turnId: p.turnId, sessionId, cwd });
    const fail = (account: GeminiAccount, errorText: string) =>
      sink.emit({ type: 'turn_result', ...scope(), ok: false, text: '', badge: { account, model, reason, usage: ZERO_USAGE, modelNote: null }, errorText });
    const gem = deps.gemini;
    if (!gem) { fail(state?.account ?? 'g1', 'gemini CLI 를 찾을 수 없습니다'); return; }
    let account: GeminiAccount;
    if (state) {
      account = state.account;
      if (!gem.loggedIn(account)) { fail(account, `Gemini ${GEMINI_LABEL[account]} 로그인 필요`); return; }
    } else {
      const loggedIn = GEMINI_ACCOUNTS.filter((a) => gem.loggedIn(a));
      if (!loggedIn.length) { fail('g1', 'Gemini 로그인 필요 (docs/gemini-spike.md)'); return; }
      const free = loggedIn.find((a) => (this.geminiCooldownUntil[a] ?? 0) <= this.now());
      account = free ?? loggedIn[0]!;
      reason = `${reason} · ${GEMINI_LABEL[account]}${free ? '' : ' (모두 쿨다운)'}`;
    }
    const badge = (usage: TurnUsage) => ({ account, model, reason, usage, modelNote: null });
    if (sink.signal.aborted) { fail(account, abortedText(sink.signal)); return; }
    sink.emit({ type: 'turn_started', ...scope(), account, model, reason, attempt: 0, engine: 'gemini' });
    let result: EngineResult | null = null;
    for await (const ev of gem.engine.runTurn({ account, cwd, resumeSessionId: state?.sessionId ?? null, model, sandbox, prompt: promptWithFiles(p.text, attachments), signal: sink.signal })) {
      switch (ev.kind) {
        case 'init': sessionId = ev.sessionId; break;
        case 'delta': sink.emit({ type: 'delta', ...scope(), text: ev.text }); break;
        case 'tool_call': sink.emit({ type: 'tool_call', ...scope(), toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
        case 'tool_result': sink.emit({ type: 'tool_result', ...scope(), toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }); break;
        case 'notice': sink.emit({ type: 'turn_notice', ...scope(), message: redactSecrets(ev.message) }); break;
        case 'result': result = ev; break;
        case 'rate_limit': case 'compact': break;
      }
    }
    const res: EngineResult = result ?? { kind: 'result', sessionId, ok: false, text: '', usage: ZERO_USAGE, errorText: '엔진이 결과 없이 종료했습니다', stderr: null, errorKind: null, terminalReason: null };
    // Only an id the CLI reported (init) is stored, never a rejected resume id echoed back.
    if (sessionId) {
      await deps.store.set({
        engine: 'gemini', account, sessionId, cwd, lastTurnAtMs: res.ok ? this.now() : (state?.lastTurnAtMs ?? null), justCompacted: false,
        defaultModel: state?.defaultModel ?? model, sandbox, createdAtMs: state?.createdAtMs ?? this.now(), title: state?.title ?? titleOf(p.text),
      });
    }
    if (!res.ok && GEMINI_LIMIT_RE.test(res.errorText ?? '')) this.geminiCooldownUntil[account] = this.now() + COOLDOWN_MS.limit;
    sink.emit({ type: 'turn_result', ...scope(), ok: res.ok, text: res.text, badge: badge(res.usage), errorText: res.ok ? null : sink.signal.aborted ? abortedText(sink.signal) : displayError(res.errorText, res.stderr) });
  }

  private async runClaude(p: TurnParams, state: ClaudeSessionState | null, sink: TurnSink, enginePrefix: string | null, attachments: Attachment[], newSessionModel?: ClaudeModel): Promise<void> {
    const id = state?.sessionId;
    if (id) this.active.set(id, (this.active.get(id) ?? 0) + 1);
    // Notices before the turn has started would have no turn item to attach to (the UI shows them as an error).
    const early: string[] = [];
    let end: ClaudeSessionState | null = null;
    try {
      // Read-only sessions: an account that is not configured any more, or one marked retired. A retired account's
      // sessions stay listed (and deletable); the projects dir of an account removed from the settings is not scanned
      // any more, so such a session stays listed only while another account has a copy of it.
      const readOnly = (account: Account): string | null => {
        if (!this.accounts.has(account) || !this.roots.has(account)) return `설정에 없는 계정(${this.label(account)})의 세션이라 이어갈 수 없습니다 — 이어 쓰려면 accounts.json 에 {"id": ${JSON.stringify(account)}, "configDir": "그 계정의 설정 폴더"} 를 추가하고 deck 을 다시 시작하세요. 필요 없는 세션이면 삭제해도 됩니다.`;
        if (this.accounts.isRetired(account)) return `${this.label(account)} 계정은 뺀 계정(retired)이라 이 세션을 이어갈 수 없습니다 — 기록은 그대로 볼 수 있습니다. 이어 쓰려면 accounts.json 에서 이 계정의 "retired" 를 지우고 deck 을 다시 시작하거나, 새 세션에서 이어가세요.`;
        return null;
      };
      let refused = state ? readOnly(state.account) : null;
      if (state && !refused) {
        // A write-back still copying this session finishes first (it must not see the next turn's writes).
        await this.mirrors.get(state.sessionId);
        state = await this.reconcile(state, (m) => early.push(m));
        // The copy check reads retired accounts' dirs too: the newest copy may have put the session on one.
        // Intended: `reconcile` has stored that move, so the session stays read-only from here on.
        refused = readOnly(state.account);
      }
      if (refused) {
        // What the copy check found (diverged copies, ...) goes out with the refusal instead of being dropped.
        for (const message of early.splice(0)) sink.emit({ type: 'turn_notice', turnId: p.turnId, sessionId: state?.sessionId ?? null, cwd: state?.cwd ?? p.cwd, message });
        sink.emit({ type: 'error', turnId: p.turnId, message: refused });
        return;
      }
      // A handoff-note turn denies every tool: no tool boundary to fold a steer in at, and it must stay a pure note.
      if (!p.handoff) this.steering.set(p.turnId, { pending: new Map(), ids: new Set() });
      try {
        end = await this.runClaudeTurn(p, state, sink, enginePrefix, attachments, early, newSessionModel);
      } finally {
        this.inputs.delete(p.turnId);
        this.modes.delete(p.turnId);
        this.rejectSteers(p.turnId, sink, { turnId: p.turnId, sessionId: end?.sessionId ?? state?.sessionId ?? null, cwd: end?.cwd ?? state?.cwd ?? p.cwd }, '세션 프로세스가 끝나 턴이 끝난 뒤 보냅니다');
        this.steering.delete(p.turnId);
      }
      // The final write-back at close (also after a long hold for background work).
      if (end) this.scheduleMirror(end.sessionId, sink, p.turnId);
    } finally {
      if (id) { const n = (this.active.get(id) ?? 1) - 1; if (n > 0) this.active.set(id, n); else this.active.delete(id); }
      // The CLI process has closed: whatever it wrote was deck's.
      if (end) this.deckWroteAt.set(path.resolve(end.projectDir, `${end.sessionId}.jsonl`), this.now());
    }
  }

  /** The Claude turn proper; resolves (after any background follow-through) with the session's final state. */
  private async runClaudeTurn(p: TurnParams, state: ClaudeSessionState | null, sink: TurnSink, enginePrefix: string | null, attachments: Attachment[], early: string[], newSessionModel?: ClaudeModel): Promise<ClaudeSessionState | null> {
    const { deps } = this;
    const cwd = state?.cwd ?? p.cwd;
    // The model a turn is sent with becomes the session's default (the picker's choice sticks, on every device); a send
    // without one (자동, an older client) keeps the stored default; a new one takes 자동's pick, else DEFAULT_MODEL.
    const sessionDefault = (isClaudeModel(p.model) ? p.model : null) ?? state?.defaultModel ?? newSessionModel ?? DEFAULT_MODEL;
    // 자동 on a later turn: the session keeps its model, and its auto effort unless the user picked one.
    if (p.model === 'auto' && p.effort === undefined) p = { ...p, effort: AUTO_EFFORT[sessionDefault] };
    const wantedClaude = isClaudeModel(p.model) ? p.model : undefined;
    const wanted = wantedClaude ?? sessionDefault;
    // 메시지 편집 갈래: until the CLI reports the fork's id, `state` is the parent's and its id is not this turn's.
    let forkAt = p.fork && state?.sessionId === p.fork.from ? p.fork.at : null;
    // A fork takes the parent's pin (the pane sends the same one; it covers a pin set a moment before the edit).
    const askedPin = state ? (state.accountPin ?? (forkAt ? p.accountPin : null) ?? null) : (p.accountPin ?? null);
    // A pin on an account that is not active (removed or retired since) is no pin.
    const pin = askedPin && this.accounts.list().includes(askedPin) ? askedPin : null;
    const shownId = () => (forkAt ? null : (state?.sessionId ?? null));
    const done = () => (forkAt ? null : state);
    const routerBase = { usage: deps.usage.routingSnapshot(), nowMs: this.now(), protectedAccount: deps.protectedAccount, needFable: wanted === 'fable', pinned: pin, policy: deps.routingPolicy?.() ?? 'balance', accounts: this.accounts };

    // An unpinned edit-fork runs on the parent's own account (it is not moved for a branch) unless that account is
    // unusable; a pinned one routes like any turn of the session, copying the parent to the pinned account.
    const forkFrom = forkAt && state && !pin ? state.account : null;
    const routeInput = {
      ...routerBase,
      current: state?.account ?? null,
      lastTurnAtMs: state?.lastTurnAtMs ?? null,
      justCompacted: state?.justCompacted ?? false,
      cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, this.now(), this.accounts.list()),
    };
    let first = chooseAccount(forkFrom ? { ...routeInput, pinned: forkFrom } : routeInput);
    // A fork whose pin is unusable stays on the parent's account like an unpinned one (a cold cache must not send it,
    // and a copy of the parent, to a third account); only if that one is unusable too is the parent copied elsewhere.
    let forkWhy: string | undefined;
    if (forkAt && state && pin && first.pinBlocked && pin !== state.account) {
      const stay = chooseAccount({ ...routeInput, pinned: state.account });
      if (stay.pinBlocked) forkWhy = `${this.label(pin)} 고정 계정과 ${this.label(state.account)} 계정을 지금 쓸 수 없어`;
      first = { ...stay, pinned: false, pinBlocked: first.pinBlocked, reason: `고정 ${this.label(pin)} ${first.pinBlocked} → 갈래는 ${stay.reason}` };
    }
    let account = first.account;
    // Set while the account is the router's choice for a Fable turn it routed as Opus (see RouterDecision.asOpus): its
    // reason says "→ Opus", so the turn runs on Opus whatever the usage snapshot says by the time the attempt starts.
    let asOpus = first.asOpus;
    let reason = enginePrefix ? `${enginePrefix} · ${first.reason}` : first.reason;
    const flushEarly = () => { for (const message of early.splice(0)) sink.emit({ type: 'turn_notice', turnId: p.turnId, sessionId: shownId(), cwd, message }); };
    // The badge's pin marker: the account is the pinned one because of the pin.
    let byPin = first.pinned === true && account === pin;
    if (state && account !== state.account) {
      if (byPin) forkWhy = `${this.label(account)} 계정 고정이라`;
      const moved = forkAt ? await this.copyForFork(state, account, (m) => early.push(m), forkWhy) : await this.relocate(state, account, (m) => early.push(m));
      if (moved) state = moved;
      else { account = state.account; reason = `이전 실패 · ${this.label(account)} 유지`; byPin = false; asOpus = undefined; }
    }
    // Non-blocking: the same session written moments ago by Desktop/CLI is about to be continued in two places.
    const elsewhereAge = state && !forkAt ? await this.openElsewhere(state) : null;
    if (state && elsewhereAge !== null) early.push(elsewhereNotice({ engine: 'claude', title: deps.index.lookup(state.sessionId)?.title ?? null, ageMs: elsewhereAge }));
    deps.routeLog?.(routeLogLine(state?.sessionId ?? null, { ...first, account, reason }, this.accounts));
    if (pin && first.pinBlocked && account !== pin) early.push(`${this.label(pin)} 계정 ${first.pinBlocked} — 이번 턴은 ${this.label(account)} 로 (고정은 유지)`);
    const pinMark = () => (byPin ? { pinned: true } : {});

    const tried: Account[] = [];
    const grants: SessionGrants = { rules: [...(state?.allowRules ?? [])], dirs: [...(state?.allowDirs ?? [])] };
    // Handoff turns keep the mode as is: noTools denies every call before any mode is consulted.
    const modeRef: ModeRef = { mode: (state ? state.mode : p.permissionMode) ?? this.defaultMode() };
    // A new or forked session's id reaches the clients with its turn_result; its mode follows right after (a pane only
    // adopts the id then, so a mode broadcast earlier in the turn found no pane to apply to).
    let bornId: string | null = null;
    const announceMode = () => {
      if (bornId) deps.onPermissionMode?.(bornId, this.permissionModeOf(bornId));
      bornId = null;
    };
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Review M2: an interrupt between attempts (or before the first) ends the turn here.
      if (sink.signal.aborted) {
        flushEarly();
        sink.emit({ type: 'turn_result', turnId: p.turnId, sessionId: shownId(), cwd, ok: false, text: '', badge: { account, model: wantedClaude ?? sessionDefault, reason, usage: ZERO_USAGE, modelNote: null, ...pinMark() }, errorText: abortedText(sink.signal) });
        announceMode();
        return done();
      }
      const fable = usageOf(deps.usage.snapshot(), account).fable?.usedPct ?? null;
      const resolved = resolveModel(wantedClaude, sessionDefault, fable, deps.usage.snapshot().usageSource);
      const { model, note } = asOpus && resolved.model === 'fable' ? { model: 'opus' as const, note: `${asOpus} → Opus 로 대체` } : resolved;
      sink.emit({ type: 'turn_started', turnId: p.turnId, sessionId: shownId(), cwd, account, model, reason, attempt, engine: 'claude', sessionModel: sessionDefault });
      flushEarly();

      const cur: Cursor = { turnId: p.turnId };
      const startedAt = this.now();
      const a = await this.attempt(p, account, model, cwd, state?.sessionId ?? null, forkAt, sink, grants, modeRef, attachments, cur);
      const res: EngineResult = a.result ?? { kind: 'result', sessionId: a.sessionId, ok: false, text: '', usage: ZERO_USAGE, errorText: '엔진이 결과 없이 종료했습니다', stderr: null, errorKind: null, terminalReason: null };
      const sessionId = a.sessionId ?? shownId();
      const forked = forkAt !== null;
      if (sessionId && (forked || !state)) bornId = sessionId;
      if (sessionId) {
        state = {
          sessionId,
          cwd,
          account,
          projectDir: await this.locateProjectDir(sessionId, account, state?.projectDir ?? path.join(this.rootOf(account), projectSlug(a.initCwd ?? cwd))),
          lastTurnAtMs: res.ok ? this.now() : forked ? null : (state?.lastTurnAtMs ?? null),
          justCompacted: a.compacted,
          defaultModel: sessionDefault,
          ...(grants.rules.length ? { allowRules: [...grants.rules] } : {}),
          ...(grants.dirs.length ? { allowDirs: [...grants.dirs] } : {}),
          mode: modeRef.mode,
          // Taken only by a new entry (a new session's pin); an existing entry keeps its stored pin.
          ...(pin ? { accountPin: pin } : {}),
        };
        await deps.store.set(state);
        // The fork exists now: later attempts resume it like any session.
        forkAt = null;
      }

      // The account works for deck even if its usage-deck card says setup_needed (down).
      if (res.ok) deps.usage.noteTurnOk(account);
      const failure = classifyFailure({ ok: res.ok, errorText: res.errorText, errorKind: res.errorKind, rateLimitStatus: a.rateLimit?.status ?? null });
      const badge = { account, model, reason, usage: res.usage, modelNote: note, ...pinMark() };
      const shownError = sink.signal.aborted ? abortedText(sink.signal) : displayError(res.errorText, res.stderr);
      if (res.ok || failure === 'other' || failure === null || attempt === this.maxRetries || sink.signal.aborted) {
        sink.emit({ type: 'turn_result', turnId: p.turnId, sessionId, cwd, ok: res.ok, text: res.text, badge, errorText: res.ok ? null : shownError });
        announceMode();
        // Held open for background work: write back now too, not only once at the end.
        if (sessionId && a.bgTasks.length) this.mirrorSoon(sessionId, sink, p.turnId);
        if (sessionId) await this.followThrough({ p, a, cur, sink, account, model, cwd, sessionId, grants, startedAt });
        else await a.rest.return?.();
        return done();
      }
      await a.rest.return?.();
      // The retry sends only the turn's own prompt: a steer still waiting in the closed process goes back to its device.
      this.inputs.delete(p.turnId);
      this.rejectSteers(p.turnId, sink, { turnId: p.turnId, sessionId, cwd }, '재시도 중이라 턴이 끝난 뒤 보냅니다');

      // Spec §8: limit/auth → cooldown (shared with claude-pick) → move → retry on the next account.
      writeCooldown(deps.cooldownDir, account, this.now() + COOLDOWN_MS[failure]);
      tried.push(account);
      const why = failure === 'limit' ? '한도 도달' : '인증 실패';
      // Review M1: a refused move rules that account out for this turn; ask the router again.
      let next: { account: Account; reason: string; asOpus?: string } | null = null;
      let moveRefused = false;
      for (;;) {
        const cand = chooseAccount({
          ...routerBase,
          usage: deps.usage.routingSnapshot(),
          nowMs: this.now(),
          current: account,
          lastTurnAtMs: null,
          justCompacted: false,
          cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, this.now(), this.accounts.list()),
          exclude: tried,
        });
        if (cand.account === account || tried.includes(cand.account)) break;
        if (!state) { next = cand; break; }
        const sid = shownId();
        const say = (message: string) => sink.emit({ type: 'turn_notice', turnId: p.turnId, sessionId: sid, cwd, message });
        const moved = forkAt ? await this.copyForFork(state, cand.account, say) : await this.relocate(state, cand.account, say);
        if (moved) { state = moved; next = cand; break; }
        moveRefused = true;
        tried.push(cand.account);
      }
      if (!next) {
        sink.emit({ type: 'turn_result', turnId: p.turnId, sessionId, cwd, ok: false, text: '', badge, errorText: `${why} · ${moveRefused ? '세션 이전 실패' : '대안 계정 없음'} · ${shownError ?? ''}`.trim() });
        announceMode();
        return done();
      }
      sink.emit({ type: 'turn_retry', turnId: p.turnId, sessionId: shownId() ?? sessionId, cwd, fromAccount: account, toAccount: next.account, reason: `${why} → ${next.reason}`, attempt: attempt + 1 });
      reason = `재시도(${why}) · ${next.reason}`;
      account = next.account;
      asOpus = next.asOpus;
      byPin = false;
    }
    return done();
  }
}
