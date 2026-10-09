import type { Account, Seat } from '../shared/accounts';
import { contextWindowOf, DEFAULT_CODEX_MODEL, DEFAULT_EFFORT, DEFAULT_GEMINI_MODEL, DEFAULT_MODEL, DEFAULT_SANDBOX, defaultSandbox, IMPORTED_DEFAULT_MODEL, isClaudeModel, isCodexModel, isGeminiModel, type CodexSandbox, type Effort, type EngineChoice, type EngineKind, type ModelChoice } from '../shared/models';
import { ACCEPTED_REFS_TTL_MS, type AccountInfo, type DeckSettings, type SessionFacts, type GeminiStatus, type RoutingPolicy, type ServerMessage, type SessionActivity, type TurnBadge, type TurnPrompt } from '../shared/protocol';
import type { BgTaskInfo, TaskStatus, TaskUsage, TurnPhase } from '../shared/turn-types';
import type { DesktopSession, ProjectEntry, TranscriptMessage } from '../shared/session-types';
import type { UsageSnapshot } from '../shared/usage-types';
import { handoffFirstMessage, handoffTitle } from '../shared/handoff';
import type { PermMode } from '../shared/permission';
import { coldWriteNote, latestContext, type ContextInfo } from './context';
import { familyOf } from '../shared/token-usage';
import { LEGACY_ACCOUNT_LIST, accountListOf, activePin, sameAccountList, seatLabel } from './accounts';
import { has } from './features';

export type ToolCallItem = { toolUseId: string; name: string; input: unknown; result: string | null; isError: boolean };

export type ChatItem =
  | { kind: 'user'; text: string; /** sent attachments (display: name tile, or a thumbnail for images) */ attachments?: SentFile[]; /** 메시지 편집 갈래: the message's ordinal among the session's user messages (TranscriptMessage.n); absent = unknown. */ n?: number }
  /** A hook's message to the model (e.g. a Stop hook made it keep going): a muted row, collapsed. Never counted as a user message. */
  | { kind: 'system'; source: string; label: string; text: string }
  | { kind: 'assistant'; turnId: string | null; text: string; toolCalls: ToolCallItem[]; badge: TurnBadge | null; streaming: boolean; error: string | null; notes: string[]; attempts: string[]; /** Claude thinking: text so far, an encrypted block seen, when it began and how long it took (ms; absent = unknown / still going). */ thinking?: ThinkingInfo; /** The context after this turn (gauge). */ ctx?: ContextInfo; /** Badge tooltip when the turn rewrote the prompt cache (e.g. "캐시 새로 씀 · 계정 전환"). */ cacheNote?: string | null; /** This client sent an interrupt for this turn (중단, 지금 전송): its error is the stop, not a failure. */ interrupted?: true };

/** A subagent's own tool call, shown in its Agent card (nested subagents' calls are flattened into the top card). */
export type AgentCall = { toolUseId: string; name: string; input: unknown; done: boolean; isError: boolean };
/**
 * Live state of the subagent an Agent/Task call started, keyed by that call's toolUseId. Times are this
 * client's clock: `startedAt` is backdated by the server's `ageMs` on a replay.
 */
export type AgentInfo = {
  taskId: string | null; status: TaskStatus; description: string; subagentType: string; backgrounded: boolean;
  startedAt: number; endedAt: number | null; usage: TaskUsage | null; lastToolName: string | null; calls: AgentCall[];
};
/** The pane's background work (one process per session): `receivedAt` + `detail[].ageMs` gives each task's age now. */
export type PaneBackground = { turnId: string; tasks: string[]; detail: BgTaskInfo[]; receivedAt: number; canStop: boolean };

export type PendingPermission = Omit<Extract<ServerMessage, { type: 'permission_request' }>, 'type'>;
export type PendingQuestion = Omit<Extract<ServerMessage, { type: 'question_request' }>, 'type'>;
export type UploadedAttachment = { id: string; name: string; size: number; isImage: boolean; /** ux-state: object URL of the local file, composer thumbnail only (never persisted). */ previewUrl?: string };
/** An attachment as shown in a sent bubble; images load from GET /api/attachments/:id. */
export type SentFile = { id: string; name: string; isImage: boolean };
/*
 * Queue state machine (messages are never dropped unless they provably went in):
 *   queued ──send──▶ awaitingSend (sent; waits for turn_started under its clientRef)
 *     turn_started            → gone from the queue (it is a bubble now)
 *     error 'draining'        → back at the head, restart 'hold' (after other held items): the old server only refuses
 *     error 'already_accepted' → dropped: the server has this ref already (a resent copy), so it never runs twice
 *     error 'in_flight'       → back at the head, paused, with its ref (banner): going in under this ref right now, may still fail
 *     turn_started of its ref → a queued copy of it is dropped (it went in)
 *     error (other)           → back at the head, paused (the user decides)
 *     socket died (hello)     → back at the head, restart 'hello' + maybeSent (+ `at`, when it was sent): it may have gone in
 *     page reload             → saved like a lost one (snapshotQueues), so a reload never loses it either
 *   restart 'hold'  ──hello──▶ 'hello' (a session to check) or 'go' (a new session: nothing to check)
 *   restart 'hello' ──history──▶ dropped if the server lists its clientRef in acceptedRefs (older server: the text at or
 *     after its ordinal); an ordinary paused item (banner) if its ref is in pendingRefs (going in right now) or it was
 *     sent too long ago for the server's list (ACCEPTED_REFS_TTL_MS less an hour, or no `at`); else 'go'
 *   restart 'go'    → sent alone even if the queue is paused (keepPaused: the rest stays paused)
 *   open_session error (that session's) / 이어서 보내기 → restart cleared, an ordinary (paused) item
 * Leaving the session (open another, clear, close, 메시지 편집 갈래, 새 세션으로 이어가기) parks held items (restart,
 * maybeSent, lostSteer, kept) under its id (or `__new__:<cwd>` for a new session); they come back `kept`, paused, when it
 * is opened again. Opening the session the pane already shows keeps its queue as it is.
 */

/** ux-state: a message typed while the pane's turn runs; sent when the turn ends. */
export type QueueItem = {
  id: string; text: string; attachments: UploadedAttachment[];
  /** Sent into the running Claude turn (`steer`) under this id, not yet confirmed: 전달 대기. Cleared on refusal (then sent after the turn). */
  steer?: string;
  /** A steer whose answer never came (reconnect, timeout): queued (paused) again, but dropped if the server later confirms it went in. */
  lostSteer?: string;
  /**
   * Held back by a restarting server: 'hold' = wait for the next reconnect (the old server would only refuse it again);
   * 'hello' = reconnected, waits for the session's history; 'go' = checked, goes out by itself even if the queue is paused
   * (it was sent once already) — alone: the rest of the queue keeps its pause.
   */
  restart?: 'hold' | 'hello' | 'go';
  /**
   * Sent, but no answer came (the socket died): it may have gone in as the session's user message number `maybeSent`.
   * Dropped if the history has that message there. A send refused with code 'draining' never has this (it did not go in).
   */
  maybeSent?: number;
  /** The clientRef it was last sent with: re-sent under the same ref, and dropped if the server's acceptedRefs has it. */
  ref?: string;
  /** When it was last sent (ms; a steer: when it went out): older than the server's acceptedRefs memory → never resent by itself. */
  at?: number;
  /** Came back from a parked bucket: parked again (not dropped) if the pane leaves the session once more. */
  kept?: true;
};

/** The parked bucket of a session that has no id yet (its held messages come back into the next new session in that folder). */
export const parkKey = (sessionId: string | null, cwd: string) => sessionId ?? `__new__:${cwd}`;

/** Held messages `go` picks are released: they go out by themselves, one by one, without unpausing the rest. */
function release(queue: QueueItem[], go: (q: QueueItem) => boolean): QueueItem[] {
  return queue.map((q) => (go(q) ? { ...q, restart: 'go' as const } : q));
}

/** The pane leaves the session its held messages were meant for: they stay, as ordinary (paused) queue items. */
const unhold = (queue: QueueItem[]): QueueItem[] => queue.map(({ restart: _r, maybeSent: _m, ...q }) => q);

/** Messages that must not be let go with their session: held for a restart, maybe gone in, a steer (in flight or lost), or parked before. */
const isHeld = (q: QueueItem) => !!q.restart || q.maybeSent !== undefined || !!q.steer || !!q.lostSteer || !!q.kept;

/** A held item as it is parked: a steer still on its way is with the server already — kept as a lost steer, never reported dropped. */
const toParked = ({ restart: _r, steer, ...q }: QueueItem): QueueItem => (steer ? { ...q, lostSteer: steer } : q);

/**
 * The answer to a steer whose pane left the session meanwhile (the item is parked as a lost steer): gone in (or already in) —
 * the parked copy is dropped; refused — it stays parked, plain, and the error bar names it.
 */
function settleParkedSteer(parked: AppState['parked'], msg: Extract<ServerMessage, { type: 'steer_delivered' | 'steer_rejected' }>): { parked: AppState['parked']; error?: string } {
  const key = Object.keys(parked).find((k) => parked[k]!.queue.some((q) => q.lostSteer === msg.steerId));
  if (!key) return { parked };
  const bucket = parked[key]!;
  const item = bucket.queue.find((q) => q.lostSteer === msg.steerId)!;
  if (msg.type === 'steer_delivered' || msg.code === 'already_accepted') {
    const queue = bucket.queue.filter((q) => q !== item);
    const { [key]: _gone, ...rest } = parked;
    return { parked: queue.length ? { ...parked, [key]: { ...bucket, queue } } : rest };
  }
  // Going in right now under this id: it may still land — left as a lost steer.
  if (msg.code === 'in_flight') return { parked };
  const queue = bucket.queue.map(({ lostSteer, ...q }): QueueItem => (lostSteer === msg.steerId ? { ...q, kept: true } : { ...q, ...(lostSteer ? { lostSteer } : {}) }));
  return { parked: { ...parked, [key]: { ...bucket, queue } }, error: `진행 중인 턴에 들어가지 못한 메시지가 있습니다 — 그 세션을 다시 열면 큐에 있습니다: ${item.text || '첨부만'}` };
}

/** Held messages of a session the pane leaves go to its parked bucket (the rest stays in `queue`). */
function parkHeld(parked: AppState['parked'], sessionId: string, cwd: string, queue: QueueItem[]): { parked: AppState['parked']; queue: QueueItem[] } {
  const held = queue.filter(isHeld);
  if (!held.length) return { parked, queue };
  return { parked: { ...parked, [sessionId]: { cwd, queue: [...(parked[sessionId]?.queue ?? []), ...held.map(toParked)] } }, queue: queue.filter((q) => !isHeld(q)) };
}

