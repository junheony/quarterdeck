import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { Account } from '../../shared/accounts';
import type { Attachment } from '../attachments/AttachmentStore';
import type { ClaudeModel, Effort } from '../../shared/models';
import type { PermissionDecision, Question, QuestionAnswers, TaskUpdate, TaskUsage, TurnPhase, TurnUsage } from '../../shared/turn-types';
import type { UsageWindow } from '../../shared/usage-types';

export type RateLimitSignal = {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
};

export type EngineResult = {
  kind: 'result';
  sessionId: string | null;
  ok: boolean;
  text: string;
  usage: TurnUsage;
  /** The SDK's own error text (classifier input, review M4). */
  errorText: string | null;
  /** Tail of the CLI's stderr (≤ STDERR_MAX), display only — never classified. */
  stderr: string | null;
  /** SDKAssistantMessageError value when the SDK reported one (e.g. 'rate_limit', 'authentication_failed'). */
  errorKind: string | null;
  terminalReason: string | null;
};

/** A live background task with its server-clock start (the wire form carries an age instead, `BgTaskInfo`). */
export type BgTask = { id: string; description: string; type: string; startedAtMs: number };

export type EngineEvent =
  /** `cwd` is the CLI's own (realpath'd) working directory from system/init — the one it slugs. */
  | { kind: 'init'; sessionId: string; model: string; cwd?: string }
  | { kind: 'delta'; text: string }
  /** Claude extended thinking: a text chunk of the thinking block (empty on block start); `redacted` = encrypted block, no text. */
  | { kind: 'thinking'; text: string; redacted?: boolean }
  | { kind: 'tool_call'; toolUseId: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'rate_limit'; info: RateLimitSignal }
  | { kind: 'compact' }
  /** Non-fatal engine warning shown as a turn note (Codex `item.type === 'error'` items). */
  | { kind: 'notice'; message: string }
  /** Live background tasks (Agent run_in_background, background Bash), emitted whenever the set changes; descriptions, one per task. */
  | { kind: 'background'; tasks: string[]; /** Same tasks with id, type and start (for the task popover / per-task stop). */ detail?: BgTask[] }
  /** Main-conversation output so far in this deck turn (estimate while streaming, exact at each message end) and what it is streaming. */
  | { kind: 'progress'; outputTokens: number; phase: TurnPhase }
  /** A subagent's (Agent/Task tool) own tool call, attached to the Agent call `parentToolUseId`; kept out of the main transcript. */
  | { kind: 'sub_tool_call'; parentToolUseId: string; toolUseId: string; name: string; input: unknown }
  | { kind: 'sub_tool_result'; parentToolUseId: string; toolUseId: string; isError: boolean }
  /** A task started, progressed or changed state (task_started / task_progress / task_updated). */
  | ({ kind: 'task_update' } & TaskUpdate)
  /**
   * After a result, the CLI started another turn on its own — a finished background task's
   * notification woke the model. Everything up to the next result belongs to that continuation.
   */
  | { kind: 'continue'; cause: 'background' }
  /** Claude `system/task_notification`: a background task settled. */
  | { kind: 'task_done'; status: 'completed' | 'failed' | 'stopped'; summary: string; taskId?: string; toolUseId?: string | null; usage?: TaskUsage }
  /** A steer (`LiveInput.steer`) reached the model here: the CLI echoed it back (mid-turn fold, or start of its own turn). */
  | { kind: 'steer_delivered'; id: string }
  /** A hook's message to the model mid-turn (Claude Code injects it as a synthetic user message), e.g. a Stop hook sending it back to work. */
  | { kind: 'system'; source: string; label: string; text: string }
  | EngineResult;

/** A user message sent into a still-open Claude process (background work pending). */
export type FollowUp = { text: string; attachments: Attachment[] };

