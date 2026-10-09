import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react';
import type { ClientMessage } from '../shared/protocol';
import type { SessionEntry } from '../shared/session-types';
import { CommandPalette, type PaletteAction, type PaletteSession } from './components/CommandPalette';
import { DeckMark } from './components/DeckMark';
import { engineOf } from './components/EngineMark';
import { ConfirmDialog, ShortcutHelp } from './components/Dialogs';
import { Login } from './components/Login';
import { NotifyMenu } from './components/NotifyMenu';
import { SettingsView } from './components/SettingsView';
import { postPin, postPinOrder } from './pins';
import { findHitElement } from './scrollToHit';
import { postSessionMeta, restoreSession, searchTranscripts, trashSession, type SearchHit } from './sessionApi';
import { Pane, sendFromPane, useQueueRunner } from './components/Pane';
import { PermissionCard } from './components/PermissionCard';
import { QuestionCard } from './components/QuestionCard';
import { Sidebar, type SidebarView } from './components/Sidebar';
import { UsagePanel } from './components/UsagePanel';
import { UsageView } from './components/UsageView';
import { claimReload, hasDraftText, hasOpenModal, isNewBuild, shouldAutoReload } from './autoReload';
import { hydrate, loadQueues, loadSent, loadUi, saveQueues, saveSent, saveUi, snapshotQueues, snapshotUi } from './persist';
import { findSession } from './push';
import { MAX_PANES, initialState, orphanCards, reducer, sessionsToClose, type Action, type AppState, type UploadedAttachment } from './state';
import { isMacPlatform, isTypingTarget, matchPinShortcut, matchShortcut, type ShortcutId } from './shortcuts';
import { useIsPhone } from './useIsPhone';
import { usePrefs } from './usePrefs';
import { nextTheme, type Theme } from './prefs';
import { createSocket } from './ws';
import { composerOf, focusComposer, routeContext, routeKey } from './composerFocus';
import { tabTitle } from './tabTitle';
import { useIndexRefresh, type IndexRefresh } from './indexRefresh';
import { createCatchup, type Catchup } from './catchup';
import { AccountsContext, uiAccounts } from './accounts';
import { has, setFeatures } from './features';

const VIEW_KEY = 'deck.sidebarView';
const HIDDEN_KEY = 'deck.sidebarHidden';
const UNDO_MS = 10_000;
/** How often a visible page asks /api/build (it also asks whenever it becomes visible). */
const BUILD_CHECK_MS = 5 * 60_000;
const MAC = isMacPlatform();
const THEME_LABEL: Record<Theme, string> = { system: '시스템', light: '라이트', dark: '다크' };

function readLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: not kept */ }
}

