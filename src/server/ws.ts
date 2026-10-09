import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type http from 'node:http';
import os from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { isGeminiAccount, type AccountNames } from '../shared/accounts';
import { defaultSandbox, IMPORTED_DEFAULT_MODEL } from '../shared/models';
import { CLIENT_REF_MAX, ClientMessageSchema, FEATURES, accountInfos, type ClientMessage, type StreamPos, type GeminiStatus, type RefusalCode, type RunningTurn, type ServerMessage, type SessionActivity, type TurnPrompt } from '../shared/protocol';
import type { SessionEntry } from '../shared/session-types';
import type { PermissionDecision, QuestionAnswers } from '../shared/turn-types';
import { checkUpgrade } from './auth';
import type { AcceptedRefs } from './sessions/AcceptedRefs';
import { DirError, resolveUnderRoots } from './dirs';
import { HANDOFF_PROMPT, handoffTitle } from '../shared/handoff';
import { readCodexTranscript, readCodexTranscriptTail } from './engine/codexRollout';
import { sessionAllowLabel } from './engine/Engine';
import { displayError } from './engine/redact';
import { CWD_MISSING_NOTICE, importBlockReason, liveRolloutNotice, rolloutActiveAgeMs } from './sessions/CodexImports';
import { scanForeign } from './sessions/foreignWrites';
import { isPinnableId, type PinStore } from './sessions/PinStore';
import type { SessionMetaStore } from './sessions/SessionMetaStore';
import type { SettingsStore } from './settings';
import type { ProcessHolders } from './sessions/ProcessHolders';
import type { SessionIndex } from './sessions/SessionIndex';
import { readBranchPoint, readTranscript, type BranchPoint } from './sessions/transcript';
import { isCodexState, isGeminiState, type ClaudeSessionState, type SessionStateStore } from './turn/SessionState';
import { abortedText, SHUTDOWN_ABORT, type TurnRunner, type TurnSink } from './turn/TurnRunner';
import type { UsageService } from './usage/UsageService';

const FORK_NOTICE = "Desktop 에서 따로 이어진 대화가 있어 갈라졌습니다 — 머리글의 '갈라짐' 메뉴에서 어느 쪽으로 맞출지 고를 수 있습니다";

/** Following an outside write is silent; only background work the restarted process had to drop is worth a line (`n`: tasks stopped). */
export const recycleNotice = (n: number) => `deck 밖(Claude Desktop 등)에서 이어진 대화를 이어받느라, 기다리던 백그라운드 작업 ${n}개가 중단됐습니다`;

/** How often, while a browser is connected, deck looks for outside holders (one `ps`), outside writes to the open sessions and newer mtimes of the listed transcripts (a stat each). */
export const OUTSIDE_POLL_MS = 15_000;
/** An entry is stamped a moment before it reaches the file: writes this much older than the last history sent are looked at again. */
const OUTSIDE_SLACK_MS = 2000;

type PermissionMsg = Extract<ServerMessage, { type: 'permission_request' }>;
type QuestionMsg = Extract<ServerMessage, { type: 'question_request' }>;

export const PERMISSION_TIMEOUT_MS = 30 * 60_000;

/**
 * Holds unanswered prompts so a reconnecting browser sees them again (spec §8).
 * Review I5: a prompt also closes — with `cancelValue`, announced to every client via `onResolved` —
 * when its signal aborts, when its turn ends (cancelTurn), or after a long timeout.
 */
export class AskBroker<M extends { requestId: string; turnId: string }, R> {
  protected waiting = new Map<string, { msg: M; resolve: (r: R) => void; cleanup: () => void }>();

  constructor(
    private readonly send: (m: M) => void,
    private readonly onResolved: (requestId: string, result: R) => void,
    private readonly cancelValue: R,
    private readonly timeoutMs: number,
  ) {}

  ask(msg: M, signal?: AbortSignal): Promise<R> {
    if (signal?.aborted) return Promise.resolve(this.cancelValue);
    return new Promise((resolve) => {
      const onAbort = () => this.resolve(msg.requestId, this.cancelValue);
      const timer = setTimeout(onAbort, this.timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      this.waiting.set(msg.requestId, { msg, resolve, cleanup });
      this.send(msg);
    });
  }

  resolve(requestId: string, result: R): boolean {
    const w = this.waiting.get(requestId);
    if (!w) return false;
    this.waiting.delete(requestId);
    w.cleanup();
    w.resolve(result);
    this.onResolved(requestId, result);
    return true;
  }

  /** Cancel every prompt still open for this turn (it finished, failed or was interrupted). */
  cancelTurn(turnId: string): void {
    for (const [id, w] of [...this.waiting]) if (w.msg.turnId === turnId) this.resolve(id, this.cancelValue);
  }

  pending(): M[] {
    return [...this.waiting.values()].map((w) => w.msg);
  }
}

export class PermissionBroker extends AskBroker<PermissionMsg, PermissionDecision> {
  constructor(broadcast: (m: ServerMessage) => void, opts: { timeoutMs?: number } = {}) {
    super(broadcast, (requestId, decision) => broadcast({ type: 'permission_resolved', requestId, decision }), 'deny', opts.timeoutMs ?? PERMISSION_TIMEOUT_MS);
  }
}

/** D8: AskUserQuestion cards; null = unanswered (timeout, abort, turn end) → the engine denies the tool call. */
export class QuestionBroker extends AskBroker<QuestionMsg, QuestionAnswers | null> {
  constructor(broadcast: (m: ServerMessage) => void, opts: { timeoutMs?: number } = {}) {
    super(broadcast, (requestId, answers) => broadcast({ type: 'question_resolved', requestId, answers }), null, opts.timeoutMs ?? PERMISSION_TIMEOUT_MS);
  }