/** Handed to `TurnRequest.onLive` once the process is up; `send` resolves false when the input is already closed. */
export type LiveInput = {
  send(f: FollowUp): Promise<boolean>;
  /**
   * Writes a message typed mid-turn into the running process with priority 'next': the CLI folds it in at the next
   * tool boundary (or runs it as its own turn right after). `id` comes back as a `steer_delivered` event once the model
   * has it. Resolves false when the input is closed.
   */
  steer?(f: FollowUp, id: string): Promise<boolean>;
  /** Stops one task in the process (SDK Query.stopTask); absent when the SDK handle has no stopTask. Resolves false when the input is closed. */
  stopTask?(taskId: string): Promise<boolean>;
  /** Changes the running process's permission mode (SDK Query.setPermissionMode); absent when the SDK handle lacks it. */
  setPermissionMode?(mode: 'default' | 'acceptEdits' | 'plan'): Promise<boolean>;
};

/**
 * One canUseTool call. `signal` is the SDK's per-request abort signal (the prompt must close
 * when it fires); the rest is relayed from the SDK context when present (review I4).
 */
export type PermissionRequest = {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  signal?: AbortSignal;
  /** The scoped rules the SDK proposes for "don't ask again this session". */
  suggestions?: PermissionUpdate[];
  /** The rule 이 세션 would write is broader than this ask: offer no persistent choice. */
  suppressAlwaysAllowRule?: boolean;
  title?: string;
  decisionReason?: string;
  blockedPath?: string;
  defaultToNo?: boolean;
};

/**
 * What 이 세션 returns to the SDK: the SDK's suggestions, filtered to the kinds deck carries
 * over and rewritten to `destination: 'session'`. The CLI suggests `localSettings` for Bash
 * rules, which would write `<cwd>/.claude/settings.local.json` — a permanent project rule for
 * every client. Nothing persistent is ever returned; unknown kinds are dropped, and the only
 * mode kept is `acceptEdits` (never `bypassPermissions` or anything broader).
 */
export function sessionUpdates(pr: Pick<PermissionRequest, 'suggestions' | 'suppressAlwaysAllowRule'>): PermissionUpdate[] {
  if (pr.suppressAlwaysAllowRule) return [];
  const out: PermissionUpdate[] = [];
  for (const u of pr.suggestions ?? []) {
    if (u.type === 'addRules' && u.behavior === 'allow') {
      const rules = u.rules.map((r) => (r.ruleContent !== undefined ? { toolName: r.toolName, ruleContent: r.ruleContent } : { toolName: r.toolName }));
      if (rules.length) out.push({ type: 'addRules', rules, behavior: 'allow', destination: 'session' });
    } else if (u.type === 'addDirectories') {
      if (u.directories.length) out.push({ type: 'addDirectories', directories: [...u.directories], destination: 'session' });
    } else if (u.type === 'setMode' && u.mode === 'acceptEdits') {
      out.push({ type: 'setMode', mode: 'acceptEdits', destination: 'session' });
    }
  }
  return out;
}

/** A rule as the settings `permissions.allow` syntax spells it, e.g. `Bash(git status)`. */
export function ruleString(r: { toolName: string; ruleContent?: string }): string {
  return r.ruleContent !== undefined ? `${r.toolName}(${r.ruleContent})` : r.toolName;
}

/** 이 세션 is offered only when at least one suggestion survives `sessionUpdates`. */
export function sessionAllowOffered(pr: Pick<PermissionRequest, 'suggestions' | 'suppressAlwaysAllowRule'>): boolean {
  return sessionUpdates(pr).length > 0;
}

/** The 이 세션 button text: what the choice will allow, or null when it is not offered. */
export function sessionAllowLabel(pr: Pick<PermissionRequest, 'suggestions' | 'suppressAlwaysAllowRule'>): string | null {
  const parts: string[] = [];
  for (const u of sessionUpdates(pr)) {
    if (u.type === 'addRules') for (const r of u.rules) parts.push(`\`${ruleString(r)}\``);
    else if (u.type === 'addDirectories') for (const d of u.directories) parts.push(`\`${d}\` 폴더 접근`);
    else if (u.type === 'setMode') parts.push('파일 편집');
  }
  return parts.length ? `이 세션 동안 ${[...new Set(parts)].join(', ')} 허용` : null;
}

/** D8: an AskUserQuestion call relayed to the UI; null answers = the user did not answer (→ deny). */
export type QuestionRequest = { toolUseId: string; questions: Question[]; signal?: AbortSignal };

/** Answers are keyed by question text, so texts must be unique and bounded. */
const MAX_QUESTION_CHARS = 2000;