/** Slack for the device's and the server's clocks disagreeing. */
const SKEW_MS = 3_600_000;
/** Sent longer ago than this: the server's acceptedRefs may have forgotten it. */
const STALE_MS = ACCEPTED_REFS_TTL_MS - SKEW_MS;

/**
 * Messages the history cannot clear for resending: not listed as accepted, but going in right now (pendingRefs), or a
 * maybe-sent one too old for the server's list to tell (or without a send time, or from before the oldest ref the cap left
 * it: `acceptedRefsSince`). They wait for the user. An older server
 * (no acceptedRefs) is checked by text instead.
 */
function inDoubt(msg: SessionFacts, now: number): (q: QueueItem) => boolean {
  if (!msg.acceptedRefs) return () => false;
  const accepted = new Set(msg.acceptedRefs);
  const pending = new Set(msg.pendingRefs ?? []);
  const since = msg.acceptedRefsSince;
  return (q) => !(q.ref && accepted.has(q.ref)) && ((!!q.ref && pending.has(q.ref)) || (q.maybeSent !== undefined && (q.at === undefined || now - q.at > STALE_MS || (since !== undefined && q.at < since + SKEW_MS))));
}

/**
 * The user message `text` is (or opens) a transcript user text: the server appends path lines / an image marker after what
 * was typed (an attachment-only send has '' as its text: only the `첨부 파일:` lines are in the transcript).
 */
const sameUserText = (it: ChatItem, text: string) => {
  if (it.kind !== 'user') return false;
  const typed = it.text.replace(/(^|\n\n)첨부 파일: [\s\S]*$/, '');
  return typed === text || it.text === text || it.text.startsWith(`${text}\n`);
};

/**
 * A send that got no turn_started back goes into the queue again, at the head, and its bubble (if nothing came after it)
 * is taken back — so it is never lost. `how`: 'refused' = it did not go in ('draining': held, sent after the reconnect;
 * else paused); 'lost' = the socket died first, so it may have gone in: checked against the history by its ordinal, or
 * paused when that cannot be told (no ordinal, a new session, a branch).
 */
function requeue(pane: PaneState, back: NonNullable<PaneState['awaitingSend']>, how: 'draining' | 'refused' | 'lost'): PaneState {
  const last = pane.items[pane.items.length - 1];
  const items = last?.kind === 'user' && last.text === back.text ? pane.items.slice(0, -1) : pane.items;
  const sid = pane.session?.sessionId;
  const mark: Pick<QueueItem, 'restart' | 'maybeSent'> | null = back.branch ? null
    : how === 'draining' ? { restart: 'hold' }
    : how === 'lost' && sid && back.n !== undefined ? { restart: 'hello', maybeSent: back.n }
    : null;
  const item: QueueItem = { id: nextQueueId(), text: back.text, attachments: back.attachments.map((f) => ({ ...f, size: 0 })), ...mark, ...(pane.awaitingRef ? { ref: pane.awaitingRef } : {}), ...(back.at !== undefined ? { at: back.at } : {}) };
  // A second draining refusal goes after the messages already held, so they keep their order.
  const at = how === 'draining' ? pane.queue.filter((q) => q.restart).length : 0;
  const queue = [...pane.queue.slice(0, at), item, ...pane.queue.slice(at)];
  return { ...pane, items, awaitingStart: false, awaitingRef: null, awaitingSend: null, queue, queuePaused: mark ? pane.queuePaused : true };
}

/** Steer-flagged items back to ordinary (paused) queue items: their answer was lost, so they may or may not have gone in. */
function unsteer(pane: PaneState, which: (steerId: string) => boolean): PaneState {
  if (!pane.queue.some((q) => q.steer && which(q.steer))) return pane;
  const queue = pane.queue.map(({ steer, ...q }) => (steer && which(steer) ? { ...q, lostSteer: steer, at: q.at ?? Date.now() } : { ...q, ...(steer ? { steer } : {}) }));
  return { ...pane, queue, queuePaused: true };
}

export type PaneSession = { sessionId: string | null; cwd: string; account: Seat | null; title: string; engine: EngineKind | null; sandbox: CodexSandbox | null; /** 이 세션은 B 써 (absent/null = 자동); a new session sends it with its first turn. */ accountPin?: Account | null; /** Claude permission mode (absent = the server's default for new sessions); a new session sends it with its first turn. */ permissionMode?: PermMode; /** Picked while the new session's first turn ran (no id yet): sent as soon as the id arrives. */ permissionModePending?: true };

export type PaneState = {
  id: string;
  session: PaneSession | null;
  items: ChatItem[];
  activeTurnId: string | null;
  /** Review I3: turns this pane started (claimed at their first turn_started after a `sent`). */
  myTurns: string[];
  /** A `sent` whose turn_started (or error) has not arrived yet. */
  awaitingStart: boolean;
  /** The `send.clientRef` of that pending send; null for a send made without one (legacy matching). */
  awaitingRef: string | null;
  /** What that pending send carried (not for a handoff note): queued again if the server refuses it before its turn starts. */
  awaitingSend: { text: string; attachments: SentFile[]; /** the user-message ordinal it gets (nextUserN) */ n?: number; /** when it was sent (ms) */ at?: number; /** 메시지 편집 갈래: re-sent only by the user */ branch?: true } | null;
  model: ModelChoice;
  /** The user picked `model` for this pane's session (or sent a new session with it): sent with every turn. Otherwise an existing session gets no model (it runs on its own default) and the picker shows that default. */
  modelPicked: boolean;
  /** Reasoning effort per engine, so switching Claude ↔ GPT keeps each side's pick. */
  efforts: Record<EngineKind, Effort>;
  /** Effort while the model is 자동: null = 자동 too (the server picks per model). */
  autoEffort: Effort | null;
  /** New-session choices (D2, D3); the server ignores them once the session exists. */
  engine: EngineChoice;
  sandbox: CodexSandbox;
  attachments: UploadedAttachment[];
  /** ux-state: messages waiting for the running turn to end (FIFO). */
  queue: QueueItem[];
  /** Stop / a failed turn pauses the queue; a manual send or 이어서 resumes it. */
  queuePaused: boolean;
  /** 지금 전송: the queued item to send the moment the running turn ends (it was interrupted for it), even if paused. */
  queueSendNow?: string | null;
  /** Status row: when the running turn started (client clock), its output tokens and phase. */
  runStartedAt: number | null;
  progress: { outputTokens: number; phase: TurnPhase } | null;
  /** Subagent cards, by the Agent call's toolUseId. */
  agents: Record<string, AgentInfo>;
  /** Background tasks pill; null = none. */
  bg: PaneBackground | null;
  /** 새 세션으로 이어가기, step 1: the handoff-note turn this pane sent (`ref` = its clientRef, `turnId` once started). */
  handoff: { ref: string; turnId: string | null; sessionId: string; title: string; cwd: string } | null;
  /** Step 2: the session this (new) pane session continues — rides its first send as `handoffFrom`, and the 이전 세션 link. */
  handoffFrom: { sessionId: string; title: string } | null;
  /** Composer text to put in once (the new session's first message, sent only when the user presses Enter). */
  prefill: string | null;
  /** Notes / errors about the session no turn owns (e.g. written outside deck just now): dismissible bars in this pane (newest 3), dropped when the pane shows another session. */
  notices?: PaneNotice[];
  /** The opened session's history has not arrived yet (the pane shows a loading placeholder instead of a blank). */
  loading?: boolean;
};

export type PaneNotice = { sessionId: string | null; message: string; level: 'notice' | 'error' };

/** Adds a bar (a repeat moves to the end) and keeps the newest three. */
const withNotice = (p: PaneState, n: PaneNotice): PaneState => ({ ...p, notices: [...(p.notices ?? []).filter((x) => x.message !== n.message), n].slice(-3) });

export type AppState = {
  connected: boolean;
  usage: UsageSnapshot | null;
  /** The server's Claude accounts (hello.accounts, retired included); a/b/c until a hello says otherwise — read through `uiAccounts`. */
  accounts: readonly AccountInfo[];
  projects: ProjectEntry[];
  /** Prompts from every session (any device may answer); the pane whose session they belong to shows them. */
  pending: PendingPermission[];
  questions: PendingQuestion[];
  panes: PaneState[];
  activePaneId: string;
  error: string | null;
  codexAvailable: boolean;
  /** gemini-cli status from hello; null = not installed (or an older server). */
  gemini: GeminiStatus | null;
  /** F2: pinned session ids, pin order (server-side pins.json). */
  pins: string[];
  /** Recent Claude Desktop sessions (server-side, newest first). */
  desktop: DesktopSession[];
  /** 자동 승인 (server setting); null until the server says. */
  autoApprove: boolean | null;
  /** The mode new sessions start in (server setting); null until the server says. */
  defaultPermMode: PermMode | null;
  /** 자동 routing policy (server setting); null until the server says. */
  routingPolicy: RoutingPolicy | null;
  /** Sessions with a turn running or background work, on any device (sidebar dots, tab title). */
  activity: SessionActivity[];
  /** Sessions whose turn finished while no focused pane showed them; cleared when opened. */
  unread: string[];
  /** Messages held for a restart whose pane left their session (opened another, cleared, closed): back, paused, when it is opened again. */
  parked: Record<string, { cwd: string; queue: QueueItem[] }>;
  /** The server's hello arrived on this socket (false from a disconnect until then): the queue runner waits for it. */
  ready: boolean;
};

export const MAX_PANES = 5;

export function newPane(id: string): PaneState {
  return { id, session: null, items: [], activeTurnId: null, myTurns: [], awaitingStart: false, awaitingRef: null, awaitingSend: null, model: DEFAULT_MODEL, modelPicked: false, efforts: { ...DEFAULT_EFFORT }, autoEffort: null, engine: 'claude', sandbox: DEFAULT_SANDBOX, attachments: [], queue: [], queuePaused: false, queueSendNow: null, runStartedAt: null, progress: null, agents: {}, bg: null, handoff: null, handoffFrom: null, prefill: null, notices: [] };
}

export const initialState: AppState = { connected: false, usage: null, accounts: LEGACY_ACCOUNT_LIST, projects: [], pending: [], questions: [], panes: [newPane('p0')], activePaneId: 'p0', error: null, codexAvailable: false, gemini: null, pins: [], desktop: [], autoApprove: null, defaultPermMode: null, routingPolicy: null, activity: [], unread: [], parked: {}, ready: false };

