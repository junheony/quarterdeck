import { loadDraft, saveDraft } from '../autoReload';
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type ComponentProps, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { CLAUDE_MODELS, CODEX_MODELS, CODEX_SANDBOXES, GEMINI_MODELS, GEMINI_SANDBOX_LABEL, SANDBOX_LABEL, type CodexSandbox, type Effort, type EngineChoice, type EngineKind, type ModelChoice } from '../../shared/models';
import type { Account, Seat } from '../../shared/accounts';
import type { GeminiStatus } from '../../shared/protocol';
import type { UsageSnapshot } from '../../shared/usage-types';
import type { PermissionDecision, QuestionAnswers, TurnPhase } from '../../shared/turn-types';
import type { AgentInfo, ChatItem, PaneBackground, PendingPermission, PendingQuestion, QueueItem, UploadedAttachment } from '../state';
import { latestContext } from '../context';
import { latestTodos } from '../todos';
import { useStickToBottom } from '../stickToBottom';
import { mergeToolRuns } from '../toolRuns';
import { ATTACHMENT_ONLY_TEXT, filesFrom, uploadFile, useUploads, type UploadFn } from '../upload';
import { AgentContext, BackgroundPill, StatusRow, type AgentCtx } from './Activity';
import { EngineMark } from './EngineMark';
import { AccountPicker } from './AccountPicker';
import { AttachMenu, AttachmentBar } from './AttachmentBar';
import { ContextGauge, ContextHint } from './ContextGauge';
import { useComposerSuggest } from './ComposerSuggest';
import { HANDOFF_COMMAND, HANDOFF_PROMPT } from '../../shared/handoff';
import { PERM_MODES, PERM_MODE_HINT, PERM_MODE_LABEL, nextPermMode, type PermMode } from '../../shared/permission';
import type { CommandItem } from '../autocomplete';
import { MessageActionsContext, MessageView, type MessageActions } from './MessageView';
import { ModelPicker } from './ModelPicker';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { DictationButton } from './DictationButton';
import { QueueChips } from './QueueChips';
import { useShareActions } from './ShareMenu';
import { TodoPanel } from './TodoPanel';
import { usePrefs } from '../usePrefs';
import { BlockedDeleteItem, MenuList } from './SessionMenu';
import { useAutoGrow } from '../useAutoGrow';