/** AskUserQuestionInput.questions (1–4, each 2–4 options, unique texts ≤ 2000 chars) → Question[]; previews and extras dropped. Null when malformed. */
export function parseQuestions(input: unknown): Question[] | null {
  const qs = input && typeof input === 'object' ? (input as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 4) return null;
  const out: Question[] = [];
  for (const q of qs) {
    if (!q || typeof q !== 'object') return null;
    const r = q as Record<string, unknown>;
    if (typeof r.question !== 'string' || !r.question || !Array.isArray(r.options) || r.options.length < 2 || r.options.length > 4) return null;
    if (r.question.length > MAX_QUESTION_CHARS || out.some((prev) => prev.question === r.question)) return null;
    const options: Question['options'] = [];
    for (const o of r.options) {
      if (!o || typeof o !== 'object' || typeof (o as Record<string, unknown>).label !== 'string') return null;
      const d = (o as Record<string, unknown>).description;
      options.push({ label: (o as { label: string }).label, description: typeof d === 'string' ? d : '' });
    }
    out.push({ question: r.question, header: typeof r.header === 'string' ? r.header : '', options, multiSelect: r.multiSelect === true });
  }
  return out;
}

export type TurnRequest = {
  account: Account;
  cwd: string;
  resumeSessionId: string | null;
  /**
   * 메시지 편집 갈래: fork `resumeSessionId` into a new session that keeps its transcript up to and including
   * this chain entry (SDK `forkSession` + `resumeSessionAt`). The original transcript is never written.
   */
  forkAt?: string;
  model: ClaudeModel;
  /** Reasoning effort → SDK `Options.effort`; absent = the CLI's default for the model. */
  effort?: Effort;
  prompt: string;
  /** D7: resolved uploads; images → image blocks, others → `첨부 파일:` path lines. */
  attachments?: Attachment[];
  signal: AbortSignal;
  onPermission: (req: PermissionRequest) => Promise<PermissionDecision>;
  /** D8: AskUserQuestion relay; absent or null answers → the tool call is denied. */
  onQuestion?: (q: QuestionRequest) => Promise<QuestionAnswers | null>;
  /** A malformed AskUserQuestion input (parseQuestions → null): denied without asking, reported here so it is audited. */
  onQuestionMalformed?: (input: unknown) => Promise<void>;
  /** Rules (e.g. `Bash(git status)`) the user allowed for this deck session on earlier turns. */
  allowRules?: string[];
  /** Directories the user allowed for this deck session on earlier turns. */
  allowDirs?: string[];
  /** The session's mode as the SDK takes it (absent = 'default'); 모두 자동 승인 is `autoApprove`, never 'bypassPermissions'. */
  permissionMode?: 'acceptEdits' | 'plan';
  /**
   * 모두 자동 승인: consulted per tool call; true = allow at once (no card). AskUserQuestion is never auto-answered.
   * False: ExitPlanMode goes to `onPermission` as the plan card — 'session' = approve + acceptEdits, 'once' = approve +
   * ask every time, 'deny' = keep planning.
   */
  autoApprove?: () => boolean;
  /** Called for each tool call 자동 승인 allowed (audit). */
  onAutoApproved?: (req: PermissionRequest) => Promise<void>;
  /**
   * Audit of the tool calls canUseTool never saw (once each): 'cli' = run or refused by the CLI without asking (an allow
   * rule, the permission mode, or a tool that needs no permission — the SDK does not tell these apart), 'rule' = refused
   * by a deny rule, 'deck' = denied by deck's own hook (handoff note turn). Never the input itself.
   */
  onToolAudit?: (e: { toolName: string; input: unknown; toolUseId: string; decision: 'allow' | 'deny'; source: 'cli' | 'rule' | 'deck' }) => Promise<void>;
  /** Receives the process's input handle (streaming-input mode) so later user messages can join it while background work runs. */
  onLive?: (live: LiveInput) => void;
  /**
   * 새 세션으로 이어가기 (handoff note turn): every tool call is denied — a PreToolUse hook (also covers tools a
   * settings allow rule would run without asking) and canUseTool. The tool list is left as is so the cached prompt still hits.
   */
  noTools?: boolean;
};

export interface Engine {
  runTurn(req: TurnRequest): AsyncIterable<EngineEvent>;
}