export type Action =
  | { type: 'server'; msg: ServerMessage; /** with a `history`: files sent earlier in that session (persist.ts), matched back onto its user items */ sentFiles?: SentRecord[] }
  | { type: 'connected'; value: boolean }
  | { type: 'open'; sessionId: string | null; cwd: string; title: string; paneId?: string }
  /** 메시지 편집 갈래: the pane becomes a new session holding its history before user message `n`, then `text` (the send is under way). */
  | { type: 'branch_edit'; n: number; text: string; paneId?: string; clientRef?: string }
  /** A refused edit goes back to its original session: the new pane's whole queue (the edited text first) goes with it. */
  | { type: 'branch_undo'; sessionId: string; paneId?: string }
  | { type: 'sent'; text: string; paneId?: string; attachments?: SentFile[]; /** Echoed by the server on turn_started / refusal; the caller makes it unique. */ clientRef?: string; /** The handoff-note turn (새 세션으로 이어가기). */ handoff?: boolean; /** A message released after a restart: the queue's pause stays for the rest. */ keepPaused?: boolean }
  | { type: 'set_model'; model: ModelChoice; paneId?: string }
  | { type: 'set_effort'; engine: EngineKind; effort: Effort; paneId?: string }
  | { type: 'set_auto_effort'; effort: Effort | null; paneId?: string }
  | { type: 'set_engine'; engine: EngineChoice; paneId?: string }
  | { type: 'set_sandbox'; sandbox: CodexSandbox; paneId?: string }
  | { type: 'set_account_pin'; pin: Account | null; paneId?: string }
  | { type: 'set_permission_mode'; mode: PermMode; paneId?: string }
  | { type: 'attach'; attachment: UploadedAttachment; paneId?: string }
  | { type: 'unattach'; id: string; paneId?: string }
  | { type: 'add_pane' }
  /** Back to the empty / new-chat screen (⌘N, the shown session was deleted). */
  | { type: 'clear_pane'; paneId?: string }
  | { type: 'close_pane'; paneId: string }
  | { type: 'focus_pane'; paneId: string }
  | { type: 'dismiss_error' }
  /** `message` omitted = all of the pane's bars. */
  | { type: 'dismiss_notice'; paneId?: string; message?: string }
  | { type: 'set_pins'; pins: string[] }
  | { type: 'show_error'; message: string }
  | { type: 'queue_add'; text: string; paneId?: string; /** Also sent as a steer under this id (전달 대기 until the server answers). */ steerId?: string }
  | { type: 'queue_edit'; id: string; text: string; paneId?: string }
  | { type: 'queue_remove'; id: string; paneId?: string }
  | { type: 'queue_clear'; paneId?: string }
  | { type: 'queue_pause'; paneId?: string }
  | { type: 'queue_resume'; paneId?: string }
  /** 지금 전송: move the item to the head and send it as soon as the turn ends (the caller interrupts the turn). */
  | { type: 'queue_send_now'; id: string; paneId?: string }
  /** This client sent `interrupt` for turn `turnId`. */
  | { type: 'interrupt_sent'; turnId: string; paneId?: string }
  /** A steer got no answer (send failed, or none came in time): an ordinary queue item again (paused if it may have gone in). */
  | { type: 'steer_lost'; steerId: string; paneId?: string; /** The send itself failed: it never left, so the queue need not pause. */ unsent?: boolean };

const withN = (n: number | undefined) => (n !== undefined ? { n } : {});

/** A sent message's text and files, kept per session so a reloaded transcript can show thumbnails again. */
export type SentRecord = { text: string; files: SentFile[] };

export type ThinkingInfo = { text: string; redacted: boolean; startedAt: number | null; ms: number | null };

export function fromTranscript(messages: TranscriptMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const m of messages) {
    if (m.kind === 'user') items.push({ kind: 'user', text: m.text, ...(m.n !== undefined ? { n: m.n } : {}) });
    else if (m.kind === 'system') items.push({ kind: 'system', source: m.source, label: m.label, text: m.text });
    else if (m.kind === 'assistant') {
      const at = m.ts ? Date.parse(m.ts) : NaN;
      const ctx: ContextInfo | null = m.usage ? { usage: m.usage, window: contextWindowOf(m.model), at: Number.isNaN(at) ? null : at, model: m.model, account: null } : null;
      items.push({ kind: 'assistant', turnId: null, text: m.text, toolCalls: m.toolCalls.map((t) => ({ toolUseId: t.id, name: t.name, input: t.input, result: null, isError: false })), badge: null, streaming: false, error: null, notes: [], attempts: [], ...(m.thinking || m.thinkingRedacted ? { thinking: { text: m.thinking ?? '', redacted: !!m.thinkingRedacted, startedAt: null, ms: null } } : {}), ...(ctx ? { ctx } : {}) });
    } else {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it?.kind !== 'assistant') continue;
        const tc = it.toolCalls.find((t) => t.toolUseId === m.toolUseId);
        if (tc) { tc.result = m.content; tc.isError = m.isError; break; }
      }
    }
  }
  return items;
}

/** The Claude model of a transcript's last assistant message (null: none, or not a deck model). */
function lastClaudeModel(messages: TranscriptMessage[]): ModelChoice | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind !== 'assistant' || !m.model) continue;
    const f = familyOf(m.model);
    return f === 'fable' || f === 'opus' || f === 'sonnet' ? f : null;
  }
  return null;
}

/** Which engine a model runs on (자동 picks among Claude models). */
export function engineOf(model: ModelChoice): EngineKind {
  return isCodexModel(model) ? 'codex' : isGeminiModel(model) ? 'gemini' : 'claude';
}

/** The pane's model if it belongs to `engine`, else that engine's default. 자동 stays 자동 on Claude (the session keeps its model). */
export function modelFor(engine: EngineKind, model: ModelChoice): ModelChoice {
  if (engine === 'codex') return isCodexModel(model) ? model : DEFAULT_CODEX_MODEL;
  if (engine === 'gemini') return isGeminiModel(model) ? model : DEFAULT_GEMINI_MODEL;
  return isClaudeModel(model) || model === 'auto' ? model : DEFAULT_MODEL;
}

type AssistantItem = Extract<ChatItem, { kind: 'assistant' }>;

/** The turn's latest item: a steer delivered mid-turn splits a turn's answer into items before and after the user's bubble. */
function updateTurn(pane: PaneState, turnId: string, fn: (item: AssistantItem) => AssistantItem): PaneState {
  const idx = pane.items.findLastIndex((it) => it.kind === 'assistant' && it.turnId === turnId);
  if (idx < 0) return pane;
  const items = pane.items.slice();
  items[idx] = fn(items[idx] as AssistantItem);
  return { ...pane, items };
}

type TurnMsg = Extract<ServerMessage, { turnId: string; cwd: string }>;

/** Review I3: a turn event is applied only if it belongs to the session this pane has open. */
function belongs(pane: PaneState, msg: TurnMsg): boolean {
  if (!pane.session) return false;
  if (pane.myTurns.includes(msg.turnId) || msg.turnId === pane.activeTurnId) return true;
  return msg.sessionId !== null && msg.sessionId === pane.session.sessionId;
}

/** The first reply text / tool call after thinking closes it: its elapsed time is fixed. */
function endThinking(it: AssistantItem): AssistantItem {
  const t = it.thinking;
  if (!t || t.ms !== null || t.startedAt === null) return it;
  return { ...it, thinking: { ...t, ms: Date.now() - t.startedAt } };
}

function streamingItem(turnId: string): AssistantItem {
  return { kind: 'assistant', turnId, text: '', toolCalls: [], badge: null, streaming: true, error: null, notes: [], attempts: [] };
}

function promptItem(prompt: TurnPrompt, n?: number): ChatItem {
  return { kind: 'user', text: prompt.text, ...(prompt.attachments.length ? { attachments: prompt.attachments } : {}), ...(n !== undefined ? { n } : {}) };
}

/** The ordinal the next user message of these items gets: one past the last known one; 0 in a new session; undefined = unknown. */
export function nextUserN(items: ChatItem[], session: PaneSession | null): number | undefined {
  const last = items.findLast((it) => it.kind === 'user');
  if (last) return last.kind === 'user' && last.n !== undefined ? last.n + 1 : undefined;
  return session?.sessionId === null ? 0 : undefined;
}

/**
 * A pane opened mid-turn: the running turn's prompt goes before its streaming item unless the transcript already
 * ends its user messages with it (the CLI writes the prompt early; the server appends path lines after attachments).
 */
function withRunningPrompt(items: ChatItem[], prompt: TurnPrompt): ChatItem[] {
  const idx = items.findLastIndex((it) => it.kind === 'user');
  const lastUser = idx >= 0 ? (items[idx] as Extract<ChatItem, { kind: 'user' }>) : null;
  if (lastUser && (lastUser.text === prompt.text || lastUser.text.startsWith(`${prompt.text}\n`))) {
    if (lastUser.attachments?.length || !prompt.attachments.length) return items;
    const out = items.slice();
    out[idx] = { ...lastUser, attachments: prompt.attachments };
    return out;
  }
  return [...items, promptItem(prompt, nextUserN(items, null))];
}

/**
 * A steer reached the model in turn `turnId`: the user's bubble goes where the turn's answer stands now — after what
 * streamed so far (that part closes; the rest streams into a new item of the same turn), or before a still-empty item.
 */
function withSteerBubble(items: ChatItem[], turnId: string, bubble: ChatItem): ChatItem[] {
  const idx = items.findLastIndex((it) => it.kind === 'assistant' && it.turnId === turnId);
  if (idx < 0) return [...items, bubble];
  const it = items[idx] as AssistantItem;
  const out = items.slice();
  if (!it.text && !it.toolCalls.length && !it.thinking && !it.attempts.length) out.splice(idx, 0, bubble);
  else if (it.streaming) out.splice(idx, 1, { ...endThinking(it), streaming: false }, bubble, streamingItem(turnId));
  else out.splice(idx + 1, 0, bubble);
  return out;
}

const ACTIVITY_RESET = { runStartedAt: null, progress: null, agents: {}, bg: null } as const;

/** The agent card a subagent call belongs to: its own Agent call, or the top card holding the nested Agent call. */
function agentFor(agents: Record<string, AgentInfo>, parentToolUseId: string): string | null {
  if (agents[parentToolUseId]) return parentToolUseId;
  for (const [id, a] of Object.entries(agents)) if (a.calls.some((c) => c.toolUseId === parentToolUseId)) return id;
  return null;
}

