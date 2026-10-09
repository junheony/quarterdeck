import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { CodexSandbox, Effort, ModelChoice } from '../../shared/models';
import { HANDOFF_PROMPT } from '../../shared/handoff';
import { isGeminiAccount } from '../../shared/accounts';
import type { AccountInfo, ClientMessage } from '../../shared/protocol';
import { LEGACY_ACCOUNT_LIST, activePin, useAccounts } from '../accounts';
import { has } from '../features';
import { newChatDraftKey } from '../drafts';
import type { ProjectEntry, SessionEntry } from '../../shared/session-types';
import { linksOf, versionsAt } from '../../shared/branches';
import { cardsForPane, engineOf, modelFor, nextQueued, paneMode, type Action, type AppState, type PaneState, type UploadedAttachment } from '../state';
import type { UploadFn } from '../upload';
import { Chat, modelChoices, type ChatProps } from './Chat';
import { ModelPicker } from './ModelPicker';
import { ForkMenu } from './ForkMenu';
import { NewChat } from './NewChat';
import { OpenInDesktop } from './OpenInDesktop';
import { SidePanel } from './SidePanel';
import { deleteBlockedReason } from './SessionMenu';
import { SidePanelContext, clampSideWidth, type SideDoc } from '../sidePanel';
import { hasOpenPopup } from '../composerFocus';
import { isTypingTarget } from '../shortcuts';

// T9 prerequisite (a): every send carries a fresh correlation id so the reducer matches its turn_started / refusal
// to this pane, not to whichever pane waits first. Not crypto.randomUUID — it is missing outside secure contexts
// (plain http over Tailscale); a per-tab random prefix keeps ids from two tabs apart.
const TAB = Math.random().toString(36).slice(2, 10);
let seq = 0;
const nextClientRef = () => `${TAB}-${++seq}`;

/** The model a pane sends with. PF13: an existing session is never sent (or shown) a model of the other engine. */
function paneModel(pane: PaneState) {
  const s = pane.session;
  return s && s.sessionId !== null && s.engine ? modelFor(s.engine, pane.model) : pane.model;
}

/** The model field of a send: none for an existing Claude session the user picked no model for (it runs on its own default). */
function modelField(pane: PaneState, model: ModelChoice): { model?: ModelChoice } {
  return pane.session?.sessionId && !pane.modelPicked && engineOf(model) === 'claude' ? {} : { model };
}

/** 자동: effort is 자동 too unless the user picked one (null → omitted; the server picks per model). */
function paneEffort(pane: PaneState, model: ModelChoice): Effort | null {
  return model === 'auto' ? pane.autoEffort : pane.efforts[engineOf(model)];
}

/** Esc owners hasOpenPopup does not cover: the usage popover, the phone drawer, the folder picker. */
const ESC_OWNERS = '[role="tooltip"], .sidebar-wrap.drawer.open, .folder-picker';

/**
 * The socket's send: `false` = not connected, nothing went out (createSocket). Anything else counts as sent, so a caller
 * that cannot tell (tests, older wiring) behaves as before.
 */
export type SendFn = (m: ClientMessage) => unknown;

/**
 * Sends `text` (+ attachments) as the pane's next turn: `sent` for the reducer, `send` for the server. `ref`: a queued message's earlier clientRef (kept, so the server's acceptedRefs can tell whether it went in).
 * A send that never left (socket down) becomes a held queue item at once (`send_failed`), dispatched in the same tick as
 * `sent` so React renders neither a bubble nor 시작하는 중… for it.
 */