export type ChatProps = {
  items: ChatItem[];
  pending: PendingPermission[];
  questions: PendingQuestion[];
  activeTurnId: string | null;
  busy: boolean;
  title: string;
  /** The title ⌄ menu (the sidebar ⋯ actions; `deleteBlocked` = 삭제 shown disabled with this reason). Absent = the caret is decoration. */
  titleMenu?: { pinned: boolean; archived: boolean; onRename?: (title: string | null) => void; onTogglePin?: () => void; onArchive?: () => void; onDelete?: () => void; deleteBlocked?: string | null };
  /** Session folder: the header shows its last segment as a chip, the full path on hover. */
  cwd?: string;
  /** For `/` command suggestions (null while the session is new). */
  sessionId?: string | null;
  /** Right-aligned header buttons (갈라짐, Desktop에서 열기, the pane's close button), before the ⋯ menu. */
  headActions?: ReactNode;
  /** Extra ⋯ menu items from the pane (파일 열기 / 파일 패널 닫기). */
  headMenu?: { label: string; run: () => void }[];
  model: ModelChoice;
  /** Reasoning effort for `model`'s engine; null = 자동 (model 자동 only). */
  effort: Effort | null;
  /** New-session choices (D2, D3). */
  engine: EngineChoice;
  sandbox: CodexSandbox;
  /** The open session's engine/sandbox (null until known); ignored while the session is new (PF11). */
  sessionEngine: EngineKind | null;
  sessionSandbox: CodexSandbox | null;
  isNew: boolean;
  codexAvailable: boolean;
  /** null = no gemini-cli: no Gemini option. Not logged in: the option is shown disabled with 로그인 필요. */
  gemini?: GeminiStatus | null;
  attachments: UploadedAttachment[];
  uploadFn?: UploadFn;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  /** Stops the background work held by that turn's process (interrupt by its turn id). */
  onStopBackground?: (turnId: string) => void;
  /** Stops one background task (Query.stopTask). */
  onStopTask?: (taskId: string) => void;
  /** Status row: when the running turn started (client clock), its output tokens and phase. */
  runStartedAt?: number | null;
  progress?: { outputTokens: number; phase: TurnPhase } | null;
  /** Subagent cards by Agent call id; the background pill. */
  agents?: Record<string, AgentInfo>;
  bg?: PaneBackground | null;
  onDecide: (requestId: string, decision: PermissionDecision) => void;
  onAnswer: (requestId: string, answers: QuestionAnswers) => void;
  onModel: (m: ModelChoice) => void;
  onEffort: (e: Effort | null) => void;
  onEngine: (e: EngineChoice) => void;
  onSandbox: (s: CodexSandbox) => void;
  onAttach: (a: UploadedAttachment) => void;
  onUnattach: (id: string) => void;
  /** 이 세션은 B 써 (Claude sessions): the pinned account (null = 자동), the account it runs on, usage for the menu. */
  accountPin?: Account | null;
  account?: Seat | null;
  usage?: UsageSnapshot | null;
  /** Absent = no account picker. */
  onAccountPin?: (pin: Account | null) => void;
  /** Claude permission mode (Shift+Tab cycles); absent onPermMode = no mode picker. */
  permMode?: PermMode;
  onPermMode?: (m: PermMode) => void;
  /** ux-state: while busy, a submit queues the message (absent = the composer can't send while busy). */
  queue?: QueueItem[];
  queuePaused?: boolean;
  onQueue?: (text: string) => void;
  onQueueEdit?: (id: string, text: string) => void;
  onQueueRemove?: (id: string) => void;
  onQueueClear?: () => void;
  onQueueResume?: () => void;
  /** 지금 전송: interrupt the running turn and send this queued item right away (absent = no such action). */
  onQueueSendNow?: (id: string) => void;
  /** 메시지 편집 갈래: send `text` in place of user message `n` (shown as `original`). Absent = 편집 fills the composer instead. */
  onBranch?: (n: number, text: string, original: string) => void;
  /** Why 편집 fills the composer instead of branching (tooltip); null = it branches. */
  editNote?: string | null;
  /** The versions of user message `n` (`< i/N >`); null = one version only. */
  versions?: (n: number) => { index: number; count: number; go: (i: number) => void } | null;
  /** 새 세션으로 이어가기 (absent = not offered: new / GPT / Gemini session, or a turn running). Also `/handoff`. */
  onHandoff?: () => void;
  /** The handoff-note turn is running. */
  handoffWriting?: boolean;
  /** Text put into the composer once (the new session's first message after a handoff); not sent. Never over a draft. */
  prefill?: string | null;
  /** Where the draft of a session with no id yet is kept (per pane), so a remount or reload does not lose it. */
  draftKey?: string;
  /** 새 세션으로 이어가기 links: the session this one continues / continues in. */
  prevSession?: { title: string; open: () => void } | null;
  nextSession?: { title: string; open: () => void } | null;
  /** Notes / errors about this session no turn owns (e.g. it was just written outside deck): dismissible bars above the transcript. */
  notices?: { message: string; level: 'notice' | 'error' }[];
  onDismissNotice?: (message: string) => void;
  /** View-only session (e.g. an imported Codex thread whose folder is gone): the composer is disabled and shows this reason. */
  readOnly?: string | null;
  /** A line above the composer (the server will refuse a send here, and says why itself). */
  composerNote?: string | null;
  /** The session's history is on its way: a placeholder instead of a blank transcript. */
  loading?: boolean;
};

const HANDOFF_COMMANDS: CommandItem[] = [{ name: HANDOFF_COMMAND, description: '새 세션으로 이어가기 (인계 메모를 쓰고 새 세션에 붙여 넣기)', argumentHint: '' }];

/** The model picker's choices for an engine (자동 offered for Claude and the engine 자동; Gemini only when picked). */
export function modelChoices(engine: EngineChoice): readonly ModelChoice[] {
  return engine === 'gemini' ? GEMINI_MODELS : engine === 'codex' ? CODEX_MODELS : engine === 'claude' ? ['auto', ...CLAUDE_MODELS] : ['auto', ...CLAUDE_MODELS, ...CODEX_MODELS];
}

/** Enter inserts a newline on touch screens (send with the button), as on Desktop's mobile apps. */
const COARSE_QUERY = '(pointer: coarse), (hover: none)';
function useCoarsePointer(): boolean {
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(COARSE_QUERY).matches;
  const [coarse, setCoarse] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(COARSE_QUERY);
    const on = () => setCoarse(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return coarse;
}

/**
 * On a touch device, is the on-screen keyboard up right now? An iPad (or a phone) with a hardware keyboard reports
 * a coarse pointer too, but shows no soft keyboard, so the visual viewport keeps its full height. We track the tallest
 * viewport seen at the current width (an orientation/split change resets it) and call the keyboard "up" when the
 * viewport is clearly shorter than that. No visualViewport → assume a soft keyboard (the old behaviour).
 */
let vvWidth = 0;
let vvMax = 0;
function trackViewport(): void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return;
  const w = Math.round(vv.width * vv.scale);
  if (w !== vvWidth) { vvWidth = w; vvMax = 0; }
  vvMax = Math.max(vvMax, vv.height);
  syncSoftKeyboardAttr();
}
/**
 * CSS hook `<html data-soft-kb>`: with the on-screen keyboard up the composer drops its home-indicator inset
 * (styles.css "bottom edge"). Measured against the layout viewport, not the tallest height seen: an iOS keyboard
 * shrinks only the visual viewport, while a pinch-zoom (height × scale stays put) or a Stage Manager / split
 * resize (the layout viewport shrinks with it) is not a keyboard and never leaves the attribute stuck on.
 */