function blankAgent(now: number): AgentInfo {
  return { taskId: null, status: 'running', description: '', subagentType: '', backgrounded: false, startedAt: now, endedAt: null, usage: null, lastToolName: null, calls: [] };
}

function withAgent(pane: PaneState, id: string, fn: (a: AgentInfo) => AgentInfo): PaneState {
  return { ...pane, agents: { ...pane.agents, [id]: fn(pane.agents[id] ?? blankAgent(Date.now())) } };
}

/**
 * The queue after the server's word on what it accepted (a history, or a catch-up's header). A send that may have gone
 * in is dropped if the server lists its clientRef as accepted (a lost steer: its id). An older server sends no list:
 * then by its text at or after the ordinal it would have had in the history's `items` (the transcript may count other
 * records as user messages too). The rest held back by the restart go out now.
 */
function settleQueue(pane: PaneState, msg: SessionFacts, items: ChatItem[]): Pick<PaneState, 'queue'> & Partial<Pick<PaneState, 'queueSendNow' | 'queuePaused'>> {
  const accepted = msg.acceptedRefs ? new Set(msg.acceptedRefs) : null;
  const went = (q: QueueItem) => accepted
    ? (q.maybeSent !== undefined && !!q.ref && accepted.has(q.ref)) || (!!q.lostSteer && accepted.has(q.lostSteer))
    : q.maybeSent !== undefined && items.some((it) => it.kind === 'user' && it.n !== undefined && it.n >= q.maybeSent! && sameUserText(it, q.text));
  for (const q of pane.queue) if (went(q)) console.warn('deck: queued message already went in — not sent again:', q.text);
  const doubt = inDoubt(msg, Date.now());
  const doubted = pane.queue.some((q) => !went(q) && doubt(q));
  const kept = pane.queue.filter((q) => !went(q)).map(({ maybeSent: _m, ...q }) => (doubt({ ...q, maybeSent: _m }) ? unhold([q])[0]! : q));
  const sent = kept.some((q) => q.id === pane.queueSendNow) ? {} : { queueSendNow: null };
  return { ...sent, ...(doubted ? { queuePaused: true } : {}), queue: release(kept, (q) => q.restart === 'hello' || q.restart === 'hold') };
}