export function sendFromPane(pane: PaneState, text: string, attachments: UploadedAttachment[], dispatch: (a: Action) => void, send: SendFn, defaultMode: AppState['defaultPermMode'] = null, keepPaused = false, ref?: string): void {
  const s = pane.session;
  if (!s) return;
  const model = paneModel(pane);
  const effort = paneEffort(pane, model);
  const ids = attachments.map((a) => a.id);
  const clientRef = ref ?? nextClientRef();
  dispatch({ type: 'sent', text, paneId: pane.id, attachments: attachments.map((a) => ({ id: a.id, name: a.name, isImage: a.isImage })), clientRef, ...(keepPaused ? { keepPaused } : {}) });
  const sent = send({
    type: 'send', sessionId: s.sessionId, cwd: s.cwd, text, ...modelField(pane, model),
    ...(effort ? { effort } : {}),
    ...(s.sessionId === null ? { engine: pane.engine, sandbox: pane.sandbox, ...(s.accountPin ? { accountPin: s.accountPin } : {}), ...(s.permissionMode || defaultMode ? { permissionMode: paneMode(pane, defaultMode) } : {}) } : {}),
    ...(ids.length ? { attachments: ids } : {}),
    ...(s.sessionId === null && pane.handoffFrom ? { handoffFrom: pane.handoffFrom.sessionId } : {}),
    clientRef,
  });
  if (sent === false) dispatch({ type: 'send_failed', clientRef, paneId: pane.id });
}

/** 새 세션으로 이어가기, step 1: the handoff-note turn in the current session (same account and model: warm cache). */
export function startHandoff(pane: PaneState, dispatch: (a: Action) => void, send: SendFn): void {
  const s = pane.session;
  if (!s?.sessionId || pane.activeTurnId !== null || pane.awaitingStart) return;
  const model = paneModel(pane);
  const effort = paneEffort(pane, model);
  const clientRef = nextClientRef();
  dispatch({ type: 'sent', text: HANDOFF_PROMPT, paneId: pane.id, clientRef, handoff: true });
  // Never left: the pane stays on the session (a notice says why); the note is not queued — it is no message of the user's.
  if (send({ type: 'send', sessionId: s.sessionId, cwd: s.cwd, text: HANDOFF_PROMPT, ...modelField(pane, model), ...(effort ? { effort } : {}), handoff: true, clientRef }) === false) dispatch({ type: 'send_failed', clientRef, paneId: pane.id });
}

/**
 * 메시지 편집 갈래: `text` replaces user message `n` (shown as `original`) of the pane's Claude session. The pane turns
 * into the new branch session at once (same cwd, pin — when its account can still run a turn — and model); the server forks the transcript and the meta links it.
 */
export function startBranch(pane: PaneState, n: number, text: string, original: string, dispatch: (a: Action) => void, send: SendFn, accounts: readonly AccountInfo[] = LEGACY_ACCOUNT_LIST): void {
  const s = pane.session;
  if (!s?.sessionId || pane.activeTurnId !== null || pane.awaitingStart) return;
  const model = paneModel(pane);
  const effort = paneEffort(pane, model);
  const clientRef = nextClientRef();
  dispatch({ type: 'branch_edit', n, text, paneId: pane.id, clientRef });
  const sent = send({
    type: 'send', sessionId: null, cwd: s.cwd, text, ...modelField(pane, model), ...(effort ? { effort } : {}), engine: 'claude',
    ...(activePin(accounts, s.accountPin) ? { accountPin: s.accountPin } : {}),
    branch: { from: s.sessionId, n, ...(original ? { expect: original } : {}) },
    clientRef,
  });
  // Never left: like a refused edit, the text goes back with the original session, paused (Pane's branch_undo).
  if (sent === false) dispatch({ type: 'send_failed', clientRef, paneId: pane.id });
}

/** A session's title in the index (falls back to its id's head). */
function titleIn(projects: ProjectEntry[], sessionId: string): { title: string; cwd: string | null } {
  const e = projects.flatMap((p) => p.sessions).find((x) => x.sessionId === sessionId);
  return { title: e?.title ?? sessionId.slice(0, 8), cwd: e?.cwd ?? null };
}

const INTERRUPT_UNSENT = '연결이 끊겨 중단을 보내지 못했습니다 — 다시 연결된 뒤 눌러 주세요';
/** How long the 중단-not-sent notice stays. */
const NOTICE_MS = 6_000;

/** How long after its turn ended a steer may stay 전달 대기 without an answer. */
export const STEER_ANSWER_MS = 30_000;

/**
 * ux-state: when a pane's turn is over, its next queued message goes out by itself (once per queue item).
 * Runs at app level so panes not rendered (phone shows one) still drain their queues.
 */