/** Every non-archived session once (the copy in the index), newest first — the 최근 order ⌘[ / ⌘] walk. */
function recentSessions(projects: { name: string; sessions: SessionEntry[] }[]): (SessionEntry & { project: string })[] {
  const seen = new Map<string, SessionEntry & { project: string }>();
  for (const p of projects) for (const s of p.sessions) if (!s.archived && !seen.has(s.sessionId)) seen.set(s.sessionId, { ...s, project: p.name });
  return [...seen.values()].sort((a, b) => b.lastModified - a.lastModified);
}
/** Tab title: "● <chat> — deck" while any turn runs; "✓ …" when one finished while the tab was hidden, until it is shown. */
function useTabTitle(running: boolean, chat: string | null) {
  const was = useRef(running);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const finished = was.current && !running;
    was.current = running;
    if (running) setDone(false);
    else if (finished && document.hidden) setDone(true);
  }, [running]);
  useEffect(() => {
    const onVis = () => { if (!document.hidden) setDone(false); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  useEffect(() => { document.title = tabTitle(running ? '●' : done ? '✓' : null, chat); }, [running, done, chat]);
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  // ux-state: panes, pickers, folded sidebar groups and the drawer come back after a reload (persist.ts).
  const saved = useMemo(() => loadUi(), []);
  const [state, dispatch] = useReducer(reducer, saved, (ui) => hydrate(initialState, ui, loadQueues()));
  const [collapsed, setCollapsed] = useState<string[]>(() => saved?.collapsed ?? []);
  const firstBuild = useRef<string | null | undefined>(undefined);
  const [newBuild, setNewBuild] = useState(false);
  const sock = useRef<ReturnType<typeof createSocket> | null>(null);
  const latest = useRef(state);
  latest.current = state;
  /** 고정됨 reorder requests: only the newest one's answer is applied. */
  const pinOrderSeq = useRef(0);
  const phone = useIsPhone();
  const [drawer, setDrawer] = useState(() => saved?.drawer ?? false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [buildId, setBuildId] = useState<string | null>(null);
  const [prefs, setPref] = usePrefs();
  const themeRef = useRef(prefs.theme);
  themeRef.current = prefs.theme;
  // ⌘K palette actions (설정 열기 / 테마 전환) arrive as window events; ⌘, goes through the shortcut table.
  useEffect(() => {
    const open = () => setSettingsOpen(true);
    const cycle = () => setPref({ type: 'set', key: 'theme', value: nextTheme(themeRef.current) });
    window.addEventListener('deck:open-settings', open);
    window.addEventListener('deck:cycle-theme', cycle);
    return () => { window.removeEventListener('deck:open-settings', open); window.removeEventListener('deck:cycle-theme', cycle); };
  }, [setPref]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>(() => (readLocal(VIEW_KEY) === 'projects' ? 'projects' : 'recent'));
  const [sidebarHidden, setSidebarHidden] = useState(() => readLocal(HIDDEN_KEY) === '1');
  useEffect(() => { writeLocal(VIEW_KEY, sidebarView); }, [sidebarView]);
  useEffect(() => { writeLocal(HIDDEN_KEY, sidebarHidden ? '1' : '0'); }, [sidebarHidden]);
  /** The empty pane's preselected project, by pane (the project it showed before ⌘N / a delete). */
  const [newChatCwd, setNewChatCwd] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<{ s: SessionEntry; which?: string } | null>(null);
  const [undo, setUndo] = useState<{ trashId: string; title: string; which?: string } | null>(null);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);
  const onShortcut = useRef<(id: ShortcutId) => void>(() => {});
  /** ⌘1 … ⌘9: set by the sidebar — opens the nth 고정됨 row it shows, as a click on it would; false when there is none. */
  const openPinned = useRef<(index: number, peek?: boolean) => boolean>(() => false);
  const lastSaved = useRef<string | null>(null);
  useEffect(() => { lastSaved.current = saveUi(snapshotUi(state, { collapsed, drawer }), lastSaved.current); }, [state.panes, state.activePaneId, collapsed, drawer]);
  // Queued messages: per tab (sessionStorage), so another tab of this browser never sends them.
  const lastQueues = useRef<string | null>(null);
  useEffect(() => {
    const queued = snapshotQueues(state);
    lastQueues.current = saveQueues(queued, lastQueues.current);
    const n = queued.queues.reduce((k, q) => k + q.queue.length, 0);
    if (lastQueues.current === null && n > 0) dispatch({ type: 'show_error', message: `대기 중인 메시지 ${n}개를 저장하지 못했습니다 — 새로고침하면 사라집니다: ${queued.queues.flatMap((q) => q.queue.map((i) => i.text || '첨부만')).join(' / ')}` });
  }, [state.panes, state.parked]);
  // Sent files per session (thumbnails after a transcript reload): re-saved only when some pane's sent files change.
  const sentSig = state.panes.map((p) => `${p.session?.sessionId ?? ''}:${p.items.filter((it) => it.kind === 'user' && it.attachments?.length).length}`).join('|');
  useEffect(() => { saveSent(latest.current.panes); }, [sentSig]);
  // A 대화 내용 검색 hit being opened: once its pane has loaded the transcript, scroll to the message containing it.
  const [scrollTo, setScrollTo] = useState<{ paneId: string; sessionId: string; snippet: string; match: string; until: number } | null>(null);

  useEffect(() => { void fetch('/api/me').then((r) => setAuthed(r.ok)); }, []);

  /** A build id from the server (a hello, or /api/build) against the first hello's: reload when nothing is at stake (true), else offer the pill. */
  const noticeBuild = (build: string | null, nextState: () => AppState): boolean => {
    // No baseline yet (the first hello came from a server without a build): the first id seen becomes it.
    if (!firstBuild.current) { if (build) firstBuild.current = build; return false; }
    if (!isNewBuild(firstBuild.current, build)) return false;
    const next = nextState();
    if (shouldAutoReload({ draftText: hasDraftText(), modalOpen: hasOpenModal(), state: next }) && claimReload(build!)) {
      // The save effect never runs before the reload: the queues as of now are stored first.
      lastQueues.current = saveQueues(snapshotQueues(next), lastQueues.current);
      location.reload();
      return true;
    }
    setNewBuild(true);
    return false;
  };
  // A UI-only rebuild sends no hello: ask when the page comes back to the front (an installed PWA has no reload button), and every few minutes while it stays there.
  useEffect(() => {
    if (!authed) return;
    let busy = false;
    const check = () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      void fetch('/api/build')
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { build?: unknown } | null) => {
          if (typeof body?.build !== 'string') return;
          noticeBuild(body.build, () => latest.current);
        })
        .catch(() => undefined)
        .finally(() => { busy = false; });
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('pageshow', check);
    const t = setInterval(check, BUILD_CHECK_MS);
    return () => { document.removeEventListener('visibilitychange', check); window.removeEventListener('pageshow', check); clearInterval(t); };
  }, [authed]);

  // The sidebar's times and new outside sessions: a throttled rescan on reconnect, on coming back into view, every 2 min,
  // and after a turn's result unless the server sends its index by itself (it does not while background work keeps the process open).
  const refreshIndex = useRef<IndexRefresh | null>(null);
  /** Keeps each shown session's turn events in order and asks for what a reconnect or a stalled socket missed (catchup.ts). */
  const catchup = useRef<Catchup | null>(null);
  refreshIndex.current = useIndexRefresh(!!authed, () => sock.current?.send({ type: 'refresh_index' }));
  useEffect(() => {
    if (!authed) return;
    const tracker = createCatchup({
      send: (m) => !!sock.current?.send(m),
      enabled: () => has('catchup'),
      shown: () => latest.current.panes.map((p) => p.session?.sessionId).filter((x): x is string => !!x),
      stalled: () => sock.current?.reconnect(),
    });
    catchup.current = tracker;
    sock.current = createSocket((msg) => {
      if (msg.type === 'hello') setFeatures(msg.features);
      // A repeat of an event already applied, one ahead of a gap (what is missing was just asked for), or a retry's same failure: not applied.
      if (!tracker.accept(msg)) return;
      dispatch(msg.type === 'history' ? { type: 'server', msg, sentFiles: loadSent(msg.sessionId) } : { type: 'server', msg });
      if (msg.type === 'turn_result') refreshIndex.current?.afterTurn();
      if (msg.type === 'index') refreshIndex.current?.indexSeen();
      // Reconnected: re-open every pane's session (once each) so this socket receives their turn events again (review I3, D6).
      if (msg.type === 'hello') {
        // A restarted server with a new UI build: reload when nothing is at stake, else offer the pill.
        const build = msg.build ?? null;
        setBuildId(build);
        if (noticeBuild(build, () => reducer(latest.current, { type: 'server', msg }))) return;
        refreshIndex.current?.request();
        // A 'catchup' server is asked only for what came after this device's last event (it sends the whole history if it cannot tell).
        tracker.hello();
        for (const p of latest.current.panes) {
          if (p.activeTurnId && msg.running.some((r) => r.turnId === p.activeTurnId)) sock.current?.send({ type: 'watch_turn', turnId: p.activeTurnId });
        }
      }
    }, (value) => { if (!value) tracker.cancel(); dispatch({ type: 'connected', value }); }, () => setAuthed(false));
    const onVis = () => { if (!document.hidden) tracker.visible(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); tracker.cancel(); catchup.current = null; sock.current?.close(); };
  }, [authed]);

  // Only once this socket's hello is in: a send between onopen and hello would be requeued by that hello.
  useQueueRunner(state.panes, state.ready, dispatch, (m) => sock.current?.send(m), state.defaultPermMode);
  useTabTitle(state.activity.some((a) => a.running) || state.panes.some((p) => p.activeTurnId !== null), state.panes.find((p) => p.id === state.activePaneId)?.session?.title ?? null);
  // Composer focus after opening a chat / 새 채팅 / a pane switch: run after the commit so the pane's textarea exists.
  // No pane id: whichever pane is active then (a new split's id is only known after the reducer).
  const [focusReq, setFocusReq] = useState<{ paneId: string | null; n: number } | null>(null);
  const requestFocus = (paneId: string | null = null) => setFocusReq((r) => ({ paneId, n: (r?.n ?? 0) + 1 }));
  useEffect(() => { if (focusReq) focusComposer(focusReq.paneId ?? latest.current.activePaneId); }, [focusReq]);
  useEffect(() => { if (authed) requestFocus(); }, [authed]);
  // A file dropped outside the chat pane (sidebar, top bar) must never make the browser navigate to it.
  useEffect(() => {
    // The chat pane handles its own (preventDefault first), so only the rest gets the "no drop here" cursor.
    const guard = (e: DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => { window.removeEventListener('dragover', guard); window.removeEventListener('drop', guard); };
  }, []);
  // PWA: a notification click opens deck at /?session=<id> or, with deck already open, posts the id here.
  const [openReq, setOpenReq] = useState<string | null>(() => new URLSearchParams(window.location.search).get('session'));
  const openById = useRef<(sessionId: string) => boolean>(() => false);
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const onMsg = (e: MessageEvent) => { const d = e.data as { type?: unknown; sessionId?: unknown } | null; if (d?.type === 'deck-open-session' && typeof d.sessionId === 'string') setOpenReq(d.sessionId); };
    sw.addEventListener('message', onMsg);
    return () => sw.removeEventListener('message', onMsg);
  }, []);
  useEffect(() => {
    if (!openReq || !state.connected) return;
    if (openById.current(openReq) || state.projects.length > 0) {
      setOpenReq(null);
      if (window.location.search) window.history.replaceState(null, '', '/');
    }
  }, [openReq, state.connected, state.projects]);

  useEffect(() => {
    if (!phone || !drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phone, drawer]);

  // Global shortcuts (⌘ on Mac, Ctrl elsewhere). While a dialog is open only ⌘K (toggle) and ⌘/ get through.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // ⌘1 … ⌘9: the nth 고정됨 row, also from the composer. The key is only taken when that row exists; a held key's
      // repeats are taken too (not reopened), or the browser would switch tabs on them.
      const pin = matchPinShortcut(e, MAC);
      if (pin !== null) {
        if (!hasOpenModal() && openPinned.current(pin, e.repeat)) e.preventDefault();
        return;
      }
      const id = matchShortcut(e, { mac: MAC, typing: isTypingTarget(e.target) });
      if (!id) {
        // Type-to-compose: the key lands in the focused pane's composer (focus moves before the key's default action).
        // An IME key only moves focus (and is swallowed) so the composition never garbles.
        const how = routeKey(e, routeContext(e.target));
        const ta = how ? composerOf(latest.current.activePaneId) : null;
        if (!ta) return;
        // Already in the composer (a key event retargeted elsewhere, as iPadOS does mid-IME): leave the key and the caret alone.
        if (document.activeElement !== ta) {
          if (how === 'focus') e.preventDefault();
          ta.focus({ preventScroll: true });
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
        return;
      }
      if (hasOpenModal() && id !== 'palette' && id !== 'help' && id !== 'settings') return;
      e.preventDefault();
      onShortcut.current(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const cancelDelete = useCallback(() => setConfirmDelete(null), []);

  useEffect(() => {
    if (!scrollTo) return;
    if (Date.now() > scrollTo.until) { setScrollTo(null); return; }
    const pane = state.panes.find((p) => p.id === scrollTo.paneId);
    if (pane?.session?.sessionId !== scrollTo.sessionId) { setScrollTo(null); return; }
    const root = document.querySelector(`[data-testid="pane-${scrollTo.paneId}"]`);
    // After the pane's own scroll-to-bottom (it runs in the same commit), hence the frame delay.
    const id = requestAnimationFrame(() => {
      const el = root && findHitElement(root, scrollTo.snippet, scrollTo.match);
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('search-flash');
      setTimeout(() => el.classList.remove('search-flash'), 2000);
      setScrollTo(null);
    });
    return () => cancelAnimationFrame(id);
  }, [scrollTo, state.panes]);

  const accounts = useMemo(() => uiAccounts(state.accounts), [state.accounts]);
  if (authed === null) return <div className="center">확인 중…</div>;
  if (!authed) return <Login onLoggedIn={() => setAuthed(true)} />;

  const send = (m: ClientMessage) => sock.current?.send(m) ?? false;
  /**
   * Pane-changing actions (open / close): the server's per-socket view set must shrink too, so every session
   * no pane views after the action gets a close_session (T9 prerequisite b; duplicate-session panes keep it).
   */
  const apply = (action: Action) => {
    const prev = latest.current;
    const next = reducer(prev, action);
    latest.current = next;
    dispatch(action);
    for (const sessionId of sessionsToClose(prev, next)) { catchup.current?.forget(sessionId); send({ type: 'close_session', sessionId }); }
  };
  const active = state.panes.find((p) => p.id === state.activePaneId) ?? state.panes[0]!;
  const openIn = (paneId: string, sessionId: string | null, cwd: string, title: string) => {
    apply({ type: 'open', sessionId, cwd, title, paneId });
    if (sessionId) { catchup.current?.forget(sessionId); send({ type: 'open_session', sessionId }); }
    setDrawer(false);
    requestFocus(paneId);
  };
  openById.current = (sessionId) => {
    const pane = state.panes.find((p) => p.session?.sessionId === sessionId);
    if (pane) { dispatch({ type: 'focus_pane', paneId: pane.id }); requestFocus(pane.id); return true; }
    const hit = findSession(state.projects, state.desktop, sessionId);
    if (!hit) return false;
    openIn(active.id, sessionId, hit.cwd, hit.title);
    return true;
  };
  const showError = (fallback: string) => (err: unknown) => dispatch({ type: 'show_error', message: err instanceof Error ? err.message : fallback });
  const recent = recentSessions(state.projects);
  /** ⌘N / 새 대화: the focused pane goes back to the new-chat screen, its project preselected. */
  const newChat = (paneId = active.id) => {
    const pane = state.panes.find((p) => p.id === paneId);
    const cwd = pane?.session?.cwd;
    if (cwd) setNewChatCwd((m) => ({ ...m, [paneId]: cwd }));
    if (pane?.session) apply({ type: 'clear_pane', paneId });
    dispatch({ type: 'focus_pane', paneId });
    setDrawer(false);
    requestFocus(paneId);
  };
  const startChat = (paneId: string, cwd: string, name: string, text: string, attachments: UploadedAttachment[] = []) => {
    openIn(paneId, null, cwd, `${name} · 새 세션`);
    const pane = latest.current.panes.find((p) => p.id === paneId);
    // Same first-turn defaults as the composer of a new session: pane model/engine/sandbox, 새 세션 기본 권한.
    if (text && pane) sendFromPane(pane, text, attachments, dispatch, send, latest.current.defaultPermMode);
  };
  const openHit = (h: SearchHit) => {
    if (active.session?.sessionId !== h.sessionId) openIn(active.id, h.sessionId, h.cwd, h.title);
    else setDrawer(false);
    setScrollTo({ paneId: active.id, sessionId: h.sessionId, snippet: h.snippet, match: h.snippet.slice(h.matchStart, h.matchStart + h.matchLength), until: Date.now() + 15_000 });
  };
  const stepSession = (dir: -1 | 1) => {
    if (!recent.length) return;
    const i = recent.findIndex((s) => s.sessionId === active.session?.sessionId);
    const next = recent[i < 0 ? 0 : Math.min(Math.max(i + dir, 0), recent.length - 1)]!;
    if (next.sessionId !== active.session?.sessionId) openIn(active.id, next.sessionId, next.cwd, next.title);
  };
  const toggleSidebar = () => { if (phone) setDrawer((d) => !d); else setSidebarHidden((h) => !h); };
  const addPane = () => { if (!phone) { dispatch({ type: 'add_pane' }); requestFocus(); } };
  onShortcut.current = (id) => {
    if (id === 'palette') { setHelpOpen(false); setPaletteOpen((o) => !o); }
    else if (id === 'help') { setPaletteOpen(false); setHelpOpen((o) => !o); }
    else if (id === 'new-chat') newChat();
    else if (id === 'new-pane') addPane();
    else if (id === 'prev-session') stepSession(-1);
    else if (id === 'next-session') stepSession(1);
    else if (id === 'toggle-sidebar') toggleSidebar();
    else if (id === 'settings') { setPaletteOpen(false); setHelpOpen(false); setSettingsOpen((o) => !o); }
  };
  const mod = MAC ? '⌘' : 'Ctrl+';
  const actions: PaletteAction[] = [
    { id: 'new-chat', label: '새 대화', hint: `${mod}N`, run: () => newChat() },
    ...(!phone && state.panes.length < MAX_PANES ? [{ id: 'new-pane', label: '새 분할', hint: `${mod}⇧O`, run: addPane }] : []),
    { id: 'settings', label: '설정 열기', hint: `${mod},`, run: () => window.dispatchEvent(new CustomEvent('deck:open-settings')) },
    { id: 'usage', label: '사용량 보기', run: () => setUsageOpen(true) },
    { id: 'theme', label: '테마 전환', run: () => window.dispatchEvent(new CustomEvent('deck:cycle-theme')) },
    { id: 'sidebar', label: phone ? '사이드바 열기' : sidebarHidden ? '사이드바 보이기' : '사이드바 숨기기', hint: `${mod}\\`, run: toggleSidebar },
    { id: 'help', label: '단축키 보기', hint: `${mod}/`, run: () => setHelpOpen(true) },
  ];
  const paletteSessions: PaletteSession[] = [
    ...recent.map((s) => ({ sessionId: s.sessionId, title: s.title, cwd: s.cwd, project: s.project, lastModified: s.lastModified, engine: engineOf(s) })),
    ...state.desktop.filter((d) => !d.archived && !recent.some((s) => s.sessionId === d.sessionId)).map((d) => ({ sessionId: d.sessionId, title: d.title, cwd: d.cwd, project: `${d.project} · Desktop`, lastModified: d.lastModified })),
  ].sort((a, b) => b.lastModified - a.lastModified);
  /** 삭제, step 1: refuse what is running here; otherwise ask. */
  const askDelete = (s: SessionEntry, which?: string) => {
    const busy = state.panes.some((p) => p.session?.sessionId === s.sessionId && (p.activeTurnId !== null || p.awaitingStart)) || state.activity.some((a) => a.sessionId === s.sessionId && (a.running || a.bg > 0));
    if (busy) { dispatch({ type: 'show_error', message: '실행 중인 대화는 삭제할 수 없어요 — 끝난 뒤 다시 시도하세요' }); return; }
    setConfirmDelete(which ? { s, which } : { s });
  };
  const doDelete = (s: SessionEntry, which?: string) => {
    setConfirmDelete(null);
    trashSession(s.sessionId).then(({ trashId }) => {
      for (const p of latest.current.panes) if (p.session?.sessionId === s.sessionId) { setNewChatCwd((m) => ({ ...m, [p.id]: s.cwd })); apply({ type: 'clear_pane', paneId: p.id }); }
      setUndo({ trashId, title: s.title, ...(which ? { which } : {}) });
    }, showError('삭제 실패'));
  };
  // The sidebar ⋯ menu and the chat title ⌄ menu share these.
  const togglePin = (sessionId: string, pinned: boolean) => { postPin(sessionId, pinned).then((pins) => dispatch({ type: 'set_pins', pins }), showError('고정 실패')); };
  const renameSession = (sessionId: string, title: string | null) => { postSessionMeta(sessionId, { title }).catch(showError('이름 바꾸기 실패')); };
  const archiveSession = (sessionId: string, archived: boolean) => { postSessionMeta(sessionId, { archived }).catch(showError('보관 실패')); };
  const sessionActions = { pins: state.pins, onRename: renameSession, onTogglePin: togglePin, onArchive: archiveSession, onDelete: (s: SessionEntry) => askDelete(s) };
  const footAccount = active.session?.account ?? null;
  const orphanPerms = orphanCards(state.panes, state.pending);
  const orphanQs = orphanCards(state.panes, state.questions);

  return (
    <AccountsContext value={accounts}>
    <div className="app">
      <header className="topbar">
        {phone && <button type="button" className="menu" aria-label="메뉴" aria-expanded={drawer} onClick={() => setDrawer((d) => !d)}>☰</button>}
        {/* Tablet / unfolded (721–1100px, CSS only shows it there): a visible way to fold the sidebar away without ⌘\. */}
        {!phone && <button type="button" className="icon-btn sidebar-toggle" aria-label={sidebarHidden ? '사이드바 보이기' : '사이드바 숨기기'} title={sidebarHidden ? '사이드바 보이기' : '사이드바 숨기기'} aria-pressed={!sidebarHidden} onClick={toggleSidebar}>☰</button>}
        <span className="brand"><DeckMark className="spark" />deck</span>
        <button type="button" className="text-btn palette-open" onClick={() => setPaletteOpen(true)} title={`세션 검색 · 명령 (${mod}K)`} aria-label="세션 검색 · 명령">
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="7" cy="7" r="4.75" /><path d="m10.5 10.5 3.25 3.25" /></svg>
          {!phone && <><span>검색</span><kbd>{mod}K</kbd></>}
        </button>
        <UsagePanel usage={state.usage} current={active.session?.account ?? null} onOpenHistory={() => setUsageOpen(true)} />
        <div className="topbar-end">
          <button type="button" className="text-btn uv-open" onClick={() => setUsageOpen(true)} title="토큰 사용량 기록 (주별·일별)">사용량</button>
          {!phone && <button type="button" className="text-btn split" onClick={addPane} disabled={state.panes.length >= MAX_PANES} title={`분할보기 (최대 ${MAX_PANES})`}>+ 분할</button>}
          <NotifyMenu />
          <span className={`conn ${state.connected ? 'on' : 'off'}`} title={state.connected ? '연결됨' : '재연결 중…'}>{state.connected ? '연결됨' : '재연결 중…'}</span>
        </div>
      </header>
      {usageOpen && <UsageView onClose={() => setUsageOpen(false)} />}
      {settingsOpen && <SettingsView build={buildId} defaultPermMode={state.defaultPermMode} onDefaultPermMode={(defaultPermissionMode) => send({ type: 'set_settings', defaultPermissionMode })} routingPolicy={state.routingPolicy} onRoutingPolicy={(routingPolicy) => send({ type: 'set_settings', routingPolicy })} onOpenUsage={() => setUsageOpen(true)} onClose={() => setSettingsOpen(false)} />}
      {paletteOpen && <CommandPalette sessions={paletteSessions} actions={actions} onClose={closePalette} onOpenSession={(s) => openById.current(s.sessionId) || openIn(active.id, s.sessionId, s.cwd, s.title)} onOpenHit={openHit} searchFn={searchTranscripts} />}
      {helpOpen && <ShortcutHelp mac={MAC} onClose={closeHelp} />}
      {confirmDelete && (
        <ConfirmDialog title="대화 삭제" danger confirmLabel="삭제" onCancel={cancelDelete} onConfirm={() => doDelete(confirmDelete.s, confirmDelete.which)}
          message={`“${confirmDelete.s.title}”${confirmDelete.which ? ` (${confirmDelete.which})` : ''} 을(를) 목록에서 지울까요? 파일은 휴지통(session-trash)으로 옮겨지고 바로 되돌릴 수 있어요.`} />
      )}
      {undo && (
        <div className="toast" role="status">
          <span>“{undo.title.length > 40 ? `${undo.title.slice(0, 40)}…` : undo.title}”{undo.which ? ` (${undo.which})` : ''} 삭제됨</span>
          <button type="button" className="text-btn" onClick={() => { const { trashId } = undo; setUndo(null); restoreSession(trashId).catch(showError('되돌리기 실패')); }}>되돌리기</button>
          <button type="button" className="icon-btn" aria-label="닫기" onClick={() => setUndo(null)}>✕</button>
        </div>
      )}
      {newBuild && <button type="button" className="update-pill" onClick={() => location.reload()}>새 버전이 있어요 · 새로고침</button>}
      {state.error && <div className="banner error" onClick={() => dispatch({ type: 'dismiss_error' })}>{state.error} (클릭해서 닫기)</div>}
      {(orphanPerms.length > 0 || orphanQs.length > 0) && (
        <div className="global-cards">
          {orphanPerms.map((p) => <PermissionCard key={p.requestId} req={p} onDecide={(requestId, decision) => send({ type: 'permission_response', requestId, decision })} />)}
          {orphanQs.map((q) => <QuestionCard key={q.requestId} req={q} onAnswer={(requestId, answers) => send({ type: 'question_response', requestId, answers })} />)}
        </div>
      )}
      <div className="body">
        {phone && drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} />}
        <div className={`sidebar-wrap ${phone ? 'drawer' : ''} ${drawer ? 'open' : ''} ${!phone && sidebarHidden ? 'hidden' : ''}`}>
          <Sidebar
            projects={state.projects}
            currentSessionId={active.session?.sessionId ?? null}
            onOpen={(sessionId, cwd, title) => openIn(active.id, sessionId, cwd, title)}
            onNew={(cwd, name) => openIn(active.id, null, cwd, `${name} · 새 세션`)}
            onRefresh={() => send({ type: 'refresh_index' })}
            pins={state.pins}
            pinShortcut={openPinned}
            desktop={state.desktop}
            onTogglePin={togglePin}
            onReorderPins={(order) => {
              // Optimistic: the new order shows at once. Only the latest move's answer counts — an older one arriving
              // late must not undo a newer move (the index broadcast settles those). A failed save puts the old order
              // back, keeping pins added meanwhile (on top, like a new pin).
              const seq = ++pinOrderSeq.current;
              const before = latest.current.pins;
              dispatch({ type: 'set_pins', pins: order });
              postPinOrder(order).then(
                (pins) => { if (seq === pinOrderSeq.current) dispatch({ type: 'set_pins', pins }); },
                (err: unknown) => {
                  if (seq !== pinOrderSeq.current) return;
                  const now = latest.current.pins;
                  const kept = new Set(before);
                  const has = new Set(now);
                  dispatch({ type: 'set_pins', pins: [...now.filter((id) => !kept.has(id)), ...before.filter((id) => has.has(id))] });
                  dispatch({ type: 'show_error', message: err instanceof Error ? err.message : '고정 순서 변경 실패' });
                },
              );
            }}
            collapsed={collapsed}
            onCollapsedChange={setCollapsed}
            onRename={renameSession}
            onArchive={archiveSession}
            onOpenHit={openHit}
            view={sidebarView}
            onViewChange={setSidebarView}
            onDelete={askDelete}
            activity={state.activity}
            unread={state.unread}
            waiting={[...state.pending, ...state.questions].map((c) => c.sessionId).filter((id): id is string => !!id)}
            onOpenSettings={() => setSettingsOpen(true)}
            avatar={footAccount ? ([...accounts.label(footAccount)][0] ?? '').toUpperCase() : 'D'}
            avatarTitle={footAccount ? `deck · ${footAccount === 'gpt' ? 'GPT' : `계정 ${accounts.label(footAccount)}`}` : 'deck'}
            footMenu={[
              { label: '설정', hint: `${mod},`, run: () => setSettingsOpen(true) },
              { label: '사용량 기록', run: () => setUsageOpen(true) },
              { label: `테마: ${THEME_LABEL[prefs.theme]}`, run: () => window.dispatchEvent(new CustomEvent('deck:cycle-theme')) },
              { label: '단축키', hint: `${mod}/`, run: () => setHelpOpen(true) },
              { label: '새로고침', run: () => location.reload() },
            ]}
            onOpenFolder={(cwd) => openIn(active.id, null, cwd, `${cwd.split('/').filter(Boolean).pop() ?? cwd} · 새 세션`)}
            onNewChat={() => newChat()}
          />
        </div>
        <div className="panes" data-count={phone ? 1 : state.panes.length} style={{ '--cols': phone ? 1 : state.panes.length } as CSSProperties}>
          {phone && state.panes.length > 1 && (
            <div className="pane-switch">
              {state.panes.map((p, i) => <button type="button" key={p.id} className={p.id === active.id ? 'on' : ''} onClick={() => { dispatch({ type: 'focus_pane', paneId: p.id }); requestFocus(p.id); }}>{i + 1}{p.session ? ` · ${p.session.title.slice(0, 12)}` : ''}</button>)}
            </div>
          )}
          {(phone ? [active] : state.panes).map((p) => (
            <Pane key={p.id} pane={p} app={state} active={p.id === state.activePaneId} closable={state.panes.length > 1} dispatch={dispatch} send={send} onClose={() => { apply({ type: 'close_pane', paneId: p.id }); requestFocus(); }} onOpenSession={(sessionId, cwd, title) => openIn(p.id, sessionId, cwd, title)}
              onStartChat={(cwd, name, text, attachments) => startChat(p.id, cwd, name, text, attachments)} newChatCwd={newChatCwd[p.id] ?? null} sessionActions={sessionActions} />
          ))}
        </div>
      </div>
    </div>
    </AccountsContext>
  );
}