/** One pane's view of a server message. `claim`: this pane may claim an unclaimed turn_started (only the first waiting pane does). */
function paneOnServer(pane: PaneState, msg: ServerMessage, claim: boolean, accounts: readonly AccountInfo[]): PaneState {
  switch (msg.type) {
    case 'hello': {
      // Reconnect: show 중단 for a turn still running on the open session; drop one that ended meanwhile.
      const sid = pane.session?.sessionId ?? null;
      const live = msg.running.find((r) => r.turnId === pane.activeTurnId) ?? (sid ? msg.running.find((r) => r.sessionId === sid) : undefined);
      const activeTurnId = live?.turnId ?? null;
      const items = activeTurnId === pane.activeTurnId ? pane.items : pane.items.map((it) => (it.kind === 'assistant' && it.streaming && it.turnId === pane.activeTurnId ? { ...it, streaming: false } : it));
      const act = sid ? msg.activity?.find((a) => a.sessionId === sid) : undefined;
      // An empty turn_background missed while disconnected must not leave the pill lingering.
      const bg = msg.activity && !(act && act.bg > 0) ? null : pane.bg;
      const run = activeTurnId ? { runStartedAt: pane.runStartedAt ?? (act?.running ? Date.now() - act.forMs : Date.now()) } : { runStartedAt: null, progress: null };
      // A send whose answer went down with the old socket: queued again (it may have gone in — the history tells).
      const base = pane.awaitingStart && pane.awaitingRef !== null && pane.awaitingSend ? requeue({ ...pane, items }, pane.awaitingSend, 'lost') : { ...pane, items };
      // Messages refused by the restarting server may go out now: in a new session (no history to check) at once, else after its history.
      const held = base.queue.map((q) => (q.restart === 'hold' && sid ? { ...q, restart: 'hello' as const } : q));
      const next: PaneState = { ...base, activeTurnId, awaitingStart: false, awaitingRef: null, awaitingSend: null, bg, ...run, queue: release(held, (q) => q.restart === 'hold') };
      // Steers in flight across a reconnect: their answer went to the old socket, so they may have gone in — queued again, paused.
      return unsteer(next, () => true);
    }
    case 'activity': {
      const sid = pane.session?.sessionId;
      if (!sid) return pane;
      const act = msg.sessions.find((a) => a.sessionId === sid);
      return pane.bg && !(act && act.bg > 0) ? { ...pane, bg: null } : pane;
    }
    case 'history': {
      let items = fromTranscript(msg.messages);
      if (msg.runningTurnId && msg.runningPrompt) items = withRunningPrompt(items, msg.runningPrompt);
      if (msg.runningTurnId) items.push(streamingItem(msg.runningTurnId));
      const title = pane.session?.sessionId === msg.sessionId ? pane.session.title : msg.sessionId.slice(0, 8);
      const engine: EngineKind = msg.engine ?? 'claude';
      // PF13: a Claude session is never sent a GPT model and vice versa. A Claude session the user picked no model for shows
      // the one it runs on: the server's sessionModel, else (an older server, which never sends one) the transcript's last model, else the imported default.
      const model = engine === 'claude' && !pane.modelPicked ? (msg.sessionModel ?? (has('sessionModel') ? undefined : lastClaudeModel(msg.messages)) ?? IMPORTED_DEFAULT_MODEL) : modelFor(engine, pane.model);
      const runStartedAt = msg.runningTurnId ? Date.now() - (msg.runningForMs ?? 0) : null;
      const notice = pane.notices?.some((n) => n.sessionId !== msg.sessionId) ? { notices: pane.notices.filter((n) => n.sessionId === msg.sessionId) } : {};
      // This pane's send is listed as accepted, so its turn_started is behind us (it came ahead of a gap in the stream and
      // was not applied, or with the old socket): the pane stops waiting for it, and the turn running now is its own.
      const mine = pane.awaitingStart && pane.awaitingRef !== null && !!msg.acceptedRefs?.includes(pane.awaitingRef);
      const started = mine ? { awaitingStart: false, awaitingRef: null, awaitingSend: null, ...(msg.runningTurnId && !pane.myTurns.includes(msg.runningTurnId) ? { myTurns: [...pane.myTurns, msg.runningTurnId] } : {}) } : {};
      return { ...pane, ...started, ...settleQueue(pane, msg, items), session: { sessionId: msg.sessionId, cwd: msg.cwd, account: msg.account, title, engine, sandbox: msg.sandbox ?? null, accountPin: msg.accountPin ?? null, ...(msg.permissionMode ? { permissionMode: msg.permissionMode } : {}) }, items, activeTurnId: msg.runningTurnId, model, ...ACTIVITY_RESET, runStartedAt, ...notice };
    }
    case 'catchup': {
      // The device was not behind, or what it missed follows as ordinary events: the transcript stays as it is. Only what a
      // history's header would have settled is settled — the queue, and the session's server-side settings.
      const sess = pane.session;
      if (sess?.sessionId !== msg.sessionId) return pane;
      const session = { ...sess, ...(msg.accountPin !== undefined ? { accountPin: msg.accountPin } : {}), ...(msg.permissionMode && !sess.permissionModePending ? { permissionMode: msg.permissionMode } : {}) };
      return { ...pane, ...(msg.acceptedRefs ? settleQueue(pane, msg, []) : {}), session, ...(msg.sessionModel && sess.engine === 'claude' && !pane.modelPicked ? { model: msg.sessionModel } : {}) };
    }
    case 'turn_started': {
      let p = pane;
      const sess = pane.session;
      // A send made with a clientRef is claimed only by the turn_started echoing it (send order, not pane order);
      // a ref-less send falls back to the first waiting pane with a matching session.
      const claims = pane.awaitingRef !== null
        ? msg.clientRef === pane.awaitingRef
        : claim && msg.clientRef === undefined && !!sess && (msg.sessionId === sess.sessionId || (msg.sessionId === null && sess.sessionId === null && msg.cwd === sess.cwd));
      if (pane.awaitingStart && sess && !pane.myTurns.includes(msg.turnId) && claims) {
        const engine = msg.engine ?? 'claude';
        // A new GPT/Gemini session runs under the sandbox this pane sent with its first turn (Pane: `sandbox: pane.sandbox`).
        // Nothing else tells the pane until the session is reopened — the chip would show the read-only default meanwhile.
        const sandbox = sess.sessionId === null && engine !== 'claude' ? { sandbox: pane.sandbox } : {};
        p = { ...pane, awaitingStart: false, awaitingRef: null, awaitingSend: null, myTurns: [...pane.myTurns, msg.turnId], session: { ...sess, engine, ...sandbox } };
      }
      if (p.handoff && p.handoff.turnId === null && msg.clientRef !== undefined && msg.clientRef === p.handoff.ref) p = { ...p, handoff: { ...p.handoff, turnId: msg.turnId } };
      if (!belongs(p, msg)) return p;
      // A queued copy of this very message (kept paused after a reload, an in_flight refusal): it went in — not sent again.
      const dup = msg.clientRef !== undefined ? p.queue.find((q) => q.ref === msg.clientRef && !q.steer) : undefined;
      if (dup) p = { ...p, queue: p.queue.filter((q) => q !== dup), ...(p.queueSendNow === dup.id ? { queueSendNow: null } : {}) };
      const last = p.items.findLastIndex((it) => it.kind === 'assistant' && it.turnId === msg.turnId);
      // Another device's (or pane's) message: its bubble goes before the turn's answer. The sending pane shows it already ('sent').
      const echo = msg.prompt && !p.myTurns.includes(msg.turnId) ? [promptItem(msg.prompt, nextUserN(p.items, p.session))] : [];
      const items = last >= 0 ? p.items.map((it, i) => (i === last ? { ...it, streaming: true } : it)) : [...p.items, ...echo, streamingItem(msg.turnId)];
      // The timer runs from the send (sent) or from this start; a retry of the same turn keeps it.
      const runStartedAt = p.activeTurnId === msg.turnId || (p.runStartedAt !== null && p.activeTurnId === null) ? (p.runStartedAt ?? Date.now()) : Date.now();
      // The session's model as stored after this send (picked on another pane or device): a pane that picked none shows it.
      const follow = msg.sessionModel && !p.modelPicked && (msg.engine ?? 'claude') === 'claude' ? { model: msg.sessionModel } : {};
      return { ...p, items, activeTurnId: msg.turnId, runStartedAt, progress: p.activeTurnId === msg.turnId ? p.progress : null, ...follow };
    }
    case 'turn_progress':
      if (!belongs(pane, msg) || msg.turnId !== pane.activeTurnId) return pane;
      return { ...pane, progress: { outputTokens: msg.outputTokens, phase: msg.phase } };
    case 'task_update': {
      if (!belongs(pane, msg)) return pane;
      // A patch (task_updated) has no Agent call id: find the card by task id.
      const id = msg.toolUseId ?? Object.keys(pane.agents).find((k) => pane.agents[k]!.taskId === msg.taskId);
      if (!id) return pane;
      const now = Date.now();
      const fresh = !pane.agents[id];
      return withAgent(pane, id, (a) => ({
        ...a,
        taskId: msg.taskId,
        ...(msg.status ? { status: msg.status, endedAt: msg.status === 'running' ? null : (a.endedAt ?? now) } : {}),
        ...(msg.description !== undefined ? { description: msg.description } : {}),
        ...(msg.subagentType ? { subagentType: msg.subagentType } : {}),
        ...(msg.backgrounded !== undefined ? { backgrounded: msg.backgrounded } : {}),
        ...(msg.usage ? { usage: msg.usage } : {}),
        ...(msg.lastToolName ? { lastToolName: msg.lastToolName } : {}),
        ...(msg.ageMs !== undefined && fresh ? { startedAt: now - msg.ageMs } : {}),
      }));
    }
    case 'task_done': {
      if (!belongs(pane, msg)) return pane;
      const id = msg.toolUseId ?? (msg.taskId ? Object.keys(pane.agents).find((k) => pane.agents[k]!.taskId === msg.taskId) : undefined);
      if (!id || !pane.agents[id]) return pane;
      return withAgent(pane, id, (a) => ({ ...a, status: msg.status, endedAt: a.endedAt ?? Date.now(), ...(msg.usage ? { usage: msg.usage } : {}) }));
    }
    case 'sub_tool_call': {
      if (!belongs(pane, msg)) return pane;
      const id = agentFor(pane.agents, msg.parentToolUseId) ?? msg.parentToolUseId;
      return withAgent(pane, id, (a) => (a.calls.some((c) => c.toolUseId === msg.toolUseId) ? a : { ...a, calls: [...a.calls, { toolUseId: msg.toolUseId, name: msg.name, input: msg.input, done: false, isError: false }] }));
    }
    case 'sub_tool_result': {
      if (!belongs(pane, msg)) return pane;
      const id = agentFor(pane.agents, msg.parentToolUseId);
      if (!id) return pane;
      return withAgent(pane, id, (a) => ({ ...a, calls: a.calls.map((c) => (c.toolUseId === msg.toolUseId ? { ...c, done: true, isError: msg.isError } : c)) }));
    }
    case 'thinking':
      if (!belongs(pane, msg)) return pane;
      return updateTurn(pane, msg.turnId, (it) => {
        const t = it.thinking;
        // A new thinking block (empty chunk) after an earlier one: separate the texts, keep the first start.
        const sep = !msg.text && t?.text ? '\n\n' : '';
        return { ...it, thinking: { text: (t?.text ?? '') + sep + msg.text, redacted: (t?.redacted ?? false) || !!msg.redacted, startedAt: !t ? Date.now() : t.ms !== null ? Date.now() - t.ms : t.startedAt, ms: null } };
      });
    case 'delta':
      if (!belongs(pane, msg)) return pane;
      return updateTurn(pane, msg.turnId, (it) => ({ ...endThinking(it), text: it.text + msg.text }));
    case 'tool_call':
      if (!belongs(pane, msg)) return pane;
      return updateTurn(pane, msg.turnId, (it) => ({ ...endThinking(it), toolCalls: [...it.toolCalls, { toolUseId: msg.toolUseId, name: msg.name, input: msg.input, result: null, isError: false }] }));
    case 'tool_result': {
      if (!belongs(pane, msg)) return pane;
      // The item holding the call (a steer may have split the turn since).
      const at = pane.items.findLastIndex((it) => it.kind === 'assistant' && it.turnId === msg.turnId && it.toolCalls.some((t) => t.toolUseId === msg.toolUseId));
      if (at < 0) return pane;
      const items = pane.items.slice();
      const it = items[at] as AssistantItem;
      items[at] = { ...it, toolCalls: it.toolCalls.map((t) => (t.toolUseId === msg.toolUseId ? { ...t, result: msg.content, isError: msg.isError } : t)) };
      return { ...pane, items };
    }
    case 'steer_delivered': {
      // The sending pane knows it by its queue item; other panes / devices show the server's copy of the prompt.
      const q = pane.queue.find((x) => x.steer === msg.steerId || x.lostSteer === msg.steerId);
      if (!q && !belongs(pane, msg)) return pane;
      // Re-sent after history: the transcript usually logged it already (as the CLI's queued_command) — shown once.
      if (!q && msg.replay && pane.items.slice(-20).some((it) => it.kind === 'user' && (it.text === msg.prompt.text || it.text.startsWith(`${msg.prompt.text}\n`)))) return pane;
      const n = nextUserN(pane.items, pane.session);
      const bubble: ChatItem = q
        ? { kind: 'user', text: q.text, ...(q.attachments.length ? { attachments: q.attachments.map(({ id, name, isImage }) => ({ id, name, isImage })) } : {}), ...(n !== undefined ? { n } : {}) }
        : promptItem(msg.prompt, n);
      const items = withSteerBubble(pane.items, msg.turnId, bubble);
      return q ? { ...pane, items, queue: pane.queue.filter((x) => x !== q), ...(pane.queueSendNow === q.id ? { queueSendNow: null } : {}) } : { ...pane, items };
    }
    case 'steer_rejected':
      // Not taken into the running turn: an ordinary queue item now, sent after the turn.
      // Refused because the server is restarting: held until the reconnect instead.
      if (!pane.queue.some((q) => q.steer === msg.steerId)) return pane;
      // Already in (or going in) under this id: a resent copy — dropped, never queued again.
      if (msg.code === 'already_accepted') {
        const q = pane.queue.find((x) => x.steer === msg.steerId)!;
        console.warn('deck: steer already went in — not sent again:', q.text);
        return { ...pane, queue: pane.queue.filter((x) => x !== q), ...(pane.queueSendNow === q.id ? { queueSendNow: null } : {}) };
      }
      // Going in right now under this id (another tab's copy, a retry): it may still fail — kept, paused, never resent by itself.
      if (msg.code === 'in_flight') return unsteer(pane, (id) => id === msg.steerId);
      return { ...pane, queue: pane.queue.map(({ steer, ...q }) => (steer === msg.steerId ? { ...q, ...(msg.code === 'draining' ? { restart: 'hold' as const } : {}) } : { ...q, ...(steer ? { steer } : {}) })) };
    case 'turn_retry':
      if (!belongs(pane, msg)) return pane;
      // Review M11: the retry streams into a fresh segment; the failed attempt's text is kept apart.
      return updateTurn(pane, msg.turnId, ({ thinking: _drop, ...it }) => ({ ...it, text: '', attempts: it.text ? [...it.attempts, it.text] : it.attempts, notes: [...it.notes, `재시도 ${seatLabel(accounts, msg.fromAccount)} → ${seatLabel(accounts, msg.toAccount)}: ${msg.reason}`] }));
    case 'turn_background': {
      if (!belongs(pane, msg)) return pane;
      // One pill per pane (one process per session); [] clears it.
      if (!msg.tasks.length) return pane.bg ? { ...pane, bg: null } : pane;
      return { ...pane, bg: { turnId: msg.turnId, tasks: msg.tasks, detail: msg.detail ?? [], receivedAt: Date.now(), canStop: msg.canStop === true } };
    }
    case 'turn_notice': {
      if (!belongs(pane, msg)) return pane;
      const next = msg.turnId ? updateTurn(pane, msg.turnId, (it) => ({ ...it, notes: [...it.notes, msg.message] })) : pane;
      if (next !== pane) return next;
      // No turn item owns it (a notice on opening the session): the pane's own bar, never the app-wide banner.
      return withNotice(pane, { sessionId: msg.sessionId ?? pane.session?.sessionId ?? null, message: msg.message, level: 'notice' });
    }
    case 'turn_system':
      if (!belongs(pane, msg)) return pane;
      // Where the turn's answer stands now: what streamed so far closes, the rest streams after the row.
      return { ...pane, items: withSteerBubble(pane.items, msg.turnId, { kind: 'system', source: msg.source, label: msg.label, text: msg.text }) };
    case 'turn_result': {
      const mine = pane.myTurns.includes(msg.turnId);
      const myTurns = mine ? pane.myTurns.filter((t) => t !== msg.turnId) : pane.myTurns;
      if (!belongs(pane, msg)) return myTurns === pane.myTurns ? pane : { ...pane, myTurns };
      const b = msg.badge;
      const prev = latestContext(pane.items);
      const ctx: ContextInfo | null = b?.usage.context ? { usage: b.usage.context, window: b.usage.contextWindow ?? contextWindowOf(b.model), at: Date.now(), model: b.model, account: b.account } : null;
      const cacheNote = b ? coldWriteNote(b.usage, prev, { account: b.account, model: b.model, reason: b.reason, startedAt: pane.runStartedAt ?? Date.now() }) : null;
      const next = updateTurn(pane, msg.turnId, (it) => ({ ...it, streaming: false, badge: msg.badge ?? it.badge, text: it.text || msg.text, error: msg.ok ? null : (msg.errorText ?? '실패'), ...(ctx ? { ctx } : {}), ...(cacheNote ? { cacheNote } : {}) }));
      // Only a turn this pane started may re-point the pane's session (id / account).
      const session = mine && next.session ? { ...next.session, sessionId: msg.sessionId || next.session.sessionId, account: msg.badge?.account ?? next.session.account } : next.session;
      // ux-state: a failed (or stopped) turn of this pane pauses its queue instead of firing the next message into it.
      const queuePaused = next.queuePaused || ((mine || pane.activeTurnId === msg.turnId) && !msg.ok);
      const ended = pane.activeTurnId === msg.turnId;
      const done: PaneState = { ...next, session, myTurns, queuePaused, activeTurnId: ended ? null : pane.activeTurnId, ...(ended ? { runStartedAt: null, progress: null } : {}) };
      return pane.handoff?.turnId === msg.turnId ? afterHandoffNote(done, msg.ok, accounts) : done;
    }
    case 'error': {
      // This session's open_session failed while messages wait for its history: they stop waiting — ordinary queue items,
      // paused, so nothing hangs on a history that never comes. (Not the drain broadcast: the history still comes.)
      if (msg.turnId === null && msg.clientRef === undefined && msg.code !== 'draining' && msg.sessionId !== undefined && msg.sessionId === pane.session?.sessionId && pane.queue.some((q) => q.restart === 'hello')) {
        pane = { ...pane, queue: pane.queue.map(({ restart, maybeSent, ...q }) => (restart === 'hello' ? q : { ...q, ...(restart ? { restart } : {}), ...(maybeSent !== undefined ? { maybeSent } : {}) })), queuePaused: true };
      }
      const withItem = msg.turnId ? updateTurn(pane, msg.turnId, (it) => ({ ...it, streaming: false, error: it.error ?? msg.message })) : pane;
      // Review I6: an error that names the running turn ends it, or the composer stays locked on 중단.
      const activeTurnId = msg.turnId !== null && msg.turnId === pane.activeTurnId ? null : withItem.activeTurnId;
      const stop = activeTurnId === null && pane.activeTurnId !== null ? { runStartedAt: null, progress: null } : {};
      // A send refused before its turn started (busy session, bad cwd, unknown session) ends the wait.
      // With a clientRef only the error echoing it ends the wait, so another pane's error never unlocks this one.
      const ends = pane.awaitingRef !== null
        ? msg.clientRef === pane.awaitingRef
        : msg.clientRef === undefined && (msg.turnId === null || !pane.myTurns.includes(msg.turnId));
      // ux-state: a refused send pauses the queue too (it would only be refused again).
      const idle = ends && activeTurnId === null ? { runStartedAt: null, progress: null } : stop;
      // A refused or failed handoff-note send leaves the pane where it is.
      const handoff = pane.handoff && ((msg.clientRef !== undefined && msg.clientRef === pane.handoff.ref) || (msg.turnId !== null && msg.turnId === pane.handoff.turnId)) ? { handoff: null } : {};
      if (!ends) return { ...withItem, activeTurnId, ...stop, ...handoff };
      // A resent copy the server already has: the wait ends, nothing goes back into the queue (and its bubble is the old one's).
      if (msg.code === 'already_accepted') {
        const back = pane.awaitingSend;
        console.warn('deck: message already went in — not sent again:', back?.text);
        const last = withItem.items[withItem.items.length - 1];
        const items = back && last?.kind === 'user' && last.text === back.text ? withItem.items.slice(0, -1) : withItem.items;
        return { ...withItem, items, activeTurnId, awaitingStart: false, awaitingRef: null, awaitingSend: null, ...idle, ...handoff };
      }
      // Refused before its turn started (an older server names the turn it never started): back into the queue (requeue).
      const back = (msg.turnId === null || !pane.myTurns.includes(msg.turnId)) && pane.awaitingRef !== null ? pane.awaitingSend : null;
      if (!back) return { ...withItem, activeTurnId, awaitingStart: false, awaitingRef: null, awaitingSend: null, queuePaused: withItem.queuePaused || withItem.queue.length > 0, ...idle, ...handoff };
      return { ...requeue(withItem, back, msg.code === 'draining' ? 'draining' : 'refused'), activeTurnId, ...idle, ...handoff };
    }
    default:
      return pane;
  }
}