export function syncSoftKeyboardAttr(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const vv = window.visualViewport;
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia(COARSE_QUERY).matches;
  const layout = document.documentElement.clientHeight;
  const up = !!vv && coarse && layout > 0 && vv.height * vv.scale < layout * 0.8;
  document.documentElement.toggleAttribute('data-soft-kb', up);
}
if (typeof window !== 'undefined' && window.visualViewport) {
  trackViewport();
  window.visualViewport.addEventListener('resize', trackViewport);
}
export function softKeyboardUp(): boolean {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return true;
  trackViewport();
  return vvMax > 0 && vv.height < vvMax * 0.8;
}

/** Enter = newline right now? (a touch screen with its on-screen keyboard up). Read at keydown time. */
export function touchEnterIsNewline(): boolean {
  const coarse = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(COARSE_QUERY).matches;
  return coarse && softKeyboardUp();
}

const NO_AGENTS: Record<string, AgentInfo> = {};

/** The header badge's compact form when the pane is narrow (CSS swaps them; the badge never clips mid-glyph). */
const PERM_MODE_SHORT: Record<PermMode, string> = { default: '묻기', acceptEdits: '편집 승인', plan: '계획', bypassPermissions: '자동 승인' };
const WarnIcon = () => <svg className="perm-badge-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2.2 14.3 13.3H1.7z" /><path d="M8 6.6v3M8 11.6v.1" /></svg>;
const QueueIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 4h8M2.5 8h5M2.5 12h4" /><path d="M12 6.5v6.5M9.75 10.75 12 13l2.25-2.25" /></svg>;

/**
 * A composer picker over a native <select>: the visible label is a span (so it ellipsizes cleanly when the toolbar is
 * tight) and the transparent select on top keeps the native menu, keyboard and accessible name.
 */
function Pick({ className, label, children, ...rest }: { className?: string; label: ReactNode } & Omit<ComponentProps<'select'>, 'className'>) {
  return (
    <span className={`pick ${className ?? ''}`} data-disabled={rest.disabled ? '' : undefined}>
      <span className="pick-label" aria-hidden="true">{label}</span>
      <select {...rest}>{children}</select>
    </span>
  );
}

