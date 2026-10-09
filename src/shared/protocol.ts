import { z } from 'zod';
import { ACCOUNT_ID_RE, RESERVED_ACCOUNT_IDS, type Account, type AccountNames, type GeminiAccount, type Seat } from './accounts';
import type { AnyModel, ClaudeModel, CodexSandbox, EngineKind } from './models';
import { PERM_MODES, type PermMode } from './permission';
import type { DesktopSession, ProjectEntry, TranscriptMessage } from './session-types';
import type { BgTaskInfo, PermissionDecision, Question, QuestionAnswers, TaskUpdate, TaskUsage, TurnPhase, TurnUsage } from './turn-types';
import type { UsageSnapshot } from './usage-types';

/** Attachment ids are the UUIDs POST /api/attachments returned (Task 6); nothing path-like is accepted. */
export const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_ATTACHMENTS_PER_TURN = 8;
/** D7: per-file upload size cap, shared by the server (413) and the UI (pre-flight check before the network call). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const CLIENT_REF_MAX = 64;
/** A Claude account id by shape only (`ACCOUNT_ID_RE`): which ids exist is the server's configuration, checked when the message is handled. */
const AccountId = z.string().regex(ACCOUNT_ID_RE).refine((id) => !RESERVED_ACCOUNT_IDS.includes(id), { message: '예약된 이름이라 계정 id 로 쓸 수 없습니다' });

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('send'),
    sessionId: z.string().min(1).nullable(),
    // Review M8: absolute path, bounded; the server also checks it is an existing directory.
    cwd: z.string().min(1).max(4096).refine((c) => c.startsWith('/'), { message: 'cwd must be an absolute path' }),
    text: z.string().min(1).max(200_000),
    /** 'auto' = 자동: new Claude sessions get a model from the first prompt; later turns keep the session's model. */
    model: z.enum(['sonnet', 'opus', 'fable', 'gpt-6-sol', 'gpt-6-astra', 'gemini-pro', 'gemini-flash', 'auto']).optional(),
    /** Reasoning effort for this turn (allowlist = shared/models EFFORTS); absent = the engine's own default. */
    effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    /** New sessions only (D3): which engine opens the session. Ignored on resume — the stored engine wins. 'gemini' is explicit only. */
    engine: z.enum(['claude', 'codex', 'gemini', 'auto']).optional(),
    /** New Codex / Gemini sessions only (D2). */
    sandbox: z.enum(['read-only', 'workspace-write']).optional(),
    /** New Claude sessions only: 이 세션은 B 써 (null/absent = 자동). Existing sessions use set_account_pin. */
    accountPin: AccountId.nullable().optional(),
    /** New Claude sessions only: the permission mode picked before the first send (existing sessions use set_permission_mode). */
    permissionMode: z.enum(PERM_MODES).optional(),
    attachments: z.array(z.string().regex(ATTACHMENT_ID)).max(MAX_ATTACHMENTS_PER_TURN).optional(),
    /** Client correlation id: echoed on this send's turn_started and on any error refusing it (which pane sent it). */
    clientRef: z.string().min(1).max(CLIENT_REF_MAX).optional(),
    /** 새 세션으로 이어가기, step 1 (existing sessions only): the server runs shared/handoff HANDOFF_PROMPT with every tool call denied. */
    handoff: z.boolean().optional(),
    /** Step 2 (new sessions only): the session this one continues; once it has an id, deck's session meta links the two. */
    handoffFrom: z.string().min(1).max(200).optional(),
    /**
     * 메시지 편집 갈래 (new sessions only): `text` replaces user message `n` (TranscriptMessage.n) of Claude session `from`.
     * `expect` is that message as the device showed it — the server checks it (nearest match) before forking.
     */
    branch: z.object({ from: z.string().min(1).max(200), n: z.number().int().min(0).max(1_000_000), expect: z.string().max(200_000).optional() }).optional(),
  }),
  z.object({ type: z.literal('permission_response'), requestId: z.string().min(1), decision: z.enum(['once', 'session', 'deny']) }),
  /** D8: answers keyed by the question text, values are option labels (comma-joined for multiSelect) or free text. */
  z.object({ type: z.literal('question_response'), requestId: z.string().min(1), answers: z.record(z.string().max(2000), z.string().max(4000)) }),
  /**
   * A message typed while a Claude turn runs: written into the running process's input (priority 'next'), so the CLI
   * folds it in at the next tool boundary of the same turn — or runs it right after the turn when none comes.
   * `turnId` = the running turn the device shows; `steerId` = the device's id for it (echoed on steer_delivered /
   * steer_rejected). Refused (steer_rejected) when it cannot go in now: the device then sends it after the turn.
   */
  z.object({
    type: z.literal('steer'),
    turnId: z.string().min(1),
    steerId: z.string().min(1).max(CLIENT_REF_MAX),
    text: z.string().min(1).max(200_000),
    attachments: z.array(z.string().regex(ATTACHMENT_ID)).max(MAX_ATTACHMENTS_PER_TURN).optional(),
  }),
  z.object({ type: z.literal('interrupt'), turnId: z.string().min(1) }),
  /** Stop one background task of a running turn (the rest of the turn keeps going). */
  z.object({ type: z.literal('stop_task'), turnId: z.string().min(1), taskId: z.string().min(1).max(200) }),
  /**
   * `after` (servers with the 'catchup' feature; others drop it and answer with the full history): the last stream
   * position this device applied for the session. When the server still holds what came after it, it answers `catchup`
   * and only those events instead of `history`.
   */
  z.object({
    type: z.literal('open_session'), sessionId: z.string().min(1), after: z.object({ epoch: z.string().min(1).max(200), seq: z.number().int().min(0) }).optional(),
    /** Server message kinds beyond the base set this UI understands ('sandbox'): the socket gets them from now on (rule 3). */
    accepts: z.array(z.string().max(40)).max(20).optional(),
  }),
  /** D6: a pane closed this session; stop routing its turn events to this socket. */
  z.object({ type: z.literal('close_session'), sessionId: z.string().min(1) }),
  /** After a reconnect: keep receiving a running turn this tab started (e.g. a new session with no id yet). */
  z.object({ type: z.literal('watch_turn'), turnId: z.string().min(1) }),
  z.object({ type: z.literal('refresh_index') }),
  /** Pin a Claude session to an account (null = 자동); persisted, applied from the next turn, broadcast as `account_pin`. */
  z.object({ type: z.literal('set_account_pin'), sessionId: z.string().min(1), pin: AccountId.nullable() }),
  /** A Claude session's permission mode; persisted, applied to its running turn at once, broadcast as `permission_mode`. */
  z.object({ type: z.literal('set_permission_mode'), sessionId: z.string().min(1), mode: z.enum(PERM_MODES) }),
  /** A GPT session's sandbox (D2; never danger-full-access); persisted, used from its next turn, broadcast as `sandbox`. Claude/Gemini: refused. */
  z.object({ type: z.literal('set_sandbox'), sessionId: z.string().min(1), sandbox: z.enum(['read-only', 'workspace-write']) }),
  /**
   * Server-wide settings (persisted, broadcast to every device as `settings`). `defaultPermissionMode` = the mode new
   * sessions start in; `autoApprove` is the legacy switch (true = bypassPermissions, false = default).
   */
  z.object({ type: z.literal('set_settings'), autoApprove: z.boolean().optional(), defaultPermissionMode: z.enum(PERM_MODES).optional(), routingPolicy: z.enum(['balance', 'drain']).optional() }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/**
 * Server-wide settings. defaultPermissionMode: the mode new Claude sessions (and sessions deck has no mode for) start in.
 * autoApprove mirrors `defaultPermissionMode === 'bypassPermissions'` (legacy 자동 승인; new GPT sessions default to workspace-write).
 */
export type DeckSettings = { autoApprove: boolean; defaultPermissionMode: PermMode; /** Absent from older servers (= 'balance'). */ routingPolicy?: RoutingPolicy };

/**
 * 자동 account routing: 'balance' (고르게 분산) = the safe account with the lowest 5h usage;
 * 'drain' (리셋 임박 먼저 소진) = the account whose weekly quota resets soonest, relative to what is left.
 */
export const ROUTING_POLICIES = ['balance', 'drain'] as const;
export type RoutingPolicy = (typeof ROUTING_POLICIES)[number];

/** One configured Claude account as the UI needs it (`hello.accounts`). `retired`: read-only — shown, never offered as a pin. */
export type AccountInfo = { id: Account; label: string; home: boolean; retired: boolean };

/** `hello.accounts` for a registry: every configured account (retired included), in configured order. */
export function accountInfos(names: Pick<AccountNames, 'all' | 'label' | 'isHome' | 'isRetired'>): AccountInfo[] {
  return names.all().map((id) => ({ id, label: names.label(id), home: names.isHome(id), retired: names.isRetired(id) }));
}

/** gemini-cli present, and which accounts have an OAuth file (existence only; the UI shows "로그인 필요" otherwise). */
export type GeminiStatus = { available: boolean; loggedIn: Record<GeminiAccount, boolean> };

export type TurnBadge = { account: Seat; model: AnyModel; reason: string; usage: TurnUsage; modelNote: string | null; /** The account was chosen because the session is pinned to it. */ pinned?: boolean };

/** An attachment as shown in a sent bubble (images load from GET /api/attachments/:id). */
export type PromptFile = { id: string; name: string; isImage: boolean };
/** What the user typed for a turn, as sent (attachment metadata only) — lets every device viewing the session show the bubble. */
export type TurnPrompt = { text: string; attachments: PromptFile[] };

/** A turn in flight; sessionId is null for a new session until the CLI reports one. */
export type RunningTurn = { turnId: string; sessionId: string | null; cwd: string };

/**
 * What runs where, for the sidebar and the tab title on every device: one entry per session with a
 * turn in flight or background work held open. `forMs` = how long the current turn has run.
 */
export type SessionActivity = { sessionId: string; cwd: string; turnId: string; running: boolean; bg: number; forMs: number };

/**
 * What this server can do beyond the first protocol, announced in `hello.features` (see docs/protocol.md). A server
 * that sends no list has none of them. The UI asks only through ui/features.ts `has()`.
 * - sessionModel: a Claude session's `history` carries the model it runs on.
 * - abortLabel: a user's interrupt ends the turn with exactly '중단됨' (never the SDK's own text).
 * - catchup: turn events carry `pos`; `open_session.after` is answered with `catchup` when possible.
 * - accounts: `hello.accounts` lists the configured Claude accounts; account pins take any of its active ids.
 */
export const FEATURES = ['sessionModel', 'abortLabel', 'catchup', 'accounts', 'sessionSandbox'] as const;
export type Feature = (typeof FEATURES)[number];

/**
 * Where a turn event stands in its session's stream: `seq` grows by one per event for the session (never reused while
 * the server runs); `epoch` names the process that produced it (events can be re-sent only while it lives).
 */
export type StreamPos = { sid: string; epoch: string; seq: number };

/** Review I3: every turn-scoped message says which session (null = new, not yet known) and cwd it belongs to. `pos`: once the session has an id ('catchup' servers). */
type TurnScope = { turnId: string; sessionId: string | null; cwd: string; pos?: StreamPos };

/** What `history` and `catchup` both say about the session besides its messages. */
export type SessionFacts = { runningTurnId: string | null; /** Claude sessions: the pinned account (null = 자동). */ accountPin?: Account | null; /** Claude sessions: the mode its next tool calls run in. */ permissionMode?: PermMode; /** Claude sessions: the model a send without one runs on (the session's own default; absent: an older server). */ sessionModel?: ClaudeModel; /** The running turn's prompt (a device opening the session mid-turn shows it even before the transcript has it). */ runningPrompt?: TurnPrompt | null; /** How long the running turn has run (its elapsed timer on a device that opens it mid-turn). */ runningForMs?: number; /** The send clientRefs / steer ids this session accepted lately (absent: an older server). */ acceptedRefs?: string[]; /** Refs handed to the running process but not recorded yet: they are going in — never sent again by themselves. */ pendingRefs?: string[]; /** Set when the per-session cap may have pushed older refs out: the oldest kept ref's time (ms). A maybe-sent message from before it cannot be told by the list. */ acceptedRefsSince?: number; /** The session's newest stream position (absent: no turn since the server started, or an older server). */ pos?: StreamPos };

export type ServerMessage =
  /** F2: `pins` = pinned session ids in pin order (optional only for older test literals). */
  /** `desktop` = recent Claude Desktop sessions (optional only for older test literals). */
  | { type: 'hello'; usage: UsageSnapshot; projects: ProjectEntry[]; pins?: string[]; desktop?: DesktopSession[]; settings?: DeckSettings; running: RunningTurn[]; activity?: SessionActivity[]; codex: { available: boolean }; gemini?: GeminiStatus; /** See FEATURES; absent = none (an older server). Unknown names are ignored. */ features?: string[]; /** 'accounts' servers: the configured Claude accounts (retired included), in configured order. Absent (an older server) = a/b/c, a is home. */ accounts?: AccountInfo[]; /** UI build id of the serving deck (null in dev); a changed id on reconnect means a new UI is out. */ build?: string | null }
  | { type: 'settings'; settings: DeckSettings }
  /** A Claude session's permission mode changed (picker, Shift+Tab, or an approved plan). */
  | { type: 'permission_mode'; sessionId: string; mode: PermMode }
  /** A session's account pin changed (null = 자동). */
  | { type: 'account_pin'; sessionId: string; pin: Account | null }
  /** A GPT session's sandbox changed (set_sandbox, 'sessionSandbox' servers). */
  | { type: 'sandbox'; sessionId: string; sandbox: CodexSandbox }
  | { type: 'usage'; usage: UsageSnapshot }
  | { type: 'index'; projects: ProjectEntry[]; pins?: string[]; desktop?: DesktopSession[] }
  | ({ type: 'history'; sessionId: string; cwd: string; account: Seat | null; engine?: EngineKind; sandbox?: CodexSandbox | null; messages: TranscriptMessage[] } & SessionFacts)
  /**
   * The answer to `open_session.after` when nothing has to be read again: the device keeps what it shows, and the events
   * after its position (if any) follow this message at once, in order. Never sent unasked.
   */
  | ({ type: 'catchup'; sessionId: string; /** GPT sessions ('sessionSandbox' servers): the current sandbox. */ sandbox?: CodexSandbox } & SessionFacts)
  | ({ type: 'turn_started'; account: Seat; model: AnyModel; reason: string; attempt: number; engine?: EngineKind; clientRef?: string; /** The user message that started this turn (absent for a background continuation); the sending pane already shows it. */ prompt?: TurnPrompt; /** Claude: the session's stored model after this send (a pick sticks); panes that picked none show it. Absent: unchanged / an older server. */ sessionModel?: ClaudeModel } & TurnScope)
  | ({ type: 'delta'; text: string } & TurnScope)
  /** Claude thinking content so far (chunks; empty text = a block started); `redacted` = an encrypted block. */
  | ({ type: 'thinking'; text: string; redacted?: boolean } & TurnScope)
  | ({ type: 'tool_call'; toolUseId: string; name: string; input: unknown } & TurnScope)
  | ({ type: 'tool_result'; toolUseId: string; content: string; isError: boolean } & TurnScope)
  | ({
      type: 'permission_request';
      requestId: string;
      toolName: string;
      input: unknown;
      /** SDK prompt sentence, reason, and the path that triggered it, when the CLI supplied them (review I4). */
      title: string | null;
      decisionReason: string | null;
      blockedPath: string | null;
      /** Open on 거부; no one-click approve default. */
      defaultToNo: boolean;
      /** False when no SDK suggestion can be kept for the session, or suppressAlwaysAllowRule: hide 이 세션. */
      allowSession: boolean;
      /** What 이 세션 will allow, e.g. "이 세션 동안 파일 편집 허용"; null when not offered. */
      sessionLabel: string | null;
    } & TurnScope)
  | { type: 'permission_resolved'; requestId: string; decision: PermissionDecision }
  /** D8: AskUserQuestion card; answered with question_response, closed for everyone with question_resolved. */
  | ({ type: 'question_request'; requestId: string; questions: Question[] } & TurnScope)
  | { type: 'question_resolved'; requestId: string; answers: QuestionAnswers | null }
  /** Non-terminal note about a running turn (e.g. a refused session move). */
  | ({ type: 'turn_notice'; message: string } & TurnScope)
  /** A hook sent the model a message mid-turn (e.g. a Stop hook made it keep going): a muted row in the turn. `event`: Stop, PreToolUse… */
  | ({ type: 'turn_system'; source: string; label: string; text: string } & TurnScope)
  /** A background task (run_in_background Bash, backgrounded agent) settled during the turn; drives a push, the UI ignores it. */
  | ({ type: 'task_done'; status: 'completed' | 'failed' | 'stopped'; summary: string; taskId?: string; toolUseId?: string | null; usage?: TaskUsage } & TurnScope)
  /** Live state of a task (subagent or background command): started, progress, status change. Latest wins per taskId. */
  | ({ type: 'task_update'; /** On a replay to a device that opened the session mid-turn: how long ago the task started. */ ageMs?: number } & TaskUpdate & TurnScope)
  /** The running turn's output so far (main conversation) and what it is doing now — the status row. */
  | ({ type: 'turn_progress'; outputTokens: number; phase: TurnPhase } & TurnScope)
  /** A subagent's own tool call / result, under the Agent call `parentToolUseId` (never in the main transcript). */
  | ({ type: 'sub_tool_call'; parentToolUseId: string; toolUseId: string; name: string; input: unknown } & TurnScope)
  | ({ type: 'sub_tool_result'; parentToolUseId: string; toolUseId: string; isError: boolean } & TurnScope)
  | { type: 'activity'; sessions: SessionActivity[] }
  | ({ type: 'turn_retry'; fromAccount: Account; toAccount: Account; reason: string; attempt: number } & TurnScope)
  /**
   * Background tasks (Agent run_in_background, background Bash) live in the turn's process, one
   * description each; [] = none left. While non-empty the process stays open after the turn's
   * result; a finished task's continuation arrives as a new turn (reason 백그라운드 계속).
   * `turnId` names the turn the work belongs to (interrupt it to stop the work).
   */
  | ({ type: 'turn_background'; tasks: string[]; /** Per task: id (for stop_task), type, age. */ detail?: BgTaskInfo[]; /** stop_task works for this turn. */ canStop?: boolean } & TurnScope)
  | ({ type: 'turn_result'; ok: boolean; text: string; badge: TurnBadge | null; errorText: string | null } & TurnScope)
  /**
   * A steer reached the model, at this point of the transcript (mid-turn after a tool round, or as the start of its own
   * turn right after `turnId`'s result). Every device viewing the session shows `prompt` as the user's message here.
   */
  | ({ type: 'steer_delivered'; steerId: string; prompt: TurnPrompt; /** Re-sent after `history` to a device that opened the session mid-turn (the transcript may already show it). */ replay?: true } & TurnScope)
  /** A steer did not go in (no running Claude turn, process closed, retry/failover): the sending device sends it after the turn. */
  | ({ type: 'steer_rejected'; steerId: string; message: string; /** Why, when the device should act on it (see RefusalCode). */ code?: RefusalCode } & TurnScope)
  | { type: 'error'; turnId: string | null; message: string; pos?: StreamPos; clientRef?: string; /** Why, when the device should act on it (see RefusalCode). */ code?: RefusalCode; /** The error is about this session (e.g. opening it failed): shown in the panes showing it. */ sessionId?: string; /** An answer to this permission / question card came too late (another device answered it first): the card goes, nothing is shown. */ requestId?: string };

/**
 * 'draining': the server is about to restart (USR2) — the device sends the refused message again once it reconnects.
 * 'already_accepted': the session took a send / steer under this ref already — the device drops its copy.
 * 'in_flight': the session is taking this ref right now (not recorded yet; it may still fail) — the device keeps its copy, paused.
 * 'not_found': open_session named a session the server does not have — asking again will not help.
 */
export type RefusalCode = 'draining' | 'already_accepted' | 'in_flight' | 'not_found';

/** How long / how many accepted refs the server keeps per session (`history.acceptedRefs`). */
export const ACCEPTED_REFS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCEPTED_REFS_MAX = 500;