/**
 * 새 세션으로 이어가기, step 2: the note is written — the pane opens a new session in the same folder, titled
 * "<old title> (이어서)", with the first message (note included) in the composer. Nothing is sent until the user does.
 * A failed or empty note leaves the pane on the old session (the turn shows its error).
 */
function afterHandoffNote(pane: PaneState, ok: boolean, accounts: readonly AccountInfo[]): PaneState {
  const h = pane.handoff!;
  const item = pane.items.findLast((it) => it.kind === 'assistant' && it.turnId === h.turnId);
  const note = item?.kind === 'assistant' ? item.text.trim() : '';
  if (!ok || !note) return { ...pane, handoff: null };
  return {
    ...pane,
    // The old session's account pin carries over (rides the new session's first send) — unless its account cannot run a turn any more.
    session: { sessionId: null, cwd: h.cwd, account: null, title: handoffTitle(h.title), engine: 'claude', sandbox: null, ...(activePin(accounts, pane.session?.accountPin) ? { accountPin: pane.session!.accountPin } : {}), ...(pane.session?.permissionMode ? { permissionMode: pane.session.permissionMode } : {}) },
    engine: 'claude',
    items: [], activeTurnId: null, myTurns: [], awaitingStart: false, awaitingRef: null, awaitingSend: null, attachments: [],
    // Messages queued meanwhile stay, paused: they were meant for the old session (held ones are parked with it: onServer).
    queue: pane.queue.filter((q) => !isHeld(q)), queuePaused: pane.queuePaused || pane.queue.some((q) => !isHeld(q)),
    ...ACTIVITY_RESET,
    handoff: null,
    notices: [],
    handoffFrom: { sessionId: h.sessionId, title: h.title },
    prefill: handoffFirstMessage(h.title, h.sessionId, note),
  };
}

function mapPanes(state: AppState, msg: ServerMessage): PaneState[] {
  return state.panes.map((p) => paneOnServer(p, msg, false, state.accounts));
}

/**
 * Once the server knows a session's real title (derived server-side, e.g. from the first prompt line),
 * it appears in the project index; adopt it into any pane still showing the placeholder `... 새 세션` title.
 */
function applyTitles(panes: PaneState[], projects: ProjectEntry[]): PaneState[] {
  return panes.map((p) => {
    const sessionId = p.session?.sessionId;
    if (!sessionId) {
      // a pending 이어서 whose old session already continues elsewhere (e.g. a reload mid first send) can't link again
      const from = p.handoffFrom?.sessionId;
      return from && projects.some((pr) => pr.sessions.some((s) => s.sessionId === from && s.nextSession)) ? { ...p, handoffFrom: null } : p;
    }
    const found = projects.flatMap((pr) => pr.sessions).find((s) => s.sessionId === sessionId);
    return found && found.title !== p.session!.title ? { ...p, session: { ...p.session!, title: found.title } } : p;
  });
}

/** The mode a pane's session runs in: its own, else the server's default for new sessions. */
export function paneMode(pane: PaneState, defaultMode: PermMode | null): PermMode {
  return pane.session?.permissionMode ?? defaultMode ?? 'default';
}

/** 자동 승인 changes the default sandbox of new GPT sessions; panes still on the old default follow it. */
function applySettings(state: AppState, settings: DeckSettings | undefined): AppState {
  if (!settings) return state;
  if (settings.defaultPermissionMode !== state.defaultPermMode) state = { ...state, defaultPermMode: settings.defaultPermissionMode };
  if ((settings.routingPolicy ?? 'balance') !== state.routingPolicy) state = { ...state, routingPolicy: settings.routingPolicy ?? 'balance' };
  if (settings.autoApprove === state.autoApprove) return state;
  const from = defaultSandbox(state.autoApprove ?? false);
  const to = defaultSandbox(settings.autoApprove);
  return { ...state, autoApprove: settings.autoApprove, panes: state.panes.map((p) => (p.sandbox === from ? { ...p, sandbox: to } : p)) };
}