  /** Answers are user text: only keys naming an asked question survive (lengths are capped by the schema); none left → unanswered. */
  override resolve(requestId: string, answers: QuestionAnswers | null): boolean {
    const w = this.waiting.get(requestId);
    if (!w || !answers) return super.resolve(requestId, answers);
    const asked = new Set(w.msg.questions.map((q) => q.question));
    const kept = Object.fromEntries(Object.entries(answers).filter(([k]) => asked.has(k)));
    return super.resolve(requestId, Object.keys(kept).length ? kept : null);
  }
}

/** Deviation (added per review I5): extraHosts feeds the Host allowlist in checkUpgrade. */
export type WsDeps = {
  token: string;
  devOrigins: string[];
  runner: TurnRunner;
  index: SessionIndex;
  usage: UsageService;
  store: SessionStateStore;
  extraHosts?: string[];
  /** UI build id (see buildId.ts); rides hello so open tabs notice a new build. A function is read per hello (live). */
  build?: string | null | (() => string | null);
  /** D11: false hides the GPT engine in the UI and makes 'auto' mean Claude. */
  codexAvailable: boolean;
  /** The configured Claude accounts: rides hello (`accounts`), and an account pin must be one of its active ids. */
  accounts: AccountNames;
  /** Read on every hello, so a login done while deck runs shows up on the next connect. Absent = no Gemini. */
  geminiStatus?: () => GeminiStatus;
  readCodexHistory?: typeof readCodexTranscript;
  /** History of an imported (Codex Desktop / CLI) thread: the rollout's tail only. */
  readCodexImportHistory?: typeof readCodexTranscriptTail;
  /** F1: a new session's cwd must (after realpath) lie inside one of these (default: the OS home dir). */
  cwdRoots?: string[];
  /** F2: pinned session ids ride hello and every index message. */
  pins?: PinStore;
  /** 자동 승인 etc.; rides hello, changed with set_settings. */
  settings?: SettingsStore;
  /** Web Push hook: sees every turn event and every permission/question card (PushNotifier picks what to send). */
  notify?: (msg: ServerMessage) => void;
  /** Attachment metadata (name, image or not) for the prompt every viewing device is shown. */
  attachments?: { resolve(ids: string[]): { found: { id: string; name: string; isImage: boolean }[] } };
  /** 새 세션으로 이어가기: a new session sent with `handoffFrom` is linked to that session (and titled) here once it has an id. */
  meta?: Pick<SessionMetaStore, 'link' | 'branch'>;
  /** The send clientRefs / steer ids each session accepted (survives a restart); rides `history` as `acceptedRefs`. */
  acceptedRefs?: Pick<AcceptedRefs, 'add' | 'remove' | 'has' | 'list' | 'since'>;
  /** Process scan behind the index entries' `heldBy` (the same object the SessionIndex reads): rescanned at hello, open, send and on the outside poll. */
  holders?: Pick<ProcessHolders, 'refresh'>;
  /** See OUTSIDE_POLL_MS; 0 = no poll. */
  outsidePollMs?: number;
  /** See CATCHUP_KEEP_EVENTS (tests shrink it). */
  catchupKeep?: number;
  /** …and at most this many bytes (default CATCHUP_KEEP_BYTES), idle for at most this long (default CATCHUP_IDLE_MS). */
  catchupKeepBytes?: number;
  catchupIdleMs?: number;
};

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function isDirectory(p: string): Promise<boolean> {
  return fs.stat(p).then((st) => st.isDirectory(), () => false);
}

/**
 * `turnId` is the turn the send started (its AbortController ends the whole process). `current` is
 * the deck turn now streaming — that turn, a background continuation or a follow-up — and null
 * while the process only waits for background work; `bg` is the last turn_background.
 */
type TurnMsg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
/**
 * What a device opening the session mid-turn needs besides the transcript: the latest state of each
 * task (subagent cards), the subagents' tool calls so far (bounded), and the status row's progress.
 */
type ReplayLog = { tasks: Map<string, { msg: TurnMsg<'task_update'>; at: number }>; subs: (TurnMsg<'sub_tool_call'> | TurnMsg<'sub_tool_result'>)[]; progress: TurnMsg<'turn_progress'> | null; /** Steers delivered in the running segment (the transcript may lag behind them). */ steers: TurnMsg<'steer_delivered'>[] };
const MAX_REPLAY_SUBS = 500;
/**
 * Catch-up: how much of a running process's event stream is kept for devices that come back (`open_session.after`).
 * Older events fall out; a device that needs them gets the full history instead.
 */
export const CATCHUP_KEEP_EVENTS = 5000;
export const CATCHUP_KEEP_BYTES = 4 * 1024 * 1024;
/** A process that ended its turn and has sent nothing for this long (it is only kept open by background work) gives its kept events up: a device behind then gets the full history. */
export const CATCHUP_IDLE_MS = 10 * 60_000;

type Turn = RunningTurn & { origin: WebSocket; watchers: Set<WebSocket>; ac: AbortController; current: string | null; /** When `current` started (ms). */ since: number; bg: { msg: TurnMsg<'turn_background'>; at: number } | null; log: ReplayLog; /** Started without a session id: the sidebar is refreshed once the CLI reports one. */ fresh: boolean; /** 새 세션으로 이어가기: the session this new one continues. */ handoffFrom: string | null; /** 메시지 편집 갈래: recorded in session meta once the new session has an id. */ branch: { parent: string; n: number } | null; afterRelease: { ws: WebSocket; msg: Extract<ClientMessage, { type: 'send' }> }[]; /** Refs of sends / steers handed to the process but not yet recorded as accepted (`history.pendingRefs`). */ pendingRefs: Set<string>; /** The foreign-write check a send to the held-open process waits on (shared by sends arriving together). */ outside: Promise<boolean> | null; /** Being ended because the conversation went on outside deck: sends wait in `afterRelease` for a new process. */ recycling: boolean; /** The last stream position this process stamped (0: none yet). */ seq: number; /** Its newest stamped events as sent, oldest first (see CATCHUP_KEEP_*). */ stream: { seq: number; data: string; bytes: number }[]; streamBytes: number; /** Drops `stream` once the process has sat idle (CATCHUP_IDLE_MS). */ streamIdle: ReturnType<typeof setTimeout> | null };

export const DRAINING_MESSAGE = '서버가 재시작을 준비 중입니다 — 잠시 뒤 다시 보내 주세요';

export type WsHandle = {
  broadcast(msg: ServerMessage): void;
  broadcastIndex(): void;
  close(): void;
  /** Graceful restart: refuse new sends from now on (running turns and their background work go on). */
  drain(): void;
  /** Turns still running, including processes held open for background work. */
  activeTurns(): number;
  /** Ends every running turn (drain deadline). */
  abortAll(): void;
};

export function attachWebSocket(servers: http.Server[], deps: WsDeps): WsHandle {
  const cwdRoots = deps.cwdRoots ?? [os.homedir()];
  // maxPayload: a text frame over 1 MiB is refused (ws emits 'error' on the socket, handled below).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  wss.on('error', (err) => console.error('deck ws: server error', err));
  const clients = new Set<WebSocket>();
  const turns = new Map<string, Turn>();
  /** Turn ids a running turn's process produced after its own (background continuations, follow-ups) → that turn's id. */
  const aliases = new Map<string, string>();
  const baseOf = (turnId: string) => aliases.get(turnId) ?? turnId;
  /** The user message of each deck turn started by a send (its own turn or a follow-up), until the turn's process ends. */
  const prompts = new Map<string, TurnPrompt>();
  const promptOf = (msg: { text: string; attachments?: string[] }): TurnPrompt => ({
    text: msg.text,
    attachments: msg.attachments?.length ? (deps.attachments?.resolve([...new Set(msg.attachments)]).found ?? []).map(({ id, name, isImage }) => ({ id, name, isImage })) : [],
  });
  let draining = false;
  /**
   * A process held open between turns (background tasks, DECK_BG_MAX_MIN) is not work in progress: when the server is
   * draining it is ended now — the same way a recycle ends one — or it would sit out the whole drain window and then
   * take the real turns down with it at the deadline.
   */
  const endHeld = (t: Turn) => { if (draining && t.current === null && !t.recycling) { t.recycling = true; t.ac.abort(); } };
  /**
   * Review I2: one turn per session. Keyed by sessionId; a new session is keyed by
   * `new:<turnId>` until the CLI reports its id, then by that id as well.
   */
  const busy = new Map<string, string>();
  /** D6: the sessions each socket has open (one per pane); a session's turn events go to every socket viewing it. */
  const viewing = new Map<WebSocket, Set<string>>();
  const view = (ws: WebSocket, sessionId: string) => { let s = viewing.get(ws); if (!s) { s = new Set(); viewing.set(ws, s); } s.add(sessionId); };
  /** Sidebar listing: profile scan + deck-created Codex sessions (D4). */
  const projects = () => deps.index.projects(deps.store.codexEntries());
  const pinList = () => deps.pins?.list() ?? [];
  const indexMsg = (): ServerMessage => ({ type: 'index', projects: projects(), pins: pinList(), desktop: deps.index.desktop() });

  const send = (ws: WebSocket, msg: ServerMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  const broadcast = (msg: ServerMessage) => { for (const c of clients) send(c, msg); };
  const notify = (msg: ServerMessage) => { try { deps.notify?.(msg); } catch (err) { console.error('deck: push hook failed', errMsg(err)); } };
  const broadcastAndNotify = (msg: ServerMessage) => { broadcast(msg); notify(msg); };
  const broker = new PermissionBroker(broadcastAndNotify);
  const questions = new QuestionBroker(broadcastAndNotify);
  const unsubscribeUsage = deps.usage.onChange((usage) => broadcast({ type: 'usage', usage }));
  /** Every session with a turn streaming or background work held open (sidebar dots, tab title on all devices). */
  const activity = (): SessionActivity[] => {
    const now = Date.now();
    return [...turns.values()]
      .filter((t): t is Turn & { sessionId: string } => t.sessionId !== null && (t.current !== null || (t.bg?.msg.tasks.length ?? 0) > 0))
      .map((t) => ({ sessionId: t.sessionId, cwd: t.cwd, turnId: t.current ?? t.turnId, running: t.current !== null, bg: t.bg?.msg.tasks.length ?? 0, forMs: t.current !== null ? Math.max(0, now - t.since) : 0 }));
  };
  let activitySig = '[]';
  const broadcastActivity = () => {
    const sessions = activity();
    const sig = JSON.stringify(sessions.map(({ forMs: _f, ...rest }) => rest));
    if (sig === activitySig) return;
    activitySig = sig;
    broadcast({ type: 'activity', sessions });
  };
  const running = (): RunningTurn[] => [...turns.values()].filter((t) => t.current !== null).map(({ current, sessionId, cwd }) => ({ turnId: current!, sessionId, cwd }));

  /**
   * A session created moments ago (e.g. in Claude Desktop) may not be in the in-memory
   * index yet. Single-flight: concurrent misses await the same rescan instead of each
   * triggering their own.
   */
  let indexRescan: Promise<void> | null = null;
  /** A request made while a scan runs gets one (shared) scan started after it, so it sees files written before the request. */
  let queuedRescan: Promise<void> | null = null;
  const rescanIndex = (): Promise<void> => {
    if (!indexRescan) { indexRescan = deps.index.refresh().finally(() => { indexRescan = null; }); return indexRescan; }
    queuedRescan ??= indexRescan.catch(() => {}).then(() => { queuedRescan = null; return rescanIndex(); });
    return queuedRescan;
  };

  /** Rescans who else holds sessions open (cached a few seconds); the index goes out again only when a holder came or went. */
  const syncHolders = () => {
    void deps.holders?.refresh().then((changed) => { if (changed) { deps.index.regroup(); broadcast(indexMsg()); } }).catch(() => undefined);
  };
  /**
   * Per socket and Claude session it views: when its history was last sent (entries another process wrote after that are
   * not on its screen yet) and, per transcript copy, the offset the outside poll found clean up to — a tick reads only
   * what was appended since the last one. Per socket: one device opening a session must not hide from another what
   * came in between.
   */
  const historyAt = new Map<WebSocket, Map<string, { at: number; clean: Map<string, number> }>>();
  /**
   * The open panes follow the other side: a viewed, idle Claude session whose transcript (any profile's copy) gained
   * entries deck did not write since a socket's history was sent gets that history again — read once per session, sent
   * to each socket that lacks it. Sessions with a deck turn are left alone: their pane is fed by the turn's own stream.
   */
  const followOutside = async () => {
    const files = new Map<string, string[]>();
    const stale = new Map<string, WebSocket[]>();
    for (const [ws, seen] of historyAt) {
      for (const [id, rec] of [...seen]) {
        if (!viewing.get(ws)?.has(id)) { seen.delete(id); continue; }
        if (busy.has(id)) continue;
        if (!files.has(id)) files.set(id, deps.index.sessions().filter((e) => e.sessionId === id).map((e) => e.file));
        for (const file of files.get(id)!) {
          const r = await scanForeign(file, rec.at - OUTSIDE_SLACK_MS, rec.clean.get(file) ?? 0).catch(() => null);
          if (!r) continue;
          if (r.foreign) { stale.set(id, [...(stale.get(id) ?? []), ws]); break; }
          rec.clean.set(file, r.end);
        }
      }
    }
    for (const [id, sockets] of stale) {
      const st = deps.store.get(id);
      const entry = deps.index.lookup(id);
      if (!entry || busy.has(id) || (st && (isCodexState(st) || isGeminiState(st)))) continue;
      // What is in the files now is in the history read next: the poll goes on from these sizes, so this write is not found again.
      const clean = new Map<string, number>();
      for (const file of files.get(id) ?? []) { const s = await fs.stat(file).catch(() => null); if (s) clean.set(file, s.size); }
      const read = await readClaudeHistory(id, entry, st ?? null).catch(() => null);
      // A turn that started during the read streams into the pane already: a history now would wipe what it showed.
      if (!read || busy.has(id)) continue;
      // No view() here: a pane closed during the read stays closed.
      for (const ws of sockets) if (viewing.get(ws)?.has(id)) sendClaudeHistory(ws, id, read, clean);
    }
  };
  let following = false;
  const pollMs = deps.outsidePollMs ?? OUTSIDE_POLL_MS;
  const outsideTimer = pollMs > 0 ? setInterval(() => {
    if (!clients.size || following) return;
    syncHolders();
    // Sessions written outside deck (Desktop, a terminal) move in the list too: a stat of the known transcripts (~1 ms).
    // Sessions with a deck turn running are left out — their files grow with the turn; its end touches them and broadcasts.
    void deps.index.touch(undefined, new Set(busy.keys())).then((changed) => { if (changed) broadcast(indexMsg()); }).catch(() => undefined);
    following = true;
    void followOutside().catch((err: unknown) => console.error('deck: outside-write check failed', errMsg(err))).finally(() => { following = false; });
  }, pollMs) : null;
  outsideTimer?.unref?.();

  /**
   * A new session got its id: other devices list it in their sidebar now, not when the turn ends. The CLI may
   * write its transcript a moment after reporting the id, so rescan a few times until the index has it.
   */
  const announceSession = (sid: string, tries = 4) => {
    void rescanIndex()
      .then(() => {
        if (deps.index.lookup(sid) || deps.store.codexEntries().some((e) => e.sessionId === sid)) broadcast(indexMsg());
        else if (tries > 1) setTimeout(() => announceSession(sid, tries - 1), 750).unref?.();
      })
      .catch((err: unknown) => console.error('deck: index refresh for a new session failed', errMsg(err)));
  };

  /** 새 세션으로 이어가기: `to` continues `from` (deck's session meta, never the transcript), titled "<old title> (이어서)". */
  const linkHandoff = async (from: string, to: string) => {
    if (!deps.meta) return;
    const old = deps.index.lookup(from)?.title ?? deps.index.codexOwned(deps.store.codexEntries()).find((e) => e.sessionId === from)?.title ?? from.slice(0, 8);
    try {
      await deps.meta.link(from, to, handoffTitle(old));
      deps.index.regroup();
      broadcast(indexMsg());
    } catch (err) {
      console.error('deck: handoff link failed', errMsg(err));
    }
  };

  /** 메시지 편집 갈래: `child` was forked from `parent` at user message `n` (deck's session meta, never the transcript). */
  const linkBranch = async (child: string, parent: string, n: number) => {
    if (!deps.meta) return;
    try {
      await deps.meta.branch(child, parent, n);
      deps.index.regroup();
      broadcast(indexMsg());
    } catch (err) {
      console.error('deck: branch link failed', errMsg(err));
    }
  };

  /**
   * 메시지 편집 갈래: where to fork Claude session `from` so that its user message `n` (checked against `expect`)
   * is replaced — read from the copy the session's history is shown from. Null = not a Claude session / not found.
   */
  const resolveBranch = async (from: string, n: number, expect: string | undefined): Promise<BranchPoint | null> => {
    const st = deps.store.get(from);
    if (st && (isCodexState(st) || isGeminiState(st))) return null;
    const entry = deps.index.lookup(from);
    if (!st && (!entry || entry.account === 'gpt' || isGeminiAccount(entry.account))) return null;
    const best = st ? await deps.index.bestCopy(from, st.projectDir, st.account).catch(() => null) : null;
    const files = [best?.file ?? (st ? `${st.projectDir}/${from}.jsonl` : entry!.file), ...(entry ? [entry.file] : [])];
    for (const f of new Set(files)) {
      const bp = await readBranchPoint(f, n, expect).catch(() => null);
      if (bp) return bp;
    }
    return null;
  };

  /** Each session's newest stream position since this server started (a later process of the session counts on from it). */
  const heads = new Map<string, StreamPos>();
  const keepEvents = deps.catchupKeep ?? CATCHUP_KEEP_EVENTS;
  const keepBytes = deps.catchupKeepBytes ?? CATCHUP_KEEP_BYTES;
  const idleMs = deps.catchupIdleMs ?? CATCHUP_IDLE_MS;
  /** (Re)starts the idle clock of a process's kept events; a turn still running when it runs out keeps them. */
  const idleSoon = (turn: Turn) => {
    if (turn.streamIdle) clearTimeout(turn.streamIdle);
    turn.streamIdle = setTimeout(() => {
      turn.streamIdle = null;
      if (turn.current !== null && turns.has(turn.turnId)) { idleSoon(turn); return; }
      turn.stream = [];
      turn.streamBytes = 0;
    }, idleMs);
    turn.streamIdle.unref?.();
  };

  /**
   * Turn events reach the socket that started the turn and sockets viewing its session — nobody else. Once the session
   * has an id every event is numbered (`pos`) and kept for a while, so a device that was away can ask for what it missed.
   */
  const emitTurn = (turn: Turn, msg: ServerMessage) => {
    const sid = 'sessionId' in msg ? msg.sessionId : null;
    if (sid && turn.sessionId !== sid) {
      turn.sessionId = sid;
      if (!busy.has(sid)) busy.set(sid, turn.turnId);
      if (turn.fresh) {
        turn.fresh = false;
        if (turn.handoffFrom) void linkHandoff(turn.handoffFrom, sid).finally(() => announceSession(sid));
        else if (turn.branch) { const b = turn.branch; void linkBranch(sid, b.parent, b.n).finally(() => announceSession(sid)); }
        else announceSession(sid);
      }
      broadcastActivity();
    }
    const to = new Set<WebSocket>([turn.origin, ...turn.watchers]);
    if (turn.sessionId) for (const [c, v] of viewing) if (v.has(turn.sessionId)) to.add(c);
    let out = msg;
    let seq = 0;
    if (turn.sessionId) {
      seq = Math.max(turn.seq, heads.get(turn.sessionId)?.seq ?? 0) + 1;
      const pos: StreamPos = { sid: turn.sessionId, epoch: turn.turnId, seq };
      turn.seq = seq;
      heads.set(turn.sessionId, pos);
      // Only turn events and a turn's errors come through here: both carry `pos`.
      out = { ...msg, pos } as ServerMessage;
    }
    const data = JSON.stringify(out);
    if (seq) {
      // The newest event is always kept, whatever its size: what is kept is a whole tail or nothing.
      turn.stream.push({ seq, data, bytes: Buffer.byteLength(data) });
      turn.streamBytes += turn.stream[turn.stream.length - 1]!.bytes;
      while (turn.stream.length > keepEvents || (turn.streamBytes > keepBytes && turn.stream.length > 1)) turn.streamBytes -= turn.stream.shift()!.bytes;
      idleSoon(turn);
    }
    for (const c of to) if (c.readyState === WebSocket.OPEN) c.send(data);
    notify(msg);
  };

  for (const server of servers) {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      const chk = checkUpgrade({ headers: { cookie: req.headers.cookie, origin: req.headers.origin, host: req.headers.host } }, deps.token, deps.devOrigins, deps.extraHosts ?? []);
      if (!chk.ok) {
        const status = chk.reason === 'unauthenticated' ? '401 Unauthorized' : chk.reason.startsWith('host ') ? '421 Misdirected Request' : '403 Forbidden';
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  }

  /** Keeps what `replay` re-sends to a device that opens the session mid-turn. */
  const record = (turn: Turn, m: ServerMessage) => {
    const log = turn.log;
    if (m.type === 'task_update') {
      const prev = log.tasks.get(m.taskId);
      // A patch (task_updated) carries no Agent call id; keep the one task_started gave.
      log.tasks.set(m.taskId, { msg: prev ? { ...prev.msg, ...m, toolUseId: m.toolUseId ?? prev.msg.toolUseId } : m, at: prev?.at ?? Date.now() });
    } else if (m.type === 'task_done' && m.taskId) {
      const prev = log.tasks.get(m.taskId);
      if (prev) prev.msg = { ...prev.msg, status: m.status, ...(m.usage ? { usage: m.usage } : {}) };
    } else if (m.type === 'sub_tool_call' || m.type === 'sub_tool_result') {
      log.subs.push(m);
      if (log.subs.length > MAX_REPLAY_SUBS) log.subs.splice(0, log.subs.length - MAX_REPLAY_SUBS);
    } else if (m.type === 'turn_progress') {
      log.progress = m;
    } else if (m.type === 'steer_delivered') {
      // The steer is in the process's input now: accepted (not when runner.steer resolved — the process may end first).
      const sid = m.sessionId ?? turn.sessionId;
      if (sid) deps.acceptedRefs?.add(sid, m.steerId);
      turn.pendingRefs.delete(m.steerId);
      log.steers.push(m);
      if (log.steers.length > MAX_REPLAY_SUBS) log.steers.shift();
    } else if (m.type === 'steer_rejected') {
      turn.pendingRefs.delete(m.steerId);
    } else if (m.type === 'turn_result') {
      // The segment's transcript is complete now.
      log.steers = [];
    }
  };
  /** After `history`: the running turn's tasks, subagent calls, progress and background work, as of now. */
  const replay = (ws: WebSocket, t: Turn, sessionId: string) => {
    const now = Date.now();
    for (const { msg, at } of t.log.tasks.values()) send(ws, { ...msg, sessionId, ageMs: Math.max(0, now - at) });
    for (const m of t.log.subs) send(ws, { ...m, sessionId });
    for (const m of t.log.steers) send(ws, { ...m, sessionId, replay: true });
    if (t.current && t.log.progress) send(ws, { ...t.log.progress, sessionId });
    if (t.bg) {
      const elapsed = now - t.bg.at;
      const { msg } = t.bg;
      send(ws, { ...msg, sessionId, cwd: t.cwd, ...(msg.detail ? { detail: msg.detail.map((d) => ({ ...d, ageMs: d.ageMs + elapsed })) } : {}) });
    }
  };

  /**
   * The session took this ref already (recorded: the device drops its copy) or is taking it (handed to its running process,
   * which may still fail to deliver it: the device keeps its copy, paused). Undefined: neither.
   */
  const refusal = (sessionId: string, ref: string): { message: string; code: RefusalCode } | undefined =>
    deps.acceptedRefs?.has(sessionId, ref) ? { message: '이미 들어간 메시지라 다시 보내지 않았습니다', code: 'already_accepted' }
      : turns.get(busy.get(sessionId) ?? '')?.pendingRefs.has(ref) ? { message: '아직 처리 중인 메시지 — 멈춰 둠', code: 'in_flight' }
        : undefined;

  /** `checked`: this send already waited for the foreign-write check of its session's held-open process. */
  const accounts = deps.accounts;
  /** Why this account cannot be pinned (the schema only checks an id's shape), or null. */
  const pinRefusal = (id: string): string | null => {
    const usable = accounts.list().map((a) => `${accounts.label(a)}(${a})`).join(', ');
    return !accounts.has(id) ? `설정에 없는 계정이라 고정할 수 없습니다: ${id} (쓸 수 있는 계정: ${usable})`
      : accounts.isRetired(id) ? `설정에서 뺀(retired) 계정이라 고정할 수 없습니다: ${accounts.label(id)}(${id}) (쓸 수 있는 계정: ${usable})`
        : null;
  };

  const startTurn = (ws: WebSocket, sent: Extract<ClientMessage, { type: 'send' }>, checked = false) => {
    // The handoff note's prompt is fixed server-side (the turn runs with tools denied, so it must not carry arbitrary text).
    const msg = sent.handoff ? { ...sent, text: HANDOFF_PROMPT, attachments: undefined } : sent;
    // A socket that closed while its send waited (foreign-write check, recycle) still gets its message run; it just views nothing.
    if (msg.sessionId && clients.has(ws)) view(ws, msg.sessionId);
    if (!checked) syncHolders();
    // The client's correlation id rides this send's turn_started and every error refusing the send (which pane sent it).
    const ref = msg.clientRef ? { clientRef: msg.clientRef } : {};
    // Only a pin the user picked for a new session is refused. An edit branch or a handoff carries its parent's stored pin,
    // which the runner treats as no pin when the account is not active any more. A handoff is one only when `handoffFrom`
    // (a session id) names a session deck knows — any other string does not lift the check.
    const hf = msg.handoffFrom;
    const fromKnown = isPinnableId(hf) && (!!deps.store.get(hf) || !!deps.index.lookup(hf));
    const badPin = msg.sessionId === null && msg.accountPin && !msg.branch && !fromKnown ? pinRefusal(msg.accountPin) : null;
    if (badPin) { send(ws, { type: 'error', turnId: null, message: badPin, ...ref }); return; }
    if (draining) { send(ws, { type: 'error', turnId: null, message: DRAINING_MESSAGE, code: 'draining', ...ref }); return; }
    // Idempotency: a send this session already took (or is taking) under this ref — a resent queue copy, a duplicated tab — runs once.
    const dup = msg.sessionId && msg.clientRef ? refusal(msg.sessionId, msg.clientRef) : undefined;
    if (dup) { send(ws, { type: 'error', turnId: null, ...dup, ...ref }); return; }
    if (msg.handoff && msg.sessionId) {
      const st = deps.store.get(msg.sessionId);
      if (msg.engine === 'codex' || msg.engine === 'gemini' || (st && (isCodexState(st) || isGeminiState(st))) || (!st && !deps.index.lookup(msg.sessionId) && deps.index.codexImport(msg.sessionId))) {
        send(ws, { type: 'error', turnId: null, message: '이어서 새 세션은 Claude 대화에서만 돼요', ...ref });
        return;
      }
    }
    if (msg.handoff && (!msg.sessionId || busy.has(msg.sessionId))) {
      send(ws, { type: 'error', turnId: null, message: msg.sessionId ? '세션이 실행 중이라 지금은 넘길 수 없습니다 — 끝난 뒤 다시 시도하세요' : '새 세션은 넘길 대화가 없습니다', ...ref });
      return;
    }
    if (msg.sessionId && busy.has(msg.sessionId)) {
      // The session's process may only be waiting for background work: then the message joins it (TurnRunner.followUp).
      const base = turns.get(busy.get(msg.sessionId)!);
      const sid = msg.sessionId;
      if (base?.recycling) { base.afterRelease.push({ ws, msg }); return; }
      // deck follows the other side: a process held open for background work read the transcript when it started. If
      // Desktop / a CLI went on with the session since, a message written into it would be answered from before that —
      // the conversation forks. So that process is ended and the send starts a new one, which resumes from the newest
      // entry. Only between turns (`current` null): a streaming turn is never cut, the send then queues behind it as before.
      if (base && !checked && base.current === null) {
        const check = (base.outside ??= deps.runner.foreignWrites(sid).catch(() => false));
        void check.then((foreign) => {
          if (base.outside === check) base.outside = null;
          // No socket check: the message was sent, and neither a follow-up nor a new turn needs its sender connected.
          if (foreign && !base.recycling && base.current === null && turns.get(busy.get(sid) ?? '') === base) {
            base.recycling = true;
            const stopped = base.bg?.msg.tasks.length ?? 0;
            if (stopped > 0) {
              const notice: ServerMessage = { type: 'turn_notice', turnId: '', sessionId: sid, cwd: base.cwd, message: recycleNotice(stopped) };
              for (const [c, v] of viewing) if (v.has(sid)) send(c, notice);
            }
            base.ac.abort();
          }
          startTurn(ws, sent, true);
        });
        return;
      }
      const followId = randomUUID();
      if (base) aliases.set(followId, base.turnId);
      prompts.set(followId, promptOf(msg));
      const joined = base !== undefined && deps.runner.followUp(msg.sessionId, {
        turnId: followId, text: msg.text,
        ...(msg.attachments ? { attachments: msg.attachments } : {}),
        ...(msg.model ? { model: msg.model } : {}),
        ...(msg.clientRef ? { clientRef: msg.clientRef } : {}),
      });
      // Accepted once its turn_started comes (the sink's alias branch): that is when the process takes it in.
      if (joined) { if (msg.clientRef) base.pendingRefs.add(msg.clientRef); return; }
      aliases.delete(followId);
      prompts.delete(followId);
      // The turn already sent its result and the process is only closing (no background work to join):
      // the UI's queue fires on that result, so run the send as soon as the lock is released instead of refusing it.
      if (base && base.current === null) { base.afterRelease.push({ ws, msg }); return; }
      send(ws, { type: 'error', turnId: null, message: '이 세션은 이미 실행 중입니다', ...ref });
      return;
    }
    const turnId = randomUUID();
    const ac = new AbortController();
    const turn: Turn = { turnId, sessionId: msg.sessionId, cwd: msg.cwd, origin: ws, watchers: new Set(), ac, current: turnId, since: Date.now(), bg: null, log: { tasks: new Map(), subs: [], progress: null, steers: [] }, fresh: msg.sessionId === null, handoffFrom: msg.sessionId === null && isPinnableId(msg.handoffFrom) ? msg.handoffFrom : null, branch: null, afterRelease: [], pendingRefs: new Set(msg.clientRef ? [msg.clientRef] : []), outside: null, recycling: false, seq: 0, stream: [], streamBytes: 0, streamIdle: null };
    prompts.set(turnId, promptOf(msg));
    // Taken synchronously, before any await, so two sends in one tick cannot both pass.
    busy.set(msg.sessionId ?? `new:${turnId}`, turnId);
    turns.set(turnId, turn);
    const release = () => {
      turns.delete(turnId);
      if (turn.streamIdle) clearTimeout(turn.streamIdle);
      prompts.delete(turnId);
      for (const [k, v] of [...busy]) if (v === turnId) busy.delete(k);
      broker.cancelTurn(turnId);
      questions.cancelTurn(turnId);
      for (const [a, b] of [...aliases]) if (b === turnId) { aliases.delete(a); prompts.delete(a); broker.cancelTurn(a); questions.cancelTurn(a); }
      broadcastActivity();
      // Sends that arrived while the process was closing after its result (a closed socket's send is dropped — but not one
      // that waited because deck itself ended the process). Each goes where a send would go now: the first starts the
      // session's next turn; the others wait on that turn until its process can take a follow-up or is gone.
      for (const d of turn.afterRelease.splice(0)) {
        if (!turn.recycling && !clients.has(d.ws)) continue;
        const next = d.msg.sessionId ? turns.get(busy.get(d.msg.sessionId) ?? '') : undefined;
        if (next) next.afterRelease.push(d);
        else startTurn(d.ws, d.msg);
      }
    };
    /** Sends carried over from the turn before (see release): given to the process once it is between turns — after the runner registered it as held open, hence the microtask. */
    const drainWaiting = () => queueMicrotask(() => {
      if (turns.get(turnId) !== turn || turn.current !== null || turn.recycling) return;
      for (const d of turn.afterRelease.splice(0)) startTurn(d.ws, d.msg);
    });
    let started = false;
    /** This send's clientRef, until it is recorded as accepted under its session id (a new session's comes with its result). */
    let unrecorded = msg.clientRef ?? null;
    const accepted = (sessionId: string | null) => {
      if (!unrecorded || !sessionId) return;
      deps.acceptedRefs?.add(sessionId, unrecorded);
      turn.pendingRefs.delete(unrecorded);
      unrecorded = null;
    };
    const sink: TurnSink = {
      emit: (m) => {
        if (m.type === 'turn_started') {
          if (turn.current !== m.turnId) turn.since = Date.now();
          turn.current = m.turnId;
          turn.log.progress = null;
          // Every device viewing the session gets the prompt with each start (retries included); the sending pane skips it.
          const prompt = prompts.get(m.turnId);
          const withPrompt = prompt ? { ...m, prompt } : m;
          if (m.turnId !== turnId) {
            // A follow-up's start: the process took its message in now.
            const sid = m.sessionId ?? turn.sessionId;
            if (m.clientRef && sid) { deps.acceptedRefs?.add(sid, m.clientRef); turn.pendingRefs.delete(m.clientRef); }
            aliases.set(m.turnId, turnId); emitTurn(turn, withPrompt); broadcastActivity(); return;
          }
          started = true;
          accepted(m.sessionId ?? turn.sessionId);
          emitTurn(turn, { ...withPrompt, ...ref });
          broadcastActivity();
          return;
        }
        record(turn, m);
        // A send the process did not take after all (a follow-up's write failed, or it was still queued when the process
        // ended): no longer going in, and taken back if its turn_started recorded it.
        if (m.type === 'error' && m.clientRef) {
          turn.pendingRefs.delete(m.clientRef);
          const sid = m.sessionId ?? turn.sessionId;
          if (sid) deps.acceptedRefs?.remove(sid, m.clientRef);
          // A follow-up whose turn_started went out: its failed turn_result already shows the error in the chat, so this
          // one only takes the ref back (a second, app-wide banner with the same text would just repeat it).
          if (m.turnId !== null && aliases.has(m.turnId)) return;
        }
        // A new session's ref, once it has an id. Today's client never asks (a new session is not deduped: no history to
        // open); kept so a later client that does finds it.
        if (m.type === 'turn_result' && started) accepted(m.sessionId);
        if (m.type === 'turn_result' && m.turnId === turn.current) { turn.current = null; turn.log.progress = null; if (turn.afterRelease.length) drainWaiting(); queueMicrotask(() => { if (turns.get(turnId) === turn) endHeld(turn); }); }
        if (m.type === 'turn_background') turn.bg = m.tasks.length ? { msg: m, at: Date.now() } : null;
        if (m.type === 'turn_result' || m.type === 'turn_background') queueMicrotask(broadcastActivity);
        if (m.type === 'error' && !started && (m.turnId === null || m.turnId === turnId)) emitTurn(turn, { ...m, ...ref });
        else emitTurn(turn, m);
      },
      askPermission: (req) => {
        const sessionLabel = sessionAllowLabel(req);
        return broker.ask(
          {
            type: 'permission_request', turnId: req.turnId, sessionId: req.sessionId, cwd: req.cwd, requestId: randomUUID(), toolName: req.toolName, input: req.input,
            title: req.title ?? null, decisionReason: req.decisionReason ?? null, blockedPath: req.blockedPath ?? null,
            defaultToNo: req.defaultToNo === true, allowSession: sessionLabel !== null, sessionLabel,
          },
          req.signal ? AbortSignal.any([req.signal, ac.signal]) : ac.signal,
        );
      },
      askQuestion: (req) => questions.ask(
        { type: 'question_request', turnId: req.turnId, sessionId: req.sessionId, cwd: req.cwd, requestId: randomUUID(), questions: req.questions },
        req.signal ? AbortSignal.any([req.signal, ac.signal]) : ac.signal,
      ),
      signal: ac.signal,
    };
    void (async () => {
      try {
        // Review M8: the working directory must exist before a CLI is started in it (an existing session: same words as importBlockReason).
        if (!(await isDirectory(msg.cwd))) { send(ws, { type: 'error', turnId: null, message: msg.sessionId ? `${CWD_MISSING_NOTICE}: ${msg.cwd}` : `작업 폴더가 없습니다: ${msg.cwd}`, ...ref }); return; }
        // F1: a new session may only start inside the home dir (realpath, so a symlink cannot escape it).
        // The checked real path is the one used (review fix 3): a symlink swapped after the check cannot redirect the run.
        let runCwd = msg.cwd;
        if (msg.sessionId === null) {
          try {
            runCwd = await resolveUnderRoots(msg.cwd, cwdRoots[0] ?? os.homedir(), cwdRoots);
            turn.cwd = runCwd;
          } catch (err) {
            if (!(err instanceof DirError)) throw err;
            send(ws, { type: 'error', turnId: null, message: `${err.message}: ${msg.cwd}`, ...ref });
            return;
          }
        }
        // 메시지 편집 갈래: fork at the entry the edited message followed; editing the first message starts afresh.
        let fork: { from: string; at: string } | null = null;
        let model = msg.model;
        if (msg.branch && msg.sessionId === null) {
          const b = msg.branch;
          const bp = isPinnableId(b.from) ? await resolveBranch(b.from, b.n, b.expect) : null;
          if (!bp || (bp.n > 0 && !bp.at)) { send(ws, { type: 'error', turnId: null, message: '편집할 메시지를 기록에서 찾지 못해 새 갈래를 만들지 못했습니다 — 원래 세션으로 돌아갑니다', ...ref }); return; }
          turn.branch = { parent: b.from, n: bp.n };
          if (bp.at) fork = { from: b.from, at: bp.at };
          else if (!model || model === 'auto') {
            // The first message: a fresh session, on the original's model (a fork inherits it in the runner).
            const st = deps.store.get(b.from);
            if (st && !isCodexState(st) && !isGeminiState(st)) model = st.defaultModel;
          }
        }
        await deps.runner.run({
          turnId, cwd: runCwd, sessionId: msg.sessionId, text: msg.text,
          ...(fork ? { fork } : {}),
          ...(model ? { model } : {}),
          ...(msg.effort ? { effort: msg.effort } : {}),
          ...(msg.engine ? { engine: msg.engine } : {}),
          ...(msg.sandbox ? { sandbox: msg.sandbox } : {}),
          ...(msg.attachments ? { attachments: msg.attachments } : {}),
          ...(msg.sessionId === null && msg.accountPin ? { accountPin: msg.accountPin } : {}),
          ...(msg.sessionId === null && msg.permissionMode ? { permissionMode: msg.permissionMode } : {}),
          ...(msg.handoff ? { handoff: true } : {}),
        }, sink);
      } catch (err) {
        // Review I6: a rejected run still ends the turn for the UI.
        console.error('deck: turn failed', err);
        // Failed before its turn_started: the sending pane is still waiting and only its clientRef can release it.
        // A run cut by an interrupt (any device's) or the shutdown says so in deck's words, as a turn the runner ended itself does.
        const text = ac.signal.aborted ? abortedText(ac.signal) : displayError(errMsg(err), null);
        if (!started && msg.clientRef) send(ws, { type: 'error', turnId: null, message: text ?? '실행 실패', ...ref });
        emitTurn(turn, { type: 'turn_result', turnId, sessionId: turn.sessionId, cwd: turn.cwd, ok: false, text: '', badge: null, errorText: text });
      } finally {
        release();
      }
      if (msg.sessionId === null) {
        await deps.index.refresh();
        broadcast(indexMsg());
      } else {
        // An existing session: its row's time (and place in 최근) follows the turn — a stat of its transcript copies, not a
        // rescan. Codex / Gemini rows are dated by the state store, which the turn has just written.
        const st = deps.store.get(msg.sessionId);
        if ((await deps.index.touch([msg.sessionId])) || (st && (isCodexState(st) || isGeminiState(st)))) broadcast(indexMsg());
      }
    })().catch((err: unknown) => console.error('deck: post-turn index refresh failed', errMsg(err)));
  };

  /** `open_session`: the session's history (and, mid-turn, what its running turn has shown so far) to one socket, which views it from now on. */
  /** The deck turn streaming in this session now (null while idle or only waiting for background work) and its prompt. */
  const runningOf = (sid: string) => {
    const t = turns.get(busy.get(sid) ?? '');
    const current = t?.current ?? null;
    const since = deps.acceptedRefs?.since(sid);
    const pos = heads.get(sid);
    return { ...(pos ? { pos } : {}), runningTurnId: current, runningPrompt: current ? (prompts.get(current) ?? null) : null, ...(t && current ? { runningForMs: Math.max(0, Date.now() - t.since) } : {}), ...(deps.acceptedRefs ? { acceptedRefs: deps.acceptedRefs.list(sid), pendingRefs: t ? [...t.pendingRefs] : [], ...(since !== undefined ? { acceptedRefsSince: since } : {}) } : {}) };
  };
  type ClaudeHistory = { found: SessionEntry; st: ClaudeSessionState | null; at: number; messages: Awaited<ReturnType<typeof readTranscript>> };
  /** A Claude session's transcript as a pane shows it. A copy that contains deck's (e.g. Claude Desktop continued the session on A) is the one read. */
  const readClaudeHistory = async (sessionId: string, found: SessionEntry, st: ClaudeSessionState | null): Promise<ClaudeHistory> => {
    const best = st ? await deps.index.bestCopy(sessionId, st.projectDir, st.account).catch(() => null) : null;
    // Stamped before the read: an entry written while reading is looked at again by the outside poll.
    const at = Date.now();
    const messages = await readTranscript(best?.file ?? (st ? `${st.projectDir}/${sessionId}.jsonl` : found.file)).catch(() => readTranscript(found.file));
    return { found, st, at, messages };
  };
  const sendClaudeHistory = (ws: WebSocket, sessionId: string, { found, st, at, messages }: ClaudeHistory, clean?: Map<string, number>) => {
    const t = turns.get(busy.get(sessionId) ?? '');
    let seen = historyAt.get(ws);
    if (!seen) { seen = new Map(); historyAt.set(ws, seen); }
    seen.set(sessionId, { at, clean: new Map(clean) });
    send(ws, { type: 'history', sessionId, cwd: found.cwd, account: st?.account ?? found.account, engine: 'claude', sandbox: null, accountPin: st?.accountPin ?? null, permissionMode: deps.runner.permissionModeOf(sessionId), sessionModel: st?.defaultModel ?? IMPORTED_DEFAULT_MODEL, messages, ...runningOf(sessionId) });
    if (t) replay(ws, t, sessionId);
  };
  /**
   * `open_session.after`: true when the device was answered without reading anything again — `catchup`, then the events
   * after its position. That needs its position to be on the session's newest process, and either that process still
   * running with every later event kept, or nothing later at all on a socket that has viewed the session all along (a
   * new socket on an idle session may have missed what was written outside deck). Anything else: false, and the caller
   * sends the full history.
   */
  const catchUp = (ws: WebSocket, sessionId: string, after: { epoch: string; seq: number }): boolean => {
    // The header's acceptedRefs are what release a device's held messages (as a history's do).
    if (!deps.acceptedRefs || !clients.has(ws)) return false;
    const head = heads.get(sessionId);
    if (!head || head.epoch !== after.epoch || after.seq > head.seq) return false;
    const t = turns.get(busy.get(sessionId) ?? '');
    const live = t?.turnId === head.epoch ? t : undefined;
    let tail: { seq: number; data: string }[] = [];
    if (after.seq < head.seq) {
      if (!live) return false;
      tail = live.stream.filter((e) => e.seq > after.seq);
      if (tail.length !== head.seq - after.seq || tail[0]!.seq !== after.seq + 1 || tail[tail.length - 1]!.seq !== head.seq) return false;
    } else if (!live && !viewing.get(ws)?.has(sessionId)) return false;
    view(ws, sessionId);
    // The outside poll follows this socket's view of the session from here on, as after a history.
    let seen = historyAt.get(ws);
    if (!seen) { seen = new Map(); historyAt.set(ws, seen); }
    if (!seen.has(sessionId)) seen.set(sessionId, { at: Date.now(), clean: new Map() });
    const st = deps.store.get(sessionId);
    const claude = st && !isCodexState(st) && !isGeminiState(st) ? { accountPin: st.accountPin ?? null, permissionMode: deps.runner.permissionModeOf(sessionId), sessionModel: st.defaultModel } : {};
    send(ws, { type: 'catchup', sessionId, ...claude, ...runningOf(sessionId) });
    for (const e of tail) ws.send(e.data);
    return true;
  };
  const openSession = (ws: WebSocket, sessionId: string) => {
    void (async () => {
      // D4: Codex sessions live only in the state store; history comes from the CLI's rollout file.
      const st = deps.store.get(sessionId);
      if (st && isCodexState(st)) {
        view(ws, sessionId);
        const messages = st.rolloutFile ? await (deps.readCodexHistory ?? readCodexTranscript)(st.rolloutFile).catch(() => []) : [];
        send(ws, { type: 'history', sessionId, cwd: st.cwd, account: 'gpt', engine: 'codex', sandbox: st.sandbox, messages, ...runningOf(sessionId) });
        return;
      }
      // Gemini sessions: no transcript reader yet (the CLI's chat files are not read) — the pane starts empty.
      if (st && isGeminiState(st)) {
        view(ws, sessionId);
        send(ws, { type: 'history', sessionId, cwd: st.cwd, account: st.account, engine: 'gemini', sandbox: st.sandbox, messages: [], ...runningOf(sessionId) });
        return;
      }
      let entry = deps.index.lookup(sessionId);
      // Review (flaky ws.test.ts): a session written just after the last scan isn't in
      // the in-memory index yet. Rescan once (single-flight) and re-check before giving up.
      if (!entry && !deps.index.codexImport(sessionId)) {
        await rescanIndex();
        entry = deps.index.lookup(sessionId);
      }
      // A Codex Desktop / CLI thread deck has not run yet: its rollout, read-only; the first turn resumes it.
      // Checked live: a rollout moved by Codex (archived / unarchived) or a folder that came / went since the last scan
      // triggers a rescan and an index push, so the list and composer follow without a manual refresh.
      const imported = entry ? null : await deps.index.freshCodexImport(sessionId);
      if (imported) {
        view(ws, sessionId);
        const messages = await (deps.readCodexImportHistory ?? readCodexTranscriptTail)(imported.file).catch(() => []);
        send(ws, { type: 'history', sessionId, cwd: imported.cwd, account: 'gpt', engine: 'codex', sandbox: defaultSandbox(deps.settings?.get().autoApprove ?? false), messages, ...runningOf(sessionId) });
        const t = turns.get(busy.get(sessionId) ?? '');
        if (t) replay(ws, t, sessionId);
        const age = await rolloutActiveAgeMs(imported.file);
        if (age !== null) send(ws, { type: 'turn_notice', turnId: '', sessionId, cwd: imported.cwd, message: liveRolloutNotice(imported.title, age) });
        // View only (folder gone / archived in Codex): said up front, not only when a send is refused.
        const blocked = await importBlockReason(imported);
        if (blocked) send(ws, { type: 'turn_notice', turnId: '', sessionId, cwd: imported.cwd, message: blocked });
        return;
      }
      if (!entry) { send(ws, { type: 'error', turnId: null, sessionId, code: 'not_found', message: `세션을 찾을 수 없습니다: ${sessionId}` }); return; }
      view(ws, sessionId);
      // PF5: `st` is narrowed to a Claude state (or null) by the Codex return above.
      const found = entry;
      await readClaudeHistory(sessionId, found, st ?? null)
        .then((read) => {
          sendClaudeHistory(ws, sessionId, read);
          // deck's copy and Desktop's (home profile) went separate ways: say so on open, not only after a turn.
          void deps.runner.forkStatus(sessionId).then((f) => { if (f?.diverged) send(ws, { type: 'turn_notice', turnId: '', sessionId, cwd: found.cwd, message: FORK_NOTICE }); }, () => undefined);
        })
        .catch((err: unknown) => send(ws, { type: 'error', turnId: null, sessionId, message: `기록을 읽지 못했습니다: ${errMsg(err)}` }));
    })().catch((err: unknown) => send(ws, { type: 'error', turnId: null, sessionId, message: `세션을 열지 못했습니다: ${errMsg(err)}` }));
  };

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    // Without this listener a bad frame (invalid UTF-8, oversized) is an uncaught 'error' that kills the process.
    ws.on('error', (err) => { console.error('deck ws: client error', (err as Error & { code?: string }).code ?? err.message); ws.terminate(); });
    send(ws, { type: 'hello', usage: deps.usage.snapshot(), projects: projects(), pins: pinList(), desktop: deps.index.desktop(), ...(deps.settings ? { settings: deps.settings.get() } : {}), running: running(), activity: activity(), codex: { available: deps.codexAvailable }, features: [...FEATURES], accounts: accountInfos(accounts), ...(deps.geminiStatus ? { gemini: deps.geminiStatus() } : {}), ...(deps.build !== undefined ? { build: typeof deps.build === 'function' ? deps.build() : deps.build } : {}) });
    for (const m of broker.pending()) send(ws, m);
    for (const m of questions.pending()) send(ws, m);
    // hello carried the last scan's flags; a changed scan follows as an index message.
    syncHolders();

    ws.on('message', (data) => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(data)); } catch { send(ws, { type: 'error', turnId: null, message: '메시지를 해석할 수 없습니다(JSON 아님)' }); return; }
      const r = ClientMessageSchema.safeParse(parsed);
      if (!r.success) {
        // A malformed send still names its pane when the frame carries a usable clientRef.
        const raw = parsed !== null && typeof parsed === 'object' ? (parsed as { clientRef?: unknown }).clientRef : undefined;
        const ref = typeof raw === 'string' && raw.length > 0 && raw.length <= CLIENT_REF_MAX ? { clientRef: raw } : {};
        send(ws, { type: 'error', turnId: null, message: `메시지 형식 오류: ${r.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`, ...ref });
        return;
      }
      const msg = r.data;
      switch (msg.type) {
        case 'send':
          startTurn(ws, msg);
          break;
        case 'permission_response':
          if (!broker.resolve(msg.requestId, msg.decision)) send(ws, { type: 'error', turnId: null, message: '이미 처리된 권한 요청입니다' });
          break;
        case 'question_response':
          if (!questions.resolve(msg.requestId, msg.answers)) send(ws, { type: 'error', turnId: null, message: '이미 처리된 질문입니다' });
          break;
        case 'watch_turn':
          turns.get(msg.turnId)?.watchers.add(ws);
          break;
        case 'steer': {
          // Into the running Claude turn's process; refused (the device sends it after the turn) when there is none.
          const turn = turns.get(baseOf(msg.turnId));
          const reject = (message: string, code?: RefusalCode) => send(ws, { type: 'steer_rejected', turnId: msg.turnId, sessionId: turn?.sessionId ?? null, cwd: turn?.cwd ?? '', steerId: msg.steerId, message, ...(code ? { code } : {}) });
          if (draining) { reject(DRAINING_MESSAGE, 'draining'); break; }
          const dup = turn?.sessionId ? refusal(turn.sessionId, msg.steerId) : undefined;
          if (dup) { reject(dup.message, dup.code); break; }
          if (!turn || turn.current === null) { reject('실행 중인 턴이 없어 끝난 뒤 보냅니다'); break; }
          void deps.runner.steer(turn.turnId, { steerId: msg.steerId, text: msg.text, ...(msg.attachments ? { attachments: msg.attachments } : {}), prompt: promptOf(msg) })
            .then((ok) => {
              // Recorded as accepted at steer_delivered (record()); until then it is pending.
              if (ok === false) reject('지금은 실행 중인 턴에 넣을 수 없어 끝난 뒤 보냅니다');
              else if (ok === true && turns.has(turn.turnId)) turn.pendingRefs.add(msg.steerId);
            })
            .catch((err: unknown) => reject(`실행 중인 턴에 넣지 못했습니다: ${errMsg(err)}`));
          break;
        }
        case 'interrupt': {
          // A continuation's or follow-up's id stops the process it runs in (and its background work).
          const base = baseOf(msg.turnId);
          turns.get(base)?.ac.abort();
          for (const id of new Set([msg.turnId, base])) { broker.cancelTurn(id); questions.cancelTurn(id); }
          break;
        }
        case 'stop_task': {
          void deps.runner.stopTask(baseOf(msg.turnId), msg.taskId)
            .then((ok) => { if (!ok) send(ws, { type: 'error', turnId: null, message: '이 작업은 따로 멈출 수 없습니다 — 모두 중지를 써 주세요' }); })
            .catch((err: unknown) => send(ws, { type: 'error', turnId: null, message: `작업을 멈추지 못했습니다: ${errMsg(err)}` }));
          break;
        }
        case 'open_session':
          syncHolders();
          if (!(msg.after && catchUp(ws, msg.sessionId, msg.after))) openSession(ws, msg.sessionId);
          break;
        case 'close_session':
          viewing.get(ws)?.delete(msg.sessionId);
          break;
        case 'refresh_index':
          void rescanIndex()
            .then(() => broadcast(indexMsg()))
            .catch((err: unknown) => send(ws, { type: 'error', turnId: null, message: `세션 목록을 읽지 못했습니다: ${errMsg(err)}` }));
          break;
        case 'set_account_pin': {
          const badPin = msg.pin === null ? null : pinRefusal(msg.pin);
          if (badPin) {
            send(ws, { type: 'error', turnId: null, sessionId: msg.sessionId, message: badPin });
            // The sender showed the pin already: back to what is stored.
            const st = deps.store.get(msg.sessionId);
            send(ws, { type: 'account_pin', sessionId: msg.sessionId, pin: (st && !isCodexState(st) && !isGeminiState(st) ? st.accountPin : undefined) ?? null });
            break;
          }
          void deps.runner.setAccountPin(msg.sessionId, msg.pin)
            .then((ok) => {
              if (ok) broadcast({ type: 'account_pin', sessionId: msg.sessionId, pin: msg.pin });
              else send(ws, { type: 'error', turnId: null, sessionId: msg.sessionId, message: `계정을 고정할 수 없는 세션입니다: ${msg.sessionId}` });
            })
            .catch((err: unknown) => send(ws, { type: 'error', turnId: null, sessionId: msg.sessionId, message: `계정 고정을 저장하지 못했습니다: ${errMsg(err)}` }));
          break;
        }
        case 'set_permission_mode':
          void deps.runner.setPermissionMode(msg.sessionId, msg.mode)
            .then((ok) => {
              if (!ok) { send(ws, { type: 'error', turnId: null, sessionId: msg.sessionId, message: `권한 모드를 바꿀 수 없는 세션입니다: ${msg.sessionId}` }); return; }
              broadcast({ type: 'permission_mode', sessionId: msg.sessionId, mode: msg.mode });
              // 모두 자동 승인 also lets through this session's cards already waiting (a plan still needs its own choice).
              if (msg.mode === 'bypassPermissions') for (const m of broker.pending()) if (m.sessionId === msg.sessionId && m.toolName !== 'ExitPlanMode') broker.resolve(m.requestId, 'once');
            })
            .catch((err: unknown) => send(ws, { type: 'error', turnId: null, sessionId: msg.sessionId, message: `권한 모드를 저장하지 못했습니다: ${errMsg(err)}` }));
          break;
        case 'set_settings': {
          const store = deps.settings;
          if (!store) { send(ws, { type: 'error', turnId: null, message: '설정을 바꿀 수 없습니다' }); break; }
          // The default only applies to new sessions (and ones with no stored mode) from their next turn: waiting cards stay.
          void store.set({ ...(msg.autoApprove !== undefined ? { autoApprove: msg.autoApprove } : {}), ...(msg.defaultPermissionMode ? { defaultPermissionMode: msg.defaultPermissionMode } : {}), ...(msg.routingPolicy ? { routingPolicy: msg.routingPolicy } : {}) })
            .then((settings) => broadcast({ type: 'settings', settings }))
            .catch((err: unknown) => send(ws, { type: 'error', turnId: null, message: `설정을 저장하지 못했습니다: ${errMsg(err)}` }));
          break;
        }
      }
    });

    ws.on('close', () => { clients.delete(ws); viewing.delete(ws); historyAt.delete(ws); for (const t of turns.values()) t.watchers.delete(ws); });
  });

  return {
    broadcast,
    broadcastIndex: () => broadcast(indexMsg()),
    drain() {
      if (draining) return;
      draining = true;
      broadcast({ type: 'error', turnId: null, message: DRAINING_MESSAGE, code: 'draining' });
      // A process held open between turns (background tasks, DECK_BG_MAX_MIN) is not work in progress: end it now,
      // or it would sit out the whole drain window and then take the real turns down with it at the deadline.
      for (const t of turns.values()) endHeld(t);
    },
    /** Processes still up (running a prompt, or closing after `drain` ended them): the restart waits for these. */
    activeTurns: () => turns.size,
    abortAll() {
      // Marked as the server's: those turns end with SHUTDOWN_ABORTED, which the UI shows (a user's stop it hides).
      for (const t of turns.values()) t.ac.abort(SHUTDOWN_ABORT);
    },
    close() {
      unsubscribeUsage();
      if (outsideTimer) clearInterval(outsideTimer);
      for (const c of clients) c.close();
      wss.close();
    },
  };
}