export function useQueueRunner(panes: PaneState[], connected: boolean, dispatch: (a: Action) => void, send: SendFn, defaultMode: AppState['defaultPermMode'] = null): void {
  const fired = useRef(new Set<string>());
  const steerTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => () => { for (const t of steerTimers.current.values()) clearTimeout(t); }, []);
  useEffect(() => {
    // A steer still unanswered well after its turn ended: the answer was lost — back to a (paused) queue item, so nothing waits on it forever.
    for (const p of panes) {
      if (p.activeTurnId || p.awaitingStart) continue;
      for (const q of p.queue) {
        const id = q.steer;
        if (!id || steerTimers.current.has(id)) continue;
        steerTimers.current.set(id, setTimeout(() => dispatch({ type: 'steer_lost', steerId: id, paneId: p.id }), STEER_ANSWER_MS));
      }
    }
  });
  useEffect(() => {
    if (!connected) return;
    for (const p of panes) {
      // A mode picked during a new session's first turn goes out once the id is known (before any queued message).
      const s = p.session;
      if (s?.sessionId && s.permissionModePending && s.permissionMode) {
        dispatch({ type: 'set_permission_mode', mode: s.permissionMode, paneId: p.id });
        send({ type: 'set_permission_mode', sessionId: s.sessionId, mode: s.permissionMode });
      }
      const next = nextQueued(p);
      if (!next || fired.current.has(next.id)) continue;
      fired.current.add(next.id);
      dispatch({ type: 'queue_remove', id: next.id, paneId: p.id });
      sendFromPane(p, next.text, next.attachments, dispatch, send, defaultMode, next.restart === 'go', next.ref);
    }
  });
}

/** One split-view pane: its own session, items and composer; user actions become `send`/`dispatch` here (D6). */
export type SessionActions = {
  pins: string[];
  onRename: (sessionId: string, title: string | null) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  onArchive: (sessionId: string, archived: boolean) => void;
  onDelete: (s: SessionEntry) => void;
};