function onServer(state: AppState, msg: ServerMessage): AppState {
  switch (msg.type) {
    case 'hello': {
      const listed = has('accounts') ? accountListOf(msg.accounts) : LEGACY_ACCOUNT_LIST;
      // The same list as before keeps its identity (nothing drawn from it renders again).
      const accounts = sameAccountList(state.accounts, listed) ? state.accounts : listed;
      // A new session waiting with a pin this server cannot run on (its list changed, or the pin was restored from an older
      // one): back to 자동, said once. An existing session's pin is the server's.
      const panes = mapPanes(state, msg).map((p) => {
        const pin = p.session?.sessionId === null ? p.session.accountPin : null;
        if (!pin || activePin(accounts, pin)) return p;
        return withNotice({ ...p, session: { ...p.session!, accountPin: null } }, { sessionId: null, message: `고정해 둔 계정(${seatLabel(accounts, pin)})을 지금 쓸 수 없어 자동으로 바꿨습니다`, level: 'notice' });
      });
      return applySettings({ ...state, connected: true, ready: true, activity: msg.activity ?? state.activity, usage: msg.usage, accounts, projects: msg.projects, pins: msg.pins ?? state.pins, desktop: msg.desktop ?? state.desktop, codexAvailable: msg.codex.available, gemini: msg.gemini ?? null, panes: applyTitles(panes, msg.projects) }, msg.settings);
    }
    case 'settings': return applySettings(state, msg.settings);
    // A mode the user picked before the id arrived wins: it is on its way to the server.
    case 'permission_mode': return { ...state, panes: state.panes.map((p) => (p.session?.sessionId === msg.sessionId && !p.session.permissionModePending ? { ...p, session: { ...p.session, permissionMode: msg.mode } } : p)) };
    case 'account_pin': return { ...state, panes: state.panes.map((p) => (p.session?.sessionId === msg.sessionId ? { ...p, session: { ...p.session, accountPin: msg.pin } } : p)) };
    case 'usage': return { ...state, usage: msg.usage };
    case 'index': return { ...state, projects: msg.projects, pins: msg.pins ?? state.pins, desktop: msg.desktop ?? state.desktop, panes: applyTitles(state.panes, msg.projects) };
    case 'history': case 'catchup': {
      // Every pane with this session open (`open` records the id before open_session is sent, so a pane still
      // waiting for its reply counts). A history no pane views — its pane was closed or switched while the reply
      // was in flight — is dropped, never adopted by a blank pane (T9 prerequisite b).
      if (!state.panes.some((p) => p.session?.sessionId === msg.sessionId)) return state;
      const doubt = inDoubt(msg, Date.now());
      const doubted = state.panes.filter((p) => p.session?.sessionId === msg.sessionId).flatMap((p) => p.queue.filter(doubt).map((q) => q.text || '첨부만'));
      return { ...state, ...(doubted.length ? { error: `이미 들어갔을 수 있어 멈춰 둔 메시지: ${doubted.join(' / ')}` } : {}), panes: state.panes.map((p) => (p.session?.sessionId === msg.sessionId ? { ...paneOnServer(p, msg, false, state.accounts), loading: false } : p)) };
    }
    case 'permission_request': {
      // Prompts from every session are shown (any device may answer); replays on reconnect are deduped (review M10).
      if (state.pending.some((p) => p.requestId === msg.requestId)) return state;
      const { type: _t, ...req } = msg;
      return { ...state, pending: [...state.pending, req] };
    }
    case 'permission_resolved': return { ...state, pending: state.pending.filter((p) => p.requestId !== msg.requestId) };
    case 'question_request': {
      if (state.questions.some((q) => q.requestId === msg.requestId)) return state;
      const { type: _t, ...req } = msg;
      return { ...state, questions: [...state.questions, req] };
    }
    case 'question_resolved': return { ...state, questions: state.questions.filter((q) => q.requestId !== msg.requestId) };
    case 'turn_started': {
      let claimed = false;
      const panes = state.panes.map((p) => {
        const canClaim = !claimed && p.awaitingStart;
        const next = paneOnServer(p, msg, canClaim, state.accounts);
        if (canClaim && next.myTurns.includes(msg.turnId)) claimed = true;
        return next;
      });
      return { ...state, panes };
    }
    case 'thinking': case 'delta': case 'tool_call': case 'tool_result': case 'turn_retry': case 'turn_background':
    case 'turn_progress': case 'task_update': case 'task_done': case 'sub_tool_call': case 'sub_tool_result':
      return { ...state, panes: mapPanes(state, msg) };
    case 'steer_delivered': case 'steer_rejected': {
      const kept = msg.type === 'steer_rejected' && msg.code === 'in_flight' && state.panes.some((p) => p.queue.some((q) => q.steer === msg.steerId));
      const away = settleParkedSteer(state.parked, msg);
      return { ...state, parked: away.parked, panes: mapPanes(state, msg), ...(kept ? { error: msg.message } : away.error ? { error: away.error } : {}) };
    }
    case 'activity': {
      // A turn that finished while no focused pane showed its session leaves an unread dot.
      const focused = state.panes.find((p) => p.id === state.activePaneId)?.session?.sessionId ?? null;
      const finished = state.activity.filter((a) => a.running && !msg.sessions.some((n) => n.sessionId === a.sessionId && n.running)).map((a) => a.sessionId);
      const add = finished.filter((sid) => sid !== focused && !state.unread.includes(sid));
      return { ...state, activity: msg.sessions, unread: add.length ? [...state.unread, ...add] : state.unread, panes: mapPanes(state, msg) };
    }
    // Pane-scoped: a turn's notes, else the bar of the panes showing that session. Other sessions' notices are ignored.
    case 'turn_notice': case 'turn_system':
      return { ...state, panes: mapPanes(state, msg) };
    case 'turn_result': {
      // 새 세션으로 이어가기 moved a pane to its new session: its held messages stay with the old one (parked).
      let parked = state.parked;
      const panes = mapPanes(state, msg);
      state.panes.forEach((p, i) => {
        const was = p.session?.sessionId;
        if (was && p.handoff?.turnId === msg.turnId && panes[i]!.session?.sessionId === null) parked = parkHeld(parked, was, p.session!.cwd, p.queue).parked;
      });
      return { ...state, parked, panes, pending: state.pending.filter((p) => p.turnId !== msg.turnId), questions: state.questions.filter((q) => q.turnId !== msg.turnId) };
    }
    case 'error': {
      // About one session (e.g. its history could not be read): the bar of the panes showing it, if any; else app-wide.
      // already_accepted: nothing failed (a resent copy was refused) — no error bar.
      if (msg.code === 'already_accepted') return { ...state, panes: mapPanes(state, msg) };
      const sid = msg.sessionId;
      if (sid && state.panes.some((p) => p.session?.sessionId === sid)) {
        return { ...state, panes: mapPanes(state, msg).map((p) => (p.session?.sessionId === sid ? { ...withNotice(p, { sessionId: sid, message: msg.message, level: 'error' }), loading: false } : p)) };
      }
      // Not tied to a shown session: no pane can wait on it, so a loading placeholder would never clear — drop them.
      return { ...state, panes: mapPanes(state, msg).map((p) => (p.loading ? { ...p, loading: false } : p)), error: msg.message };
    }
  }
}

/**
 * The pane is about to leave its session: messages held for a restart (or maybe lost with a socket) are kept with that
 * session, plain and paused, until it is opened again. A new session has no id: they wait for the next new session in
 * that folder (`parkKey`), and the error bar says so.
 */
function park(state: AppState, paneId: string | undefined): AppState {
  const p = state.panes.find((x) => x.id === (paneId ?? state.activePaneId));
  const s = p?.session;
  if (!p || !s || !p.queue.length) return state;
  const held = p.queue.filter(isHeld);
  // The rest of the queue (typed for this session, never sent) is let go with the session — never silently.
  const dropped = p.queue.filter((q) => !isHeld(q));
  const unsent = held.filter((q) => !q.steer);
  const texts = (qs: QueueItem[]) => qs.map((q) => q.text || '첨부만').join(' / ');
  if (dropped.length) console.warn('deck: queued messages dropped with their session:', dropped.map((q) => q.text));
  const notes = [
    // A steer still on its way is not unsent: it is not announced (its answer settles the parked copy).
    ...(unsent.length && !s.sessionId ? [`보내지 못한 메시지 ${unsent.length}개는 이 폴더에서 새 세션을 열면 큐로 돌아옵니다: ${texts(unsent)}`] : []),
    ...(dropped.length ? [`큐에서 빠진 메시지 ${dropped.length}개: ${texts(dropped)}`] : []),
  ];
  const error = notes.length ? { error: notes.join(' · ') } : {};
  if (!held.length) return { ...state, ...error };
  const key = parkKey(s.sessionId, s.cwd);
  const parked = { ...state.parked, [key]: { cwd: s.cwd, queue: [...(state.parked[key]?.queue ?? []), ...held.map(toParked)] } };
  return { ...state, parked, ...error };
}