export function Chat(p: ChatProps) {
  const draftKey = p.sessionId ?? p.draftKey ?? null;
  const [text, setText] = useState(() => loadDraft(draftKey));
  // The pane switched sessions: show that session's draft, not the previous one's. Done during render so the save
  // effect below never writes the old text under the new id. A new session getting its id (null → id) keeps the text.
  const [draftId, setDraftId] = useState(p.sessionId);
  if (draftId !== p.sessionId) {
    setDraftId(p.sessionId);
    if (draftId) setText(loadDraft(draftKey));
  }
  useEffect(() => { saveDraft(draftKey, text); }, [draftKey, text]);
  // The session has its id now: its draft lives under the id; the id-less one is spent.
  useEffect(() => { if (p.sessionId && p.draftKey) saveDraft(p.draftKey, ''); }, [p.sessionId, p.draftKey]);
  // Only into an empty composer: a remount must not put the original note back over the user's edits.
  useEffect(() => { if (p.prefill) setText((t) => (t.trim() ? t : p.prefill!)); }, [p.prefill]);
  const [drag, setDrag] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Desktop: the composer grows with the text up to the CSS max-height (40vh) and shrinks back after a send.
  const bodyRef = useRef<HTMLDivElement>(null);
  useAutoGrow(taRef, text, bodyRef);
  const content = useMemo(() => ({}), [p.items, p.pending, p.questions]);
  const scroll = useStickToBottom(bodyRef, content, p.sessionId);
  const { addFiles: upload, uploading, error } = useUploads({ uploadFn: p.uploadFn ?? uploadFile, current: p.attachments.length, onUploaded: p.onAttach });
  // Read-only: no paste / drop / 첨부 uploads either.
  const addFiles = async (files: File[]) => { if (!p.readOnly) await upload(files); };
  const coarse = useCoarsePointer();
  // Set between compositionstart/end: some browsers report isComposing late or not at all.
  const composing = useRef(false);
  const shown = useMemo(() => mergeToolRuns(p.items), [p.items]);
  const todos = useMemo(() => latestTodos(p.items), [p.items]);

  // Review M12: a failed last turn can be re-sent as-is.
  const last = p.items.at(-1);
  const lastPrompt = ([...p.items].reverse().find((it) => it.kind === 'user') as Extract<ChatItem, { kind: 'user' }> | undefined)?.text ?? null;
  // Never a handoff-note request: re-sending it would run the note prompt as a plain turn (tools allowed, no switch).
  const retryable = lastPrompt !== HANDOFF_PROMPT ? lastPrompt : null;
  const retryPrompt = !p.busy && !p.readOnly && last?.kind === 'assistant' && last.error !== null && !last.streaming ? retryable : null;

  // D3 / PF11: a new session follows the picker (the engine recorded at open time is ignored while it is new);
  // once the session exists its engine is fixed.
  const effectiveEngine: EngineChoice = p.isNew ? p.engine : (p.sessionEngine ?? 'claude');
  // 자동 is offered for Claude (and the engine 자동, which may open on Claude); on an existing session it keeps the session's model.
  // Gemini is explicit only: its models appear only when the Gemini engine is picked (never under 자동).
  const models = modelChoices(effectiveEngine);
  const geminiReady = !!p.gemini && (p.gemini.loggedIn.g1 || p.gemini.loggedIn.g2);
  const engineSelect = p.isNew && (p.codexAvailable || !!p.gemini?.available);
  const sandboxLabel = effectiveEngine === 'gemini' ? GEMINI_SANDBOX_LABEL : SANDBOX_LABEL;
  const hasDraft = (text.trim().length > 0 || p.attachments.length > 0) && uploading === 0;
  const queueing = p.busy && !!p.onQueue;
  /** A running Claude turn takes a message at its next tool boundary (Codex / Gemini: after the turn). */
  const steering = queueing && !!p.activeTurnId && p.sessionEngine === 'claude';
  const canSend = hasDraft && !p.readOnly && (!p.busy || queueing);
  const live = last?.kind === 'assistant' && last.streaming ? last : null;
  const agents = p.agents ?? NO_AGENTS;
  const bgLive = !!p.bg;
  const turnActive = p.activeTurnId !== null;
  const agentCtx = useMemo<AgentCtx>(() => ({ agents, bgLive, active: turnActive }), [agents, bgLive, turnActive]);
  const suggest = useComposerSuggest({ text, setText, textareaRef: taRef, cwd: p.cwd, sessionId: p.sessionId ?? null, commands: effectiveEngine !== 'codex', ...(p.onHandoff ? { extraCommands: HANDOFF_COMMANDS } : {}) });
  const ctx = useMemo(() => latestContext(p.items), [p.items]);
  // Message actions: 편집 puts the text back in the composer (sent as a new turn); 재시도 re-sends the last prompt.
  // Stable across keystrokes (refs) so the memoized transcript does not re-render while typing.
  const onSendRef = useRef(p.onSend);
  onSendRef.current = p.onSend;
  const onBranchRef = useRef(p.onBranch);
  onBranchRef.current = p.onBranch;
  const canBranch = !!p.onBranch;
  const canRetry = !p.busy && !p.readOnly && retryPrompt === null && retryable !== null && last?.kind === 'assistant';
  const msgActions = useMemo<MessageActions>(() => ({
    onEdit: (t) => {
      setText(t);
      requestAnimationFrame(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.setSelectionRange(t.length, t.length); } });
    },
    ...(canRetry && retryable !== null ? { onRetry: () => { onSendRef.current(retryable); scroll.attach(); } } : {}),
    ...(canBranch ? { onBranch: (n: number, t: string, original: string) => { onBranchRef.current?.(n, t, original); scroll.attach(); } } : {}),
    editNote: p.editNote ?? null,
    ...(p.versions ? { versions: p.versions } : {}),
    coarse,
  }), [canRetry, retryable, scroll.attach, canBranch, p.editNote, p.versions, coarse]);
  // GPT/Gemini have no per-call approvals: their sandbox decides, so the mode picker is shown disabled.
  const permSupported = effectiveEngine === 'claude' || effectiveEngine === 'auto';
  const permMode: PermMode = p.permMode ?? 'default';
  const folder = p.cwd ? (p.cwd.split('/').filter(Boolean).pop() ?? p.cwd) : null;

  const submit = () => {
    if (!canSend) return;
    if (p.onHandoff && text.trim() === `/${HANDOFF_COMMAND}` && p.attachments.length === 0) {
      p.onHandoff();
      setText('');
      scroll.attach();
      return;
    }
    const msg = text.trim() || ATTACHMENT_ONLY_TEXT;
    if (p.busy) p.onQueue?.(msg);
    else p.onSend(msg);
    setText('');
    scroll.attach();
  };
  // Title ⌄ menu and its inline rename (closed when the pane shows another session).
  const [titleMenuOpen, setTitleMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const renamingRef = useRef<string | null>(null);
  renamingRef.current = renaming;
  useEffect(() => { setTitleMenuOpen(false); setRenaming(null); }, [p.sessionId]);
  const commitRename = () => {
    const v = renamingRef.current;
    if (v === null) return;
    renamingRef.current = null;
    setRenaming(null);
    const t = v.replace(/\s+/g, ' ').trim();
    if (t !== p.title) p.titleMenu?.onRename?.(t || null);
  };
  const tm = p.titleMenu;
  const showAccount = !!p.onAccountPin && (effectiveEngine === 'claude' || (!!p.isNew && effectiveEngine === 'auto'));
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => { setMoreOpen(false); }, [p.sessionId]);
  const share = useShareActions({ title: p.title, items: p.items, ...(p.cwd ? { cwd: p.cwd } : {}), sessionId: p.sessionId ?? null, assistant: p.sessionEngine === 'codex' ? 'GPT' : p.sessionEngine === 'gemini' ? 'Gemini' : 'Claude' }, () => setMoreOpen(false));
  const shareActions = p.isNew ? [] : share.actions;
  /** 이름 바꾸기 / 고정 / 보관 — the same in the title menu and the ⋯ menu; 삭제 comes last in both. */
  const sessionItems = (close: () => void) => tm && (
    <>
      {tm.onRename && <button type="button" role="menuitem" onClick={() => { close(); setRenaming(p.title); }}>이름 바꾸기</button>}
      {tm.onTogglePin && <button type="button" role="menuitem" onClick={() => { close(); tm.onTogglePin?.(); }}>{tm.pinned ? '고정 해제' : '맨 위에 고정'}</button>}
      {tm.onArchive && <button type="button" role="menuitem" onClick={() => { close(); tm.onArchive?.(); }}>{tm.archived ? '보관 해제' : '보관'}</button>}
    </>
  );
  const deleteItem = (close: () => void) => tm && (tm.deleteBlocked
    ? <BlockedDeleteItem reason={tm.deleteBlocked} />
    : tm.onDelete && <button type="button" role="menuitem" className="danger" onClick={() => { close(); tm.onDelete?.(); }}>삭제…</button>);
  const hasMore = !!tm || shareActions.length > 0 || (p.headMenu?.length ?? 0) > 0;
  const [{ sendKey }] = usePrefs();
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest.onKeyDown(e)) return;
    // IME: never act on a key that is still part of a composition (Korean/Japanese/Chinese input). keyCode 229 is
    // Safari's Enter that commits the syllable (fired after compositionend with isComposing false). Chrome's own Enter
    // after the commit is a real Enter and sends the full text.
    const ime = e.nativeEvent.isComposing || e.keyCode === 229 || composing.current;
    if (ime) return;
    if (e.key === 'Tab' && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && p.onPermMode && permSupported) {
      e.preventDefault();
      p.onPermMode(nextPermMode(permMode));
      return;
    }
    if (e.key === 'Escape') {
      if (p.activeTurnId) { e.preventDefault(); p.onInterrupt(); }
      return;
    }
    if (e.key === 'ArrowUp' && text === '' && e.currentTarget.selectionStart === 0 && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      // Recall: the last queued message comes back for editing; otherwise the last sent one.
      const queued = p.queue?.at(-1);
      const sent = [...p.items].reverse().find((it) => it.kind === 'user') as Extract<ChatItem, { kind: 'user' }> | undefined;
      const recall = queued?.text ?? sent?.text;
      if (!recall) return;
      e.preventDefault();
      if (queued) p.onQueueRemove?.(queued.id);
      setText(recall);
      return;
    }
    if (e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); submit(); return; }
    // Touch screens: Enter is a newline while the on-screen keyboard is up (send with the button); with a hardware
    // keyboard (iPad + Magic Keyboard, a phone with a BT keyboard) Enter sends like on a computer.
    if (e.shiftKey || e.altKey || (coarse && softKeyboardUp()) || sendKey === 'mod-enter') return;
    e.preventDefault();
    submit();
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFrom(e.clipboardData);
    if (files.length) { e.preventDefault(); void addFiles(files); }
  };
  // Files dropped anywhere on the pane attach (full-pane overlay while dragging); never a browser navigation. Anything
  // else dragged (text into the rename / edit / queue fields) is left to the browser. Enter/leave are counted: moving
  // between children fires leave/enter pairs, and Safari gives dragleave no relatedTarget.
  const dragDepth = useRef(0);
  const hasFiles = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const onDragEnter = (e: DragEvent<HTMLElement>) => {
    if (!hasFiles(e)) return;
    dragDepth.current += 1;
    if (!drag) setDrag(true);
  };
  const onDragOver = (e: DragEvent<HTMLElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (p.readOnly) e.dataTransfer.dropEffect = 'none';
    if (!drag) setDrag(true);
  };
  const onDragLeave = (e: DragEvent<HTMLElement>) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    // A child removed mid-drag (a streaming message re-rendering) never sends its leave, so the count can stay up;
    // the pointer actually leaving the pane's box always ends the overlay.
    const r = e.currentTarget.getBoundingClientRect();
    const outside = r.width > 0 && (e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom);
    if (outside) dragDepth.current = 0;
    if (dragDepth.current === 0) setDrag(false);
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDrag(false);
    const files = filesFrom(e.dataTransfer);
    if (files.length) void addFiles(files);
  };
  return (
    <main className="chat" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {drag && <div className={`drop-overlay ${p.readOnly ? 'blocked' : ''}`} data-testid="drop-overlay"><span>{p.readOnly || '여기에 파일을 놓으세요'}</span></div>}
      {/* Claude's header: the title (folder on a second line) centred, chips on the left, ⋯ on the right. A narrow
          pane falls back to a left-aligned, truncating row (styles.css, @container pane). */}
      <div className="chat-head">
        <div className="chat-head-main">
          <span className="chat-title-wrap">
            {renaming !== null ? (
              <input className="chat-title-input" aria-label="채팅 이름" value={renaming} autoFocus maxLength={200}
                onChange={(e) => setRenaming(e.target.value)} onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                  if (e.key === 'Escape') { e.preventDefault(); renamingRef.current = null; setRenaming(null); }
                }} />
            ) : tm ? (
              <button type="button" className="chat-title" title={p.title} aria-haspopup="menu" aria-expanded={titleMenuOpen} onClick={() => setTitleMenuOpen((o) => !o)}>
                <span>{!p.isNew && p.sessionEngine && <EngineMark engine={p.sessionEngine} />}{p.title}</span><span className="caret" aria-hidden="true">⌄</span>
              </button>
            ) : (
              <span className="chat-title" title={p.title}><span>{!p.isNew && p.sessionEngine && <EngineMark engine={p.sessionEngine} />}{p.title}</span></span>
            )}
            {titleMenuOpen && tm && (
              <MenuList className="session-menu chat-title-menu" label="채팅 메뉴" onClose={() => setTitleMenuOpen(false)}>
                {sessionItems(() => setTitleMenuOpen(false))}
                {deleteItem(() => setTitleMenuOpen(false))}
              </MenuList>
            )}
          </span>
          {folder && <span className="folder-chip chat-subtitle" title={p.cwd}>{folder}</span>}
        </div>
        <div className="chat-head-chips">
          {!p.isNew && p.sessionEngine === 'codex' && <span className="chip sandbox" title="D2: GPT 세션은 승인 카드 대신 샌드박스로 보호됩니다">GPT · 샌드박스: {SANDBOX_LABEL[p.sessionSandbox ?? 'read-only']}</span>}
          {p.onPermMode && permSupported && permMode !== 'default' && <span className={`chip perm-badge perm-${permMode}`} title={`${PERM_MODE_LABEL[permMode]} — ${PERM_MODE_HINT[permMode]}`} data-testid="perm-badge">{permMode === 'bypassPermissions' && <WarnIcon />}<span className="perm-badge-full">{PERM_MODE_LABEL[permMode]}</span><span className="perm-badge-short" aria-hidden="true">{PERM_MODE_SHORT[permMode]}</span></span>}
          {!p.isNew && p.sessionEngine === 'gemini' && <span className="chip sandbox" title="Gemini 세션은 승인 카드 대신 승인 모드와 샌드박스로 보호됩니다">Gemini · {GEMINI_SANDBOX_LABEL[p.sessionSandbox ?? 'read-only']}</span>}
        </div>
        <div className="chat-head-end">
          {p.headActions}
          {hasMore && (
            <span className="chat-more-wrap">
              <button type="button" className="icon-btn chat-more" aria-label="채팅 메뉴" title={share.done ?? '채팅 메뉴'} aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><circle cx="3.5" cy="8" r="1.35" /><circle cx="8" cy="8" r="1.35" /><circle cx="12.5" cy="8" r="1.35" /></svg>
              </button>
              {share.done && <span className="share-toast" role="status">{share.done}</span>}
              {moreOpen && (
                <MenuList className="session-menu chat-more-menu" label="채팅 메뉴" onClose={() => setMoreOpen(false)}>
                  {sessionItems(() => setMoreOpen(false))}
                  {tm && (shareActions.length > 0 || p.headMenu?.length) ? <div className="menu-sep" role="separator" /> : null}
                  {shareActions.map((a) => <button key={a.key} type="button" role="menuitem" aria-disabled={a.disabled || undefined} onClick={a.disabled ? undefined : a.run}>{a.label}</button>)}
                  {p.headMenu?.map((it) => <button key={it.label} type="button" role="menuitem" onClick={() => { setMoreOpen(false); it.run(); }}>{it.label}</button>)}
                  {tm && (tm.onDelete || tm.deleteBlocked) && <div className="menu-sep" role="separator" />}
                  {deleteItem(() => setMoreOpen(false))}
                </MenuList>
              )}
            </span>
          )}
        </div>
      </div>
      {p.notices?.map((n) => (
        <div key={n.message} className={`pane-notice ${n.level}`} role={n.level === 'error' ? 'alert' : 'status'} data-testid="pane-notice">
          <span className="pane-notice-text">{n.message}</span>
          {p.onDismissNotice && <button type="button" className="pane-notice-close" aria-label="알림 닫기" title="닫기" onClick={() => p.onDismissNotice?.(n.message)}>×</button>}
        </div>
      ))}
      <div className="chat-body" ref={bodyRef}>
        {p.prevSession && <button type="button" className="session-link prev" data-testid="handoff-prev" onClick={p.prevSession.open} title={p.prevSession.title}>← 이전 세션 · {p.prevSession.title}</button>}
        {p.loading && p.items.length === 0 && (
          <div className="chat-loading" role="status" data-testid="chat-loading">
            <span className="sr-only">불러오는 중…</span>
            {[72, 46, 88, 60].map((w, i) => <span key={i} className={`skeleton-line ${i % 2 ? 'mine' : ''}`} style={{ width: `${w}%` }} aria-hidden="true" />)}
          </div>
        )}
        <AgentContext.Provider value={agentCtx}>
          <MessageActionsContext.Provider value={msgActions}>
            {shown.map((it, i) => <MessageView key={i} item={it} cwd={p.cwd} last={i === shown.length - 1} />)}
          </MessageActionsContext.Provider>
        </AgentContext.Provider>
        {retryPrompt !== null && <button type="button" className="btn ghost retry" onClick={() => { p.onSend(retryPrompt); scroll.attach(); }}>재시도</button>}
        {p.pending.map((r) => <PermissionCard key={r.requestId} req={r} onDecide={p.onDecide} />)}
        {p.questions.map((q) => <QuestionCard key={q.requestId} req={q} onAnswer={p.onAnswer} />)}
        {p.nextSession && <button type="button" className="session-link next" data-testid="handoff-next" onClick={p.nextSession.open} title={p.nextSession.title}>→ 새 세션으로 이어감 · {p.nextSession.title}</button>}
      </div>
      {scroll.detached && (
        <div className="jump-anchor">
          <button type="button" className={`jump-bottom ${scroll.unread ? 'unread' : ''}`} onClick={scroll.attach} title="맨 아래로" data-testid="jump-bottom">
            <span aria-hidden="true">↓</span>{scroll.unread ? ' 새 메시지' : <span className="sr-only">맨 아래로</span>}
          </button>
        </div>
      )}
      <div className="composer-wrap">
        {todos && todos.length > 0 && <TodoPanel todos={todos} />}
        {p.queue && p.queue.length > 0 && (
          <QueueChips queue={p.queue} paused={!!p.queuePaused} onEdit={(id, t) => p.onQueueEdit?.(id, t)} onRemove={(id) => p.onQueueRemove?.(id)} onClear={() => p.onQueueClear?.()} onResume={() => p.onQueueResume?.()}{...(p.onQueueSendNow ? { onSendNow: p.onQueueSendNow } : {})} />
        )}
        {(p.busy || p.bg) && (
          <div className="activity-bar">
            {p.busy ? <StatusRow startedAt={p.runStartedAt ?? null} started={!!p.activeTurnId} progress={p.progress ?? null} live={live} onInterrupt={p.activeTurnId ? p.onInterrupt : undefined} /> : <span className="spacer" />}
            {p.bg && <BackgroundPill bg={p.bg} onStopTask={p.onStopTask} onStopAll={() => p.onStopBackground?.(p.bg!.turnId)} />}
          </div>
        )}
        {p.handoffWriting && <div className="handoff-status" role="status" data-testid="handoff-status">인계 메모 작성 중… 끝나면 새 세션이 열리고 메모가 입력창에 들어갑니다</div>}
        {!p.busy && <ContextHint info={ctx} onHandoff={p.onHandoff} />}
        {p.composerNote && <div className="pane-notice notice composer-note" role="status" data-testid="composer-note"><span className="pane-notice-text">{p.composerNote}</span></div>}
        <div className={`composer ${drag && !p.readOnly ? 'dragover' : ''}`}>
          {suggest.popup}
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => { setText(e.target.value); suggest.track(e); }}
            onSelect={suggest.track}
            onKeyDown={onKeyDown}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onPaste={onPaste}
            disabled={!!p.readOnly}
            placeholder={p.readOnly ? p.readOnly : queueing ? (steering ? (coarse ? '실행 중 · 보내면 다음 도구 실행 뒤 전달' : '실행 중 · Enter 로 보내면 다음 도구 실행 뒤 전달 · Esc 중단') : coarse ? '실행 중 · 보내면 대기열에 추가' : '실행 중 · Enter 로 대기열에 추가 · Esc 중단') : coarse ? '메시지 입력 · @ 파일 · / 명령' : (sendKey === 'mod-enter' ? '메시지 입력 · ⌘Enter 로 보내기 · Enter 줄바꿈' : '메시지 입력 · Enter 로 보내기 · Shift+Enter 줄바꿈')}
            aria-label="메시지"
            rows={1}
            // Not a form field: keeps iOS from showing its AutoFill (password/card/address) bar above the keyboard.
            name="deck-message"
            autoComplete="off"
            data-1p-ignore=""
            data-lpignore="true"
            enterKeyHint={coarse ? 'enter' : 'send'}
          />
          {(p.attachments.length > 0 || uploading > 0 || error) && (
            <div className="composer-files"><AttachmentBar attachments={p.attachments} uploading={uploading} error={error} onRemove={p.onUnattach} /></div>
          )}
          {/* One toolbar row, as in Claude: [+] · model pill · 계정/권한 pill (they truncate, never wrap) · mic · send/stop. */}
          <div className="composer-row">
            <AttachMenu onFiles={(f) => void addFiles(f)} />
            <div className="composer-actions">
              {engineSelect && (
                <Pick label={p.engine === 'codex' ? 'GPT' : p.engine === 'gemini' ? 'Gemini' : p.engine === 'auto' ? '자동' : 'Claude'} value={p.engine} onChange={(e) => p.onEngine(e.target.value as EngineChoice)} title="이 세션의 엔진 (세션 생성 후 변경 불가)" aria-label="엔진" data-testid="engine-select">
                  <option value="claude">Claude</option>
                  {p.codexAvailable && <option value="codex">GPT</option>}
                  {p.gemini?.available && <option value="gemini" disabled={!geminiReady} title={geminiReady ? undefined : 'docs/gemini-spike.md 의 로그인 명령을 먼저 실행하세요'}>{geminiReady ? 'Gemini' : 'Gemini · 로그인 필요'}</option>}
                  {p.codexAvailable && <option value="auto">자동</option>}
                </Pick>
              )}
              {engineSelect && effectiveEngine !== 'claude' && (
                <Pick className="sandbox" label={sandboxLabel[p.sandbox]} value={p.sandbox} onChange={(e) => p.onSandbox(e.target.value as CodexSandbox)} title={effectiveEngine === 'gemini' ? 'Gemini 승인 모드 (승인 카드 없음 · 세션 생성 후 변경 불가)' : 'GPT 샌드박스 (승인 없음 · 세션 생성 후 변경 불가)'} aria-label="샌드박스" data-testid="sandbox-select">
                  {CODEX_SANDBOXES.map((s) => <option key={s} value={s}>{sandboxLabel[s]}</option>)}
                </Pick>
              )}
              <ModelPicker models={models} model={p.model} effort={p.effort} onModel={p.onModel} onEffort={p.onEffort} />
              {/* 계정 · 권한: one compact secondary pill next to the model pill (Claude has no such controls; deck keeps them). */}
              {(showAccount || p.onPermMode) && (
                <div className="composer-sec" role="group" aria-label="계정 · 권한">
                  {showAccount && p.onAccountPin && (
                    <AccountPicker pin={p.accountPin ?? null} current={p.isNew ? null : (p.account ?? null)} usage={p.usage ?? null} onPin={p.onAccountPin} />
                  )}
                  {p.onPermMode && (
                    <Pick className={`perm perm-${permSupported ? permMode : 'default'}`} label={<><span className="perm-full">{PERM_MODE_LABEL[permSupported ? permMode : 'default']}</span><span className="perm-short">{PERM_MODE_SHORT[permSupported ? permMode : 'default']}</span></>} value={permSupported ? permMode : 'default'} disabled={!permSupported} onChange={(e) => p.onPermMode?.(e.target.value as PermMode)} title={permSupported ? `${PERM_MODE_HINT[permMode]} (Shift+Tab 으로 전환)` : 'GPT/Gemini 세션은 샌드박스 선택으로 권한을 정합니다'} aria-label="권한 모드" data-testid="perm-select">
                      {PERM_MODES.map((m) => <option key={m} value={m}>{PERM_MODE_LABEL[m]}</option>)}
                    </Pick>
                  )}
                </div>
              )}
            </div>
            {/* Right end, as in Claude: context gauge, mic, then the round send/stop (never shrink); 대기열에 추가 is a round
                secondary button of the same size, just left of stop. */}
            <div className="composer-send">
              <ContextGauge info={ctx} onHandoff={p.onHandoff} />
              <DictationButton text={text} onText={setText} />
              {p.activeTurnId && queueing && hasDraft && (
                <button type="button" className="queue-add" onClick={submit} title={steering ? '대기열에 추가 (Enter) — 실행 중인 턴에 보내 다음 도구 실행 뒤 전달합니다' : '대기열에 추가 (Enter) — 지금 턴이 끝나면 보냅니다'}>
                  <QueueIcon /><span className="sr-only">대기열에 추가</span>
                </button>
              )}
              {p.activeTurnId
                ? <button type="button" className="send stop" onClick={p.onInterrupt} title="중단"><i aria-hidden="true" /><span className="sr-only">중단</span></button>
                : <button type="button" className="send" onClick={submit} disabled={!canSend} title="보내기 (Enter)"><span aria-hidden="true">↑</span><span className="sr-only">보내기</span></button>}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