export function Pane({ pane, app, active, closable, dispatch, send, onClose, onOpenSession, onStartChat, newChatCwd, uploadFn, sessionActions }: {
  pane: PaneState;
  app: Pick<AppState, 'pending' | 'questions' | 'codexAvailable'> & Partial<Pick<AppState, 'connected' | 'gemini' | 'usage' | 'projects' | 'defaultPermMode'>>;
  active: boolean;
  closable: boolean;
  dispatch: (a: Action) => void;
  /** `false`: not sent (socket down). */
  send: SendFn;
  onClose: () => void;
  /** Opens a session in this pane (the 이전 세션 / 새 세션으로 이어감 links). */
  onOpenSession?: (sessionId: string, cwd: string, title: string) => void;
  /** The empty pane's start box: a new session in `cwd`, `text` (if any) sent as its first message with `attachments`. */
  onStartChat?: (cwd: string, name: string, text: string, attachments: UploadedAttachment[]) => void;
  /** The empty pane's preselected project. */
  newChatCwd?: string | null;
  uploadFn?: UploadFn;
  /** The chat title ⌄ menu (이름 바꾸기 / 고정 / 보관 / 삭제): the sidebar ⋯ menu's actions. Absent = no menu. */
  sessionActions?: SessionActions;
}) {
  const s = pane.session;
  // Side panel (artifacts / file preview): per pane, closed by ✕ or Esc, dropped when the pane's session changes.
  const [side, setSide] = useState<SideDoc | null>(null);
  const [sideWidth, setSideWidth] = useState(440);
  const sectionRef = useRef<HTMLElement>(null);
  const openSide = useCallback((doc: SideDoc) => setSide(doc), []);
  const sessionKey = s ? `${s.sessionId ?? ''}\n${s.cwd}` : '';
  useEffect(() => { setSide(null); }, [sessionKey]);
  useEffect(() => {
    if (!side) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Only the pane the user is in (split view: one Esc closes one panel).
      if (!active && !sectionRef.current?.contains(document.activeElement)) return;
      setSide(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [side, active]);
  // Stop: ux-state — the queue stays but pauses, so the next message does not fire into the stop.
  // A stop that never left (socket down) changes nothing: the turn runs on, so no 중단됨 and no pause — a notice says so.
  const sendInterrupt = (turnId: string): boolean => {
    if (send({ type: 'interrupt', turnId }) === false) {
      dispatch({ type: 'pane_notice', message: INTERRUPT_UNSENT, paneId: pane.id });
      return false;
    }
    dispatch({ type: 'interrupt_sent', turnId, paneId: pane.id });
    return true;
  };
  const interrupt = () => {
    if (!pane.activeTurnId) return;
    if (sendInterrupt(pane.activeTurnId) && pane.queue.length) dispatch({ type: 'queue_pause', paneId: pane.id });
  };
  // The notice is about a moment, not the session: it goes by itself.
  const unsentNotice = pane.notices?.some((n) => n.message === INTERRUPT_UNSENT);
  useEffect(() => {
    if (!unsentNotice) return;
    const t = setTimeout(() => dispatch({ type: 'dismiss_notice', paneId: pane.id, message: INTERRUPT_UNSENT }), NOTICE_MS);
    return () => clearTimeout(t);
  }, [unsentNotice, pane.id]);
  const interruptRef = useRef(interrupt);
  interruptRef.current = interrupt;
  // Esc stops the running turn from anywhere in the pane (the composer handles its own Esc). Whatever else owns the
  // Esc goes first: the capture phase only notes whether something was open (a menu / dialog / palette / popover /
  // the phone drawer, still on screen before its own handler closes it); the stop happens in the bubble phase, so a
  // handler that took the Esc (preventDefault, or a pin drag swallowing it in capture) wins. A field being edited
  // keeps its Esc; focus must be in this pane, or nowhere (then only the active pane stops).
  const turnId = pane.activeTurnId;
  useEffect(() => {
    if (!turnId || side) return;
    let owned = false;
    const note = (e: KeyboardEvent) => { if (e.key === 'Escape') owned = hasOpenPopup() || document.querySelector(ESC_OWNERS) !== null; };
    const onKey = (e: KeyboardEvent) => {
      // A held Esc: the first press closes a popup, its auto-repeats must not then stop the turn.
      if (e.key !== 'Escape' || e.repeat || e.defaultPrevented || e.isComposing || owned) return;
      if (isTypingTarget(e.target)) return;
      const a = document.activeElement;
      const nowhere = a === null || a === document.body;
      if (nowhere ? !active : !sectionRef.current?.contains(a)) return;
      e.preventDefault();
      interruptRef.current();
    };
    window.addEventListener('keydown', note, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', note, true); window.removeEventListener('keydown', onKey); };
  }, [turnId, side, active]);
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = sectionRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => setSideWidth(clampSideWidth(box.right - ev.clientX, box.width));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const focus = () => { if (!active) dispatch({ type: 'focus_pane', paneId: pane.id }); };
  const isNew = s?.sessionId === null;
  const model = paneModel(pane);
  const effort = paneEffort(pane, model);
  // 파일 (the session folder in the side panel) lives in the header's ⋯ menu, as Claude keeps its header bare.
  const fileMenu = s ? [{ label: side ? '파일 패널 닫기' : '파일 열기', run: () => setSide(side ? null : { kind: 'pick' }) }] : [];
  const close = closable && <button type="button" className="icon-btn pane-close" aria-label="패널 닫기" title="패널 닫기" onClick={onClose}>✕</button>;
  const busy = pane.activeTurnId !== null || pane.awaitingStart;
  const onModel = (m: ModelChoice) => dispatch({ type: 'set_model', model: m, paneId: pane.id });
  const onEffort = (e: Effort | null) => dispatch(model === 'auto' ? { type: 'set_auto_effort', effort: e, paneId: pane.id } : { type: 'set_effort', engine: engineOf(model), effort: e ?? pane.efforts[engineOf(model)], paneId: pane.id });
  const fork = s?.sessionId && s.engine !== 'codex' && s.engine !== 'gemini' && (
    <ForkMenu sessionId={s.sessionId} busy={busy} onResolved={() => send({ type: 'open_session', sessionId: s.sessionId! })} onError={(message) => dispatch({ type: 'show_error', message })} />
  );
  const desktop = s?.sessionId && s.engine !== 'codex' && s.engine !== 'gemini' && (
    <OpenInDesktop sessionId={s.sessionId} onError={(message) => dispatch({ type: 'show_error', message })} />
  );
  // 새 세션으로 이어가기: Claude sessions with an id, nothing running.
  const canHandoff = !!s?.sessionId && s.engine !== 'codex' && s.engine !== 'gemini' && !busy;
  const projects = app.projects ?? [];
  const entry = s?.sessionId ? projects.flatMap((p) => p.sessions).find((x) => x.sessionId === s.sessionId) : undefined;
  // 메시지 편집 갈래: Claude sessions with an id; otherwise 편집 puts the text in the composer (the note says why).
  const canBranch = canHandoff;
  // The server refuses to resume a session whose account was retired or is not configured any more: said before the send.
  const on = s?.sessionId && s.account && s.account !== 'gpt' && !isGeminiAccount(s.account) && has('accounts') ? s.account : null;
  const names = useAccounts();
  const gone = on ? names.look(on).kind : null;
  const editNote = !s?.sessionId ? '아직 저장되지 않은 새 세션이라 입력창에 넣습니다' : s.engine === 'codex' || s.engine === 'gemini' ? 'GPT·Gemini 세션은 대화를 갈라 편집할 수 없어 입력창에 넣습니다' : busy ? '실행 중에는 입력창에 넣습니다' : null;
  // Stable while the index and the session stay the same, so the memoized transcript does not re-render on every delta.
  const openRef = useRef(onOpenSession);
  openRef.current = onOpenSession;
  const sid = s?.sessionId ?? null;
  const cwd = s?.cwd ?? '';
  const versions = useMemo(() => {
    const all = projects.flatMap((p) => p.sessions);
    const links = linksOf(all);
    const known = new Set(all.map((x) => x.sessionId));
    return (n: number) => {
      if (!sid) return null;
      const v = versionsAt(links, sid, n);
      if (!v) return null;
      // A version whose session was deleted (휴지통) is skipped; its children still link to it and stay grouped.
      const own = v.members[v.index]!;
      const members = v.members.filter((id) => id === own || id === sid || known.has(id));
      if (members.length < 2) return null;
      return { index: Math.max(0, members.indexOf(own)), count: members.length, go: (i: number) => { const id = members[i]; if (id && id !== sid) { const t = titleIn(projects, id); openRef.current?.(id, t.cwd ?? cwd, t.title); } } };
    };
  }, [projects, sid, cwd]);
  // A refused edit (message not found, folder gone…) leaves an unsent new session: go back to the original instead.
  const branchUndo = useRef<{ sessionId: string; cwd: string; title: string } | null>(null);
  useEffect(() => {
    const u = branchUndo.current;
    if (!u || pane.awaitingStart) return;
    branchUndo.current = null;
    if (pane.myTurns.length === 0 && pane.session?.sessionId === null) {
      // The edited text (queued again, paused) and the rest of the queue go back with it.
      dispatch({ type: 'branch_undo', sessionId: u.sessionId, paneId: pane.id });
      openRef.current?.(u.sessionId, u.cwd, u.title);
    }
  }, [pane.awaitingStart, pane.myTurns.length, pane.session?.sessionId]);
  // A session deck lists gets the full menu; one only Claude Desktop lists (not in deck's projects) can be pinned.
  const pinned = !!sid && !!sessionActions?.pins.includes(sid);
  const titleMenu: ChatProps['titleMenu'] = !sid || !sessionActions ? undefined : entry
    ? {
        pinned, archived: !!entry.archived,
        onRename: (title) => sessionActions.onRename(entry.sessionId, title),
        onTogglePin: () => sessionActions.onTogglePin(entry.sessionId, !pinned),
        // Archived in Codex: only the Codex app can unarchive it (as in the sidebar).
        onArchive: entry.codexArchived ? undefined : () => sessionActions.onArchive(entry.sessionId, !entry.archived),
        onDelete: () => sessionActions.onDelete(entry),
        deleteBlocked: deleteBlockedReason(entry),
      }
    : { pinned, archived: false, onTogglePin: () => sessionActions.onTogglePin(sid, !pinned) };
  const prevId = entry?.prevSession ?? pane.handoffFrom?.sessionId ?? null;
  const link = (id: string | null) => {
    if (!id || !s) return null;
    const t = titleIn(projects, id);
    return { title: id === pane.handoffFrom?.sessionId && !t.cwd ? pane.handoffFrom.title : t.title, open: () => onOpenSession?.(id, t.cwd ?? s.cwd, t.title) };
  };
  return (
    <section ref={sectionRef} className={`pane ${active ? 'active' : ''}${side && s ? ' with-side' : ''}`} data-testid={`pane-${pane.id}`} data-pane={pane.id} onMouseDownCapture={focus} onFocusCapture={focus}>
      <SidePanelContext.Provider value={s ? openSide : null}>
      {s ? (
        <Chat
          items={pane.items}
          pending={cardsForPane(pane, app.pending)}
          questions={cardsForPane(pane, app.questions)}
          activeTurnId={pane.activeTurnId}
          busy={busy}
          connected={app.connected ?? true}
          title={s.title}
          titleMenu={titleMenu}
          loading={!!pane.loading}
          cwd={s.cwd}
          sessionId={s.sessionId}
          headActions={<>{desktop}{fork}{close}</>}
          headMenu={fileMenu}
          model={model}
          effort={effort}
          engine={pane.engine}
          sandbox={pane.sandbox}
          sessionEngine={s.engine}
          sessionSandbox={s.sandbox}
          isNew={isNew}
          codexAvailable={app.codexAvailable}
          gemini={app.gemini ?? null}
          attachments={pane.attachments}
          uploadFn={uploadFn}
          onSend={(text) => sendFromPane(pane, text, pane.attachments, dispatch, send, app.defaultPermMode ?? null)}
          onBranch={canBranch ? (n, text, original) => { branchUndo.current = { sessionId: s.sessionId!, cwd: s.cwd, title: s.title }; startBranch(pane, n, text, original, dispatch, send, names.all); } : undefined}
          editNote={editNote}
          versions={versions}
          onHandoff={canHandoff ? () => startHandoff(pane, dispatch, send) : undefined}
          handoffWriting={pane.handoff !== null}
          prefill={pane.prefill}
          draftKey={`new:${pane.id}`}
          prevSession={link(prevId)}
          nextSession={link(entry?.nextSession ?? null)}
          notices={pane.notices?.filter((n) => n.sessionId === null || n.sessionId === s.sessionId)}
          onDismissNotice={(message) => dispatch({ type: 'dismiss_notice', paneId: pane.id, message })}
          composerNote={gone === 'retired' ? '뺀 계정의 세션이라 이어 쓸 수 없습니다 — 기록은 볼 수 있습니다' : gone === 'unknown' ? '설정에 없는 계정의 세션이라 이어 쓸 수 없습니다' : null}
          readOnly={entry?.codexArchived ? '보관된 Codex 대화라 읽기만 할 수 있어요' : entry?.imported && entry.cwdMissing ? '폴더가 없어 이어서 보낼 수 없어요 · 읽기만 할 수 있어요' : null}
          onInterrupt={interrupt}
          onCancelStart={() => dispatch({ type: 'cancel_start', paneId: pane.id })}
          onStopBackground={(turnId) => { sendInterrupt(turnId); }}
          onStopTask={(taskId) => { if (pane.bg) send({ type: 'stop_task', turnId: pane.bg.turnId, taskId }); }}
          runStartedAt={pane.runStartedAt}
          progress={pane.progress}
          agents={pane.agents}
          bg={pane.bg}
          queue={pane.queue}
          queuePaused={pane.queuePaused}
          onQueue={(text) => {
            // A running Claude turn takes the message in at its next tool boundary (전달 대기 until the server confirms);
            // Codex / Gemini, or a refused steer, keep it queued for after the turn.
            const body = text.trim();
            if (pane.activeTurnId && s.engine === 'claude' && !pane.awaitingStart && body) {
              const steerId = nextClientRef();
              const ids = pane.attachments.map((a) => a.id);
              dispatch({ type: 'queue_add', text, paneId: pane.id, steerId });
              // Never left (socket down): an ordinary queue item at once.
              if (send({ type: 'steer', turnId: pane.activeTurnId, steerId, text: body, ...(ids.length ? { attachments: ids } : {}) }) === false) dispatch({ type: 'steer_lost', steerId, paneId: pane.id, unsent: true });
              return;
            }
            dispatch({ type: 'queue_add', text, paneId: pane.id });
          }}
          onQueueEdit={(id, text) => dispatch({ type: 'queue_edit', id, text, paneId: pane.id })}
          onQueueRemove={(id) => dispatch({ type: 'queue_remove', id, paneId: pane.id })}
          onQueueClear={() => dispatch({ type: 'queue_clear', paneId: pane.id })}
          onQueueResume={() => dispatch({ type: 'queue_resume', paneId: pane.id })}
          onQueueSendNow={(id) => {
            // 지금 전송: the item jumps the queue and goes out once the interrupt ends the turn (useQueueRunner).
            dispatch({ type: 'queue_send_now', id, paneId: pane.id });
            if (pane.activeTurnId) sendInterrupt(pane.activeTurnId);
          }}
          onDecide={(requestId, decision) => send({ type: 'permission_response', requestId, decision })}
          onAnswer={(requestId, answers) => send({ type: 'question_response', requestId, answers })}
          onModel={onModel}
          onEffort={onEffort}
          onEngine={(engine) => dispatch({ type: 'set_engine', engine, paneId: pane.id })}
          onSandbox={(sandbox) => dispatch({ type: 'set_sandbox', sandbox, paneId: pane.id })}
          {...(s.sessionId && s.engine === 'codex' && has('sessionSandbox') ? {
            // D2: an existing GPT session's sandbox lives on the server (its next turn uses it). The chip follows the server's
            // `sandbox` answer (the sender gets it too), so a refusal leaves it as it was.
            onSessionSandbox: (sandbox: CodexSandbox) => { send({ type: 'set_sandbox', sessionId: s.sessionId!, sandbox }); },
          } : {})}
          accountPin={s.accountPin ?? null}
          account={s.account}
          usage={app.usage ?? null}
          onAccountPin={(pin) => {
            dispatch({ type: 'set_account_pin', pin, paneId: pane.id });
            // An existing session's pin lives on the server (applied from its next turn); a new one rides the first send.
            if (s.sessionId) send({ type: 'set_account_pin', sessionId: s.sessionId, pin });
          }}
          permMode={paneMode(pane, app.defaultPermMode ?? null)}
          onPermMode={(mode) => {
            dispatch({ type: 'set_permission_mode', mode, paneId: pane.id });
            // An existing session's mode lives on the server (a running turn switches at once); a new one rides the first
            // send, or — picked while that send's turn runs — goes out when the id arrives (useQueueRunner).
            if (s.sessionId) send({ type: 'set_permission_mode', sessionId: s.sessionId, mode });
          }}
          onAttach={(attachment) => dispatch({ type: 'attach', attachment, paneId: pane.id })}
          onUnattach={(id) => {
            const url = pane.attachments.find((a) => a.id === id)?.previewUrl;
            if (url) URL.revokeObjectURL(url);
            dispatch({ type: 'unattach', id, paneId: pane.id });
          }}
        />
      ) : (
        <>
          {close && <div className="chat-head"><span className="spacer" />{close}</div>}
          {onStartChat
            ? <NewChat projects={projects} defaultCwd={newChatCwd ?? null} onStart={onStartChat} draftKey={newChatDraftKey(pane.id)} engine={pane.engine} sandbox={pane.sandbox} codexAvailable={app.codexAvailable} gemini={app.gemini ?? null}
                onEngine={(engine) => dispatch({ type: 'set_engine', engine, paneId: pane.id })} onSandbox={(sandbox) => dispatch({ type: 'set_sandbox', sandbox, paneId: pane.id })} {...(onOpenSession ? { onOpenSession } : {})} {...(uploadFn ? { uploadFn } : {})}
                modelPicker={<ModelPicker models={modelChoices(pane.engine)} model={model} effort={effort} onModel={onModel} onEffort={onEffort} />} />
            : <div className="chat center muted">왼쪽에서 세션을 고르거나 새 세션을 시작하세요.</div>}
        </>
      )}
      {side && s && (
        <>
          <div className="side-splitter" role="separator" aria-orientation="vertical" aria-label="사이드 패널 크기 조절" onPointerDown={startResize} />
          <div className="side-wrap" style={{ width: sideWidth }}>
            <SidePanel doc={side} cwd={s.cwd} sessionId={s.sessionId} onClose={() => setSide(null)} onOpen={openSide} />
          </div>
        </>
      )}
      </SidePanelContext.Provider>
    </section>
  );
}