function updatePane(state: AppState, paneId: string | undefined, fn: (p: PaneState) => PaneState): AppState {
  const id = paneId ?? state.activePaneId;
  return { ...state, panes: state.panes.map((p) => (p.id === id ? fn(p) : p)) };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'server': {
      const next = onServer(state, action.msg);
      const msg = action.msg;
      if (msg.type !== 'history' || !action.sentFiles?.length) return next;
      const records = action.sentFiles;
      return { ...next, panes: next.panes.map((p) => (p.session?.sessionId === msg.sessionId ? { ...p, items: restoreSentFiles(p.items, records) } : p)) };
    }
    case 'connected': return { ...state, connected: action.value, ...(action.value ? {} : { ready: false }) };
    // Prompts stay: they belong to their own session and the card says which (review I3).
    case 'open': {
      // Opening the session the pane already shows (a reload of it) keeps its queue and pending send as they are.
      const pane = state.panes.find((x) => x.id === (action.paneId ?? state.activePaneId));
      const same = !!pane && action.sessionId !== null && pane.session?.sessionId === action.sessionId;
      const s = same ? state : park(state, action.paneId);
      // Messages kept with this session (park; a new session: with its folder) come back, paused — and stay kept.
      const key = parkKey(action.sessionId, action.cwd);
      const back = s.parked[key]?.queue.map((q): QueueItem => ({ ...q, kept: true }));
      const { [key]: _back, ...parked } = s.parked;
      return updatePane({ ...s, parked: back ? parked : s.parked, unread: action.sessionId ? s.unread.filter((u) => u !== action.sessionId) : s.unread }, action.paneId, (p) => ({
        ...p,
        session: { sessionId: action.sessionId, cwd: action.cwd, account: null, title: action.title, engine: action.sessionId === null && p.engine !== 'auto' ? p.engine : null, sandbox: null },
        items: [], activeTurnId: null, myTurns: [], attachments: [], ...ACTIVITY_RESET, loading: action.sessionId !== null,
        ...(same
          ? { queue: [...p.queue, ...(back ?? [])], queuePaused: p.queuePaused || !!back }
          : { awaitingStart: false, awaitingRef: null, awaitingSend: null, queue: back ?? [], queuePaused: !!back, queueSendNow: null,
              // Another session: its model is its own again (history shows it); a new one starts on the default unless picked.
              modelPicked: false, ...(action.sessionId === null && !p.modelPicked && engineOf(p.model) === 'claude' ? { model: DEFAULT_MODEL } : {}) }),
        handoff: null, handoffFrom: null, prefill: null, notices: [],
      }));
    }
    case 'branch_undo': {
      const p = state.panes.find((x) => x.id === (action.paneId ?? state.activePaneId));
      if (!p?.session || p.session.sessionId !== null || p.myTurns.length || !p.queue.length) return state;
      // Parked with the original session, ahead of what was parked there: the `open` that follows restores it, paused.
      const was = state.parked[action.sessionId]?.queue ?? [];
      const parked = { ...state.parked, [action.sessionId]: { cwd: p.session.cwd, queue: [...unhold(p.queue), ...was] } };
      return updatePane({ ...state, parked }, p.id, (x) => ({ ...x, queue: [], queueSendNow: null }));
    }
    case 'branch_edit': {
      const p = state.panes.find((x) => x.id === (action.paneId ?? state.activePaneId));
      if (!p?.session) return state;
      // Held messages stay with the parent session (parked); only plain queued ones follow into the fork, paused.
      const split = p.session.sessionId ? parkHeld(state.parked, p.session.sessionId, p.session.cwd, p.queue) : { parked: state.parked, queue: unhold(p.queue) };
      const at = p.items.findIndex((it) => it.kind === 'user' && it.n === action.n);
      // The history before the edited message stays on screen (the fork shares it); the edited text replaces the rest.
      const kept = at >= 0 ? p.items.slice(0, at) : p.items;
      return updatePane({ ...state, parked: split.parked }, p.id, () => ({
        ...p,
        // The server forks in the parent's mode; the pane shows that mode until the fork's own arrives.
        session: { sessionId: null, cwd: p.session!.cwd, account: null, title: p.session!.title, engine: 'claude', sandbox: null, ...(activePin(state.accounts, p.session!.accountPin) ? { accountPin: p.session!.accountPin } : {}), ...(p.session!.permissionMode ? { permissionMode: p.session!.permissionMode } : {}) },
        items: [...kept, { kind: 'user', text: action.text, n: action.n }],
        // A refused fork keeps its text (paused in the queue); messages queued for the parent stay, paused.
        activeTurnId: null, myTurns: [], awaitingStart: true, awaitingRef: action.clientRef ?? null, awaitingSend: { text: action.text, attachments: [], branch: true },
        queue: split.queue, queuePaused: p.queuePaused || split.queue.length > 0,
        ...ACTIVITY_RESET, runStartedAt: Date.now(), handoff: null, handoffFrom: null, prefill: null, notices: [],
      }));
    }
    case 'sent': return updatePane(state, action.paneId, (p) => {
      const n = nextUserN(p.items, p.session);
      return {
        ...p,
        // A new session is sent with the picker's model: the session keeps sending it.
        ...(p.session?.sessionId === null ? { modelPicked: true } : {}),
        items: [...p.items, { kind: 'user', text: action.text, ...(action.attachments?.length ? { attachments: action.attachments } : {}), ...withN(n) }],
        awaitingStart: true, awaitingRef: action.clientRef ?? null, awaitingSend: action.handoff ? null : { text: action.text, attachments: action.attachments ?? [], ...withN(n), at: Date.now() }, attachments: [], queuePaused: action.keepPaused ? p.queuePaused : false, prefill: null,
        ...(p.activeTurnId === null ? { runStartedAt: Date.now(), progress: null } : {}),
        ...(action.handoff && action.clientRef && p.session?.sessionId ? { handoff: { ref: action.clientRef, turnId: null, sessionId: p.session.sessionId, title: p.session.title, cwd: p.session.cwd } } : {}),
      };
    });
    case 'set_model': return updatePane(state, action.paneId, (p) => ({ ...p, model: action.model, modelPicked: true }));
    case 'set_effort': return updatePane(state, action.paneId, (p) => ({ ...p, efforts: { ...p.efforts, [action.engine]: action.effort } }));
    case 'set_auto_effort': return updatePane(state, action.paneId, (p) => ({ ...p, autoEffort: action.effort }));
    case 'set_engine': return updatePane(state, action.paneId, (p) => ({ ...p, engine: action.engine, model: action.engine === 'auto' ? (isGeminiModel(p.model) ? DEFAULT_MODEL : p.model) : modelFor(action.engine, p.model) }));
    case 'set_sandbox': return updatePane(state, action.paneId, (p) => ({ ...p, sandbox: action.sandbox }));
    case 'set_account_pin': return updatePane(state, action.paneId, (p) => (p.session ? { ...p, session: { ...p.session, accountPin: action.pin } } : p));
    case 'set_permission_mode': return updatePane(state, action.paneId, (p) => {
      if (!p.session) return p;
      // A new session whose first turn is already out: the send carried the old mode, so this one waits for the id.
      const { permissionModePending: _was, ...session } = p.session;
      const pending = session.sessionId === null && (p.awaitingStart || p.myTurns.length > 0);
      return { ...p, session: { ...session, permissionMode: action.mode, ...(pending ? { permissionModePending: true as const } : {}) } };
    });
    case 'attach': return updatePane(state, action.paneId, (p) => (p.attachments.some((a) => a.id === action.attachment.id) ? p : { ...p, attachments: [...p.attachments, action.attachment] }));
    case 'unattach': return updatePane(state, action.paneId, (p) => ({ ...p, attachments: p.attachments.filter((a) => a.id !== action.id) }));
    case 'clear_pane': return updatePane(park(state, action.paneId), action.paneId, (p) => ({
      ...p, session: null, items: [], activeTurnId: null, myTurns: [], awaitingStart: false, awaitingRef: null, awaitingSend: null, attachments: [], queue: [], queuePaused: false, queueSendNow: null, ...ACTIVITY_RESET, loading: false,
      handoff: null, handoffFrom: null, prefill: null, notices: [],
    }));
    case 'add_pane': {
      if (state.panes.length >= MAX_PANES) return state;
      const n = Math.max(...state.panes.map((p) => Number(p.id.slice(1)) || 0)) + 1;
      const pane = { ...newPane(`p${n}`), sandbox: defaultSandbox(state.autoApprove ?? false) };
      return { ...state, panes: [...state.panes, pane], activePaneId: pane.id };
    }
    case 'close_pane': {
      if (state.panes.length <= 1) return state;
      const panes = state.panes.filter((p) => p.id !== action.paneId);
      return { ...park(state, action.paneId), panes, activePaneId: state.activePaneId === action.paneId ? panes[0]!.id : state.activePaneId };
    }
    case 'focus_pane': {
      const pane = state.panes.find((p) => p.id === action.paneId);
      if (!pane) return state;
      const sid = pane.session?.sessionId;
      return { ...state, activePaneId: action.paneId, unread: sid && state.unread.includes(sid) ? state.unread.filter((u) => u !== sid) : state.unread };
    }
    case 'dismiss_error': return { ...state, error: null };
    case 'dismiss_notice': return updatePane(state, action.paneId, (p) => (p.notices?.length ? { ...p, notices: action.message === undefined ? [] : p.notices.filter((n) => n.message !== action.message) } : p));
    case 'set_pins': return { ...state, pins: action.pins };
    case 'show_error': return { ...state, error: action.message };
    case 'queue_add': {
      const text = action.text.trim();
      return updatePane(state, action.paneId, (p) => (!text && !p.attachments.length ? p : { ...p, queue: [...p.queue, { id: nextQueueId(), text, attachments: p.attachments, ...(action.steerId ? { steer: action.steerId, at: Date.now() } : {}) }], attachments: [] }));
    }
    case 'queue_edit': return updatePane(state, action.paneId, (p) => ({ ...p, queue: p.queue.map((q) => (q.id === action.id ? { ...q, text: action.text } : q)) }));
    case 'queue_remove': return updatePane(state, action.paneId, (p) => ({ ...p, queue: p.queue.filter((q) => q.id !== action.id), ...(p.queueSendNow === action.id ? { queueSendNow: null } : {}) }));
    case 'queue_clear': return updatePane(state, action.paneId, (p) => ({ ...p, queue: [], queuePaused: false, queueSendNow: null }));
    case 'interrupt_sent': return updatePane(state, action.paneId, (p) => updateTurn(p, action.turnId, (it) => ({ ...it, interrupted: true })));
    case 'queue_send_now': return updatePane(state, action.paneId, (p) => {
      const item = p.queue.find((q) => q.id === action.id);
      if (!item) return p;
      // A message held for the server's restart goes now if the user says so.
      const { restart: _held, maybeSent: _m, ...head } = item;
      return { ...p, queue: [head, ...p.queue.filter((q) => q !== item)], queueSendNow: item.id };
    });
    case 'queue_pause': return updatePane(state, action.paneId, (p) => ({ ...p, queuePaused: true }));
    // 이어서 보내기: messages still waiting for a reconnect / history go as ordinary ones (the user says so).
    case 'queue_resume': return updatePane(state, action.paneId, (p) => ({ ...p, queuePaused: false, queue: p.queue.map((q) => (q.restart === 'hold' || q.restart === 'hello' ? unhold([q])[0]! : q)) }));
    case 'steer_lost': return updatePane(state, action.paneId, (p) => {
      if (action.unsent) return { ...p, queue: p.queue.map(({ steer, ...q }) => (steer === action.steerId ? q : { ...q, ...(steer ? { steer } : {}) })) };
      return unsteer(p, (id) => id === action.steerId);
    });
  }
}

/** The permission/question cards a pane shows: those of its session or of turns it started. */
export function cardsForPane<T extends { turnId: string; sessionId: string | null }>(pane: PaneState, cards: T[]): T[] {
  return cards.filter((c) => pane.myTurns.includes(c.turnId) || c.turnId === pane.activeTurnId || (c.sessionId !== null && c.sessionId === pane.session?.sessionId));
}

/** Cards no open pane claims (another device's session): shown in the app-level strip. */
export function orphanCards<T extends { turnId: string; sessionId: string | null }>(panes: PaneState[], cards: T[]): T[] {
  const shown = new Set(panes.flatMap((p) => cardsForPane(p, cards)));
  return cards.filter((c) => !shown.has(c));
}

/**
 * Sessions some pane viewed in `prev` that no pane views in `next` (pane closed or switched to another
 * session). The app sends `close_session` for each so the server's per-socket view set shrinks too.
 * A new session receiving its id (null → id) is not a release: null ids are never listed.
 */
export function sessionsToClose(prev: AppState, next: AppState): string[] {
  const viewed = (s: AppState) => new Set(s.panes.map((p) => p.session?.sessionId).filter((id): id is string => !!id));
  const still = viewed(next);
  return [...viewed(prev)].filter((id) => !still.has(id));
}

/**
 * The `question_response.answers` map: keyed by each asked question's exact text (the server drops
 * other keys); multi-select picks are comma-joined; unanswered questions are omitted; clipped to the protocol limits.
 */
export function answersFor(q: PendingQuestion, values: (string | string[])[]): Record<string, string> {
  const out: Record<string, string> = {};
  q.questions.forEach((question, i) => {
    const v = values[i];
    const text = (Array.isArray(v) ? v.join(', ') : (v ?? '')).slice(0, 4000);
    // protocol.ts question_response limits: keys 2000, values 4000.
    if (text) out[question.question.slice(0, 2000)] = text;
  });
  return out;
}

let queueSeq = 0;
export const nextQueueId = () => `q${++queueSeq}`;

/** ux-state: the queued message a pane should send now — its turn is over, nothing is pending, the queue isn't paused (or the item was 지금 전송). */
export function nextQueued(pane: PaneState): QueueItem | null {
  if (!pane.session || pane.activeTurnId !== null || pane.awaitingStart) return null;
  // 지금 전송 goes out even though the interrupt it caused paused the queue; its send unpauses the rest.
  const now = pane.queueSendNow ? pane.queue.find((q) => q.id === pane.queueSendNow) : undefined;
  if (now && !now.steer) return now;
  // Released after a restart: it goes out even if the queue is paused (its send keeps the pause for the rest).
  if (pane.queue[0]?.restart === 'go' && !pane.queue.some((q) => q.steer)) return pane.queue[0];
  if (pane.queuePaused) return null;
  // A message the restarting server refused heads the queue until the reconnect (and the history check) lets it go.
  if (pane.queue[0]?.restart) return null;
  // A steer still on its way may yet run as its own turn right after this one: later items wait for its answer
  // (bounded — useQueueRunner turns a steer still unanswered STEER_ANSWER_MS after the turn back into a paused item).
  if (pane.queue.some((q) => q.steer)) return null;
  return pane.queue[0] ?? null;
}

/**
 * Transcripts carry no attachment ids (images are inline blocks, files are path lines), so the files of
 * messages sent from this browser are matched back by text, in order: the transcript's user text starts
 * with what was typed, then a line break (the server appends path lines / an image marker after it).
 */
export function restoreSentFiles(items: ChatItem[], records: SentRecord[]): ChatItem[] {
  let r = 0;
  return items.map((it) => {
    if (it.kind !== 'user' || it.attachments?.length || r >= records.length) return it;
    for (let j = r; j < records.length; j++) {
      const rec = records[j]!;
      if (rec.text && (it.text === rec.text || it.text.startsWith(`${rec.text}\n`))) { r = j + 1; return { ...it, attachments: rec.files }; }
    }
    return it;
  });
}
