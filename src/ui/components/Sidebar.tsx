import { useEffect, useState } from 'react';
import type { SessionActivity } from '../../shared/protocol';
import type { DesktopSession, ProjectEntry, SessionEntry } from '../../shared/session-types';
import { groupByDate } from '../dateGroups';
import { groupBranches, linksOf, type BranchGroup } from '../../shared/branches';
import { searchTranscripts, type SearchHit } from '../sessionApi';
import { FolderPicker } from './FolderPicker';
import { EngineMark, engineOf } from './EngineMark';
import { usePinReorder } from '../pinOrder';
import { BlockedDeleteItem, MenuList, deleteBlockedReason } from './SessionMenu';
import { isMacPlatform, isPlainMod, pinKeyLabel } from '../shortcuts';
import { hasOpenModal } from '../autoReload';

/** Sessions shown per project before "더 보기". */
export const FOLD_AT = 5;
const MAX_SESSIONS = 30;
/** 대화 내용 검색 starts at this many characters (the server's minimum), after a short pause in typing. */
export const SEARCH_MIN_CHARS = 2;
const SEARCH_DEBOUNCE_MS = 300;
/** 최근 view: newest sessions across all projects, split by day. */
const MAX_RECENT = 150;
/** How often the rows' "N분 전" is recomputed. */
export const META_TICK_MS = 60_000;

export type SidebarView = 'recent' | 'projects';
/** One entry of the avatar (설정 및 계정) menu at the bottom left. */
export type SidebarMenuItem = { label: string; hint?: string; run: () => void };

function ago(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < 60_000) return '방금';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}분 전`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}시간 전`;
  return `${Math.floor(d / 86_400_000)}일 전`;
}

export function Sidebar({ projects, currentSessionId, onOpen, onNew, onRefresh, onOpenFolder, fetchFn, pins = [], pinShortcut, onTogglePin, onReorderPins, desktop = [], collapsed: collapsedProp, onCollapsedChange, onRename, onArchive, onOpenHit, searchFn, activity = [], unread = [], waiting = [], onOpenSettings, view: viewProp, onViewChange, onDelete, onNewChat, footMenu, avatar, avatarTitle }: {
  /** 설정 (avatar menu at the bottom left; ⌘, also opens it — 새 세션 기본 권한 lives there). Used when footMenu is absent. */
  onOpenSettings?: () => void;
  /** The avatar menu's items (설정 / 사용량 / 테마 / 단축키…); absent = just 설정. */
  footMenu?: SidebarMenuItem[];
  /** The avatar's letter (the current account) and the menu's first line. */
  avatar?: string;
  avatarTitle?: string;
  projects: ProjectEntry[];
  currentSessionId: string | null;
  onOpen: (sessionId: string, cwd: string, title: string) => void;
  onNew: (cwd: string, name: string) => void;
  onRefresh: () => void;
  /** F1: a folder chosen in 폴더 열기 (real path, server-validated) → new session there. */
  onOpenFolder?: (cwd: string) => void;
  fetchFn?: typeof fetch;
  /** F2: pinned session ids in display order (top first), shown as 고정됨 above the projects. */
  pins?: string[];
  /**
   * ⌘1 … ⌘9: the sidebar puts its opener here — (index) opens the nth 고정됨 row as shown (same list, same onOpen as a
   * click) and says whether there was one. With it, those rows show their number while ⌘/Ctrl is held.
   */
  pinShortcut?: { current: (index: number, peek?: boolean) => boolean };
  onTogglePin?: (sessionId: string, pinned: boolean) => void;
  /** 고정됨 drag order: the full pin list, top first. Absent = the pinned rows do not reorder. */
  onReorderPins?: (order: string[]) => void;
  /** Recent Claude Desktop sessions (newest first); opened like any session. */
  desktop?: DesktopSession[];
  /** ux-state: folded project groups (cwd), owned by the app so they survive a reload; absent = local state. */
  collapsed?: string[];
  onCollapsedChange?: (cwds: string[]) => void;
  /** Custom title (null = back to the transcript's own title); stored by deck, the jsonl is untouched. */
  onRename?: (sessionId: string, title: string | null) => void;
  /** 보관 / 보관 해제: archived sessions only show under the 보관됨 filter. */
  onArchive?: (sessionId: string, archived: boolean) => void;
  /** Enables 대화 내용 검색 (full-text over all transcripts); a clicked hit lands here. */
  onOpenHit?: (hit: SearchHit) => void;
  searchFn?: (q: string) => Promise<{ hits: SearchHit[]; truncated: boolean }>;
  /** Sessions with a running turn or background work (any device): spinner / pulsing dot before the title. */
  activity?: SessionActivity[];
  /** Sessions that finished while not shown: unread dot until opened. */
  unread?: string[];
  /** Sessions with a permission card or question waiting for the user: 승인 대기 in place of the row's time. */
  waiting?: string[];
  /** 최근 (one list, date groups) or 프로젝트 (grouped by project); owned by the app when given. Default 프로젝트. */
  view?: SidebarView;
  onViewChange?: (view: SidebarView) => void;
  /** 삭제 (Claude sessions): the app confirms, moves it to the trash and offers undo. `which` names the branch of a 갈래 row. */
  onDelete?: (s: SessionEntry, which?: string) => void;
  /** 새 세션 (the floating pill bottom right, as in Claude): same as ⌘N — a new chat in the current pane's folder. */
  onNewChat?: () => void;
}) {
  const [localView, setLocalView] = useState<SidebarView>(viewProp ?? 'projects');
  const view = viewProp ?? localView;
  const setView = (v: SidebarView) => { if (onViewChange) onViewChange(v); else setLocalView(v); };
  const [picking, setPicking] = useState(false);
  // "N분 전" moves on by itself: the rows re-render every minute even when no index arrives.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), META_TICK_MS); return () => clearInterval(t); }, []);
  const [footOpen, setFootOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [localCollapsed, setLocalCollapsed] = useState<Set<string>>(() => new Set(collapsedProp ?? []));
  const collapsed = collapsedProp ? new Set(collapsedProp) : localCollapsed;
  const setCollapsed = (fn: (c: Set<string>) => Set<string>) => {
    const n = fn(collapsed);
    if (onCollapsedChange) onCollapsedChange([...n]);
    else setLocalCollapsed(n);
  };
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  // ⌘/Ctrl held (alone, no dialog open): the 고정됨 rows show ⌘1 … ⌘9. Cleared on blur / hide, where the keyup never arrives.
  const [modHeld, setModHeld] = useState(false);
  const pinKeys = !!pinShortcut;
  useEffect(() => {
    if (!pinKeys) return;
    const mac = isMacPlatform();
    const onKey = (e: KeyboardEvent) => setModHeld(isPlainMod(e, mac) && !hasOpenModal());
    const clear = () => setModHeld(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); window.removeEventListener('blur', clear); document.removeEventListener('visibilitychange', clear); };
  }, [pinKeys]);
  // Keyed `${group}:${sessionId}`: a pinned session is listed twice and only the clicked copy opens its menu / editor.
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [found, setFound] = useState<{ q: string; hits: SearchHit[]; truncated: boolean; error: string | null } | null>(null);
  const toggle = (set: Set<string>, key: string) => { const n = new Set(set); if (n.has(key)) n.delete(key); else n.add(key); return n; };

  const q = query.trim().toLowerCase();
  const match = (s: SessionEntry) => !q || s.title.toLowerCase().includes(q);
  const inView = (s: { archived?: boolean }) => (showArchived ? !!s.archived : !s.archived);
  const canEdit = !!(onRename || onArchive || onDelete);

  // 대화 내용 검색: debounced; a stale answer (query changed meanwhile) is dropped.
  const fullQ = query.trim();
  const fullOn = !!onOpenHit && fullQ.length >= SEARCH_MIN_CHARS;
  useEffect(() => {
    if (!fullOn) { setFound(null); return; }
    let live = true;
    const run = searchFn ?? ((x: string) => searchTranscripts(x, fetchFn));
    const t = setTimeout(() => {
      run(fullQ).then(
        (r) => { if (live) setFound({ q: fullQ, hits: r.hits, truncated: r.truncated, error: null }); },
        (err: unknown) => { if (live) setFound({ q: fullQ, hits: [], truncated: false, error: err instanceof Error ? err.message : '검색 실패' }); },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(t); };
  }, [fullOn, fullQ, searchFn, fetchFn]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => { if (!(e.target instanceof Element && e.target.closest('.session-menu'))) setMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey); };
  }, [menu]);

  const startEdit = (s: SessionEntry, key: string) => { if (!onRename) return; setMenu(null); setEditing({ id: key, text: s.title }); };
  const commitEdit = (s: SessionEntry, key: string) => {
    if (!editing || editing.id !== key) return;
    const v = editing.text.replace(/\s+/g, ' ').trim();
    setEditing(null);
    if (v !== s.title) onRename?.(s.sessionId, v || null);
  };
  const pinSet = new Set(pins);
  const byId = new Map<string, SessionEntry>();
  for (const p of projects) for (const s of p.sessions) byId.set(s.sessionId, s);
  const desktopById = new Map(desktop.map((d) => [d.sessionId, d]));
  const dMatch = (d: DesktopSession) => !q || d.title.toLowerCase().includes(q) || d.project.toLowerCase().includes(q);
  // 고정됨 holds deck sessions and Desktop-only ones alike; each session is listed once — pinned rows leave the lists below.
  type PinnedItem = { kind: 'session'; s: SessionEntry } | { kind: 'desktop'; d: DesktopSession };
  const pinned = pins.flatMap((id): PinnedItem[] => {
    const s = byId.get(id);
    if (s) return inView(s) && match(s) ? [{ kind: 'session', s }] : [];
    const d = desktopById.get(id);
    return d && inView(d) && dMatch(d) ? [{ kind: 'desktop', d }] : [];
  });
  // 고정됨 rows reorder by drag (touch: long-press) or Alt+↑/↓; hidden pins (filtered out) keep their place.
  const reorderKeys = (group: string) => (group === 'pinned' && onReorderPins ? 'Alt+ArrowUp Alt+ArrowDown' : undefined);
  const pinDrag = usePinReorder(pinned.map((it) => (it.kind === 'session' ? it.s.sessionId : it.d.sessionId)), pins, onReorderPins);
  // ⌘1 … ⌘9 reads the very list the 고정됨 section renders (filters included), so a number is always the row showing it.
  if (pinShortcut) {
    pinShortcut.current = (index, peek) => {
      const it = pinned[index];
      if (!it) return false;
      if (peek) return true;
      const t = it.kind === 'session' ? it.s : it.d;
      onOpen(t.sessionId, t.cwd, t.title);
      return true;
    };
  }
  // Gone with the sidebar (signed out): the key listener outlives it and must not open into a hidden pane.
  useEffect(() => () => { if (pinShortcut) pinShortcut.current = () => false; }, [pinShortcut]);
  const pinKey = (index: number) => (modHeld ? pinKeyLabel(index, isMacPlatform()) : null);
  // A Desktop session whose folder deck already lists shows there; the Desktop list only carries the rest.
  const desktopShown = desktop.filter((d) => !byId.has(d.sessionId) && !pinSet.has(d.sessionId) && inView(d) && dMatch(d));

  const actById = new Map(activity.map((a) => [a.sessionId, a]));
  const unreadSet = new Set(unread);
  const dot = (sessionId: string) => {
    const a = actById.get(sessionId);
    if (a?.running) return <span className="row-dot running" role="img" aria-label="실행 중" title="실행 중" />;
    if (a && a.bg > 0) return <span className="row-dot bg" role="img" aria-label={`백그라운드 작업 ${a.bg}개`} title={`백그라운드 작업 ${a.bg}개`} />;
    if (unreadSet.has(sessionId)) return <span className="row-dot unread" role="img" aria-label="새 응답" title="새 응답" />;
    return null;
  };
  const waitingSet = new Set(waiting);
  /** What the row says in place of its time, same order as the dot (승인 대기 first: it needs the user). A 갈래 row: any member. */
  const status = (ids: string[]): string | null => {
    if (ids.some((id) => waitingSet.has(id))) return '승인 대기';
    const acts = ids.map((id) => actById.get(id)).filter((a): a is SessionActivity => !!a);
    if (acts.some((a) => a.running)) return '실행 중';
    const bg = acts.reduce((n, a) => n + a.bg, 0);
    if (bg > 0) return `백그라운드 ${bg}개`;
    if (ids.some((id) => unreadSet.has(id))) return '새 응답';
    return null;
  };

  /** `tree`: a 메시지 편집 갈래 tree shown as this one row — a click opens its newest session. `project`: the 최근 view's meta label. */
  const row = (s: SessionEntry, group: string, tree?: BranchGroup<SessionEntry>, project?: string, keyHint?: string | null) => {
    const on = pinSet.has(s.sessionId);
    const key = `${group}:${s.sessionId}`;
    const edit = editing?.id === key ? editing : null;
    const members = tree?.members ?? [s.sessionId];
    const openId = tree?.openId ?? s.sessionId;
    const target = byId.get(openId) ?? s;
    // The row's menu acts on the session a click opens (the newest version of a 갈래 tree), and says which one it is.
    const order = members.map((id) => byId.get(id)).filter((x): x is SessionEntry => !!x).sort((a, b) => a.lastModified - b.lastModified);
    const engine = engineOf(target);
    const which = members.length > 1 ? `갈래 ${order.findIndex((x) => x.sessionId === target.sessionId) + 1}/${members.length} · ${ago(target.lastModified, now)} 수정` : undefined;
    return (
      <li key={s.sessionId} className={currentSessionId && members.includes(currentSessionId) ? 'active' : ''} title={target.title}
        // The second click of a double-click (rename) must not re-open the session.
        onClick={(e) => { if (e.detail > 1 || edit) return; onOpen(target.sessionId, target.cwd, target.title); }}
        onContextMenu={canEdit ? (e) => { e.preventDefault(); setMenu(key); } : undefined}>
        <span className="session-row">
          {members.map(dot).find((d) => d !== null) ?? null}
          {edit ? (
            <input className="session-rename" aria-label="세션 이름" value={edit.text} autoFocus maxLength={200}
              onChange={(e) => setEditing({ id: key, text: e.target.value })}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') { e.preventDefault(); commitEdit(target, key); }
                if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
              }}
              onBlur={() => commitEdit(target, key)} onClick={(e) => e.stopPropagation()} />
          ) : (
            <span className="session-title" onDoubleClick={onRename ? (e) => { e.stopPropagation(); startEdit(target, key); } : undefined}><EngineMark engine={engine} decorative />{target.title}</span>
          )}
          {/* meta + actions: one trailing group (a hover overlay with a mouse, line 2 + end column on touch / narrow) */}
          <span className="row-end">
          <span className="session-meta" {...(s.imported ? { title: s.codexArchived ? 'Codex 에서 보관한 대화 — 읽기만 할 수 있습니다' : s.cwdMissing ? '폴더가 없어 이어서 보낼 수 없음 — 읽기만 할 수 있습니다' : s.codexExec ? 'codex exec 로 자동 실행된 대화 — 메시지를 보내면 deck 에서 이어갑니다' : 'Codex 앱/CLI 에서 만든 대화 — 메시지를 보내면 deck 에서 이어갑니다' } : {})}>{[project, s.codexExec ? '자동 실행' : null, s.codexArchived ? 'Codex 보관' : null, s.cwdMissing ? '폴더 없음' : null, members.length > 1 ? `갈래 ${members.length}` : null, status(members) ?? ago(s.lastModified, now)].filter(Boolean).join(' · ')}</span>
          {canEdit && !edit && (
            <button type="button" className="row-more-btn" aria-keyshortcuts={reorderKeys(group)} aria-label="세션 메뉴" title="이름 바꾸기 · 보관 · 삭제" aria-haspopup="menu" aria-expanded={menu === key}
              onClick={(e) => { e.stopPropagation(); setMenu((m) => (m === key ? null : key)); }}>⋯</button>
          )}
          {onTogglePin && (
            <button type="button" className={`pin-btn ${on ? 'on' : ''}`} aria-keyshortcuts={reorderKeys(group)} aria-label={on ? '고정 해제' : '고정'} title={on ? '고정 해제' : '맨 위에 고정'} onClick={(e) => { e.stopPropagation(); onTogglePin(s.sessionId, !on); }}>
              <PinIcon filled={on} />
            </button>
          )}
          </span>
        </span>
        {keyHint && !edit && <kbd className="pin-key" aria-hidden="true">{keyHint}</kbd>}
        {menu === key && (
          <MenuList onClose={() => setMenu(null)}>
            {which && <div className="session-menu-which muted" data-testid="session-menu-which">{which}</div>}
            {onRename && <button type="button" role="menuitem" onClick={() => startEdit(target, key)}>이름 바꾸기</button>}
            {/* Touch screens hide the row's pin button (it ate the title's width); pinning lives here too. */}
            {onTogglePin && <button type="button" role="menuitem" onClick={() => { setMenu(null); onTogglePin(s.sessionId, !on); }}>{on ? '고정 해제' : '맨 위에 고정'}</button>}
            {/* Archived in Codex: only the Codex app can unarchive it. */}
            {onArchive && !target.codexArchived && <button type="button" role="menuitem" onClick={() => { setMenu(null); onArchive(target.sessionId, !target.archived); }}>{target.archived ? '보관 해제' : '보관'}</button>}
            {/* GPT / Gemini / Codex-app sessions: shown disabled with the reason, so it is clear why they stay. */}
            {onDelete && (deleteBlockedReason(target)
              ? <BlockedDeleteItem reason={deleteBlockedReason(target)!} />
              : <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(null); onDelete(target, which); }}>삭제…</button>)}
          </MenuList>
        )}
      </li>
    );
  };

  /** A Claude Desktop session outside deck's projects: opens like any session; the only action is 고정. */
  const desktopRow = (d: DesktopSession, group: string, keyHint?: string | null) => {
    const on = pinSet.has(d.sessionId);
    const key = `${group}:${d.sessionId}`;
    return (
      <li key={d.sessionId} className={d.sessionId === currentSessionId ? 'active' : ''} title={`${d.title}\n${d.cwd}`} onClick={() => onOpen(d.sessionId, d.cwd, d.title)}>
        <span className="session-row">
          {dot(d.sessionId)}
          <span className="session-title"><EngineMark engine="claude" decorative />{d.title}</span>
          <span className="row-end">
          <span className="session-meta">{d.project}{group === 'desktop' ? '' : ' · Desktop'} · {status([d.sessionId]) ?? ago(d.lastModified, now)}</span>
          {onTogglePin && (
            <>
              <button type="button" className="row-more-btn" aria-keyshortcuts={reorderKeys(group)} aria-label="세션 메뉴" title="고정" aria-haspopup="menu" aria-expanded={menu === key}
                onClick={(e) => { e.stopPropagation(); setMenu((m) => (m === key ? null : key)); }}>⋯</button>
              <button type="button" className={`pin-btn ${on ? 'on' : ''}`} aria-keyshortcuts={reorderKeys(group)} aria-label={on ? '고정 해제' : '고정'} title={on ? '고정 해제' : '맨 위에 고정'} onClick={(e) => { e.stopPropagation(); onTogglePin(d.sessionId, !on); }}>
                <PinIcon filled={on} />
              </button>
            </>
          )}
          </span>
        </span>
        {keyHint && <kbd className="pin-key" aria-hidden="true">{keyHint}</kbd>}
        {menu === key && onTogglePin && (
          <MenuList onClose={() => setMenu(null)}>
            <button type="button" role="menuitem" onClick={() => { setMenu(null); onTogglePin(d.sessionId, !on); }}>{on ? '고정 해제' : '맨 위에 고정'}</button>
          </MenuList>
        )}
      </li>
    );
  };

  const hitsShown = (found && found.q === fullQ ? found.hits : []).filter((h) => { const s = byId.get(h.sessionId); return !s || inView(s); });
  const searching = fullOn && found?.q !== fullQ;
  const projectName = new Map<string, string>();
  for (const p of projects) for (const s of p.sessions) if (!projectName.has(s.sessionId)) projectName.set(s.sessionId, p.name);
  // 메시지 편집 갈래: one row per branch tree (its root, opening the newest version); the tree's other sessions are not listed.
  // A deleted root (휴지통) just drops out: its children keep their link and group under the oldest one left.
  const links = linksOf(byId.values());
  // 최근: deck sessions and Desktop-only sessions in one date-split list, minus what 고정됨 already shows.
  type RecentItem = { kind: 'session'; g: BranchGroup<SessionEntry>; lastModified: number } | { kind: 'desktop'; d: DesktopSession; lastModified: number };
  const recentList: RecentItem[] = view === 'recent'
    ? [
        ...groupBranches([...byId.values()].filter(inView), links).filter((g) => match(g.entry) && !pinSet.has(g.entry.sessionId)).map((g): RecentItem => ({ kind: 'session', g, lastModified: g.entry.lastModified })),
        ...desktopShown.map((d): RecentItem => ({ kind: 'desktop', d, lastModified: d.lastModified })),
      ].sort((a, b) => b.lastModified - a.lastModified).slice(0, MAX_RECENT)
    : [];
  // 프로젝트: the same — what 고정됨 shows is not listed again under its project.
  const visible = projects.map((p) => ({ p, sessions: groupBranches(p.sessions.filter(inView), links).filter((g) => !pinSet.has(g.entry.sessionId)).slice(0, MAX_SESSIONS).filter((g) => match(g.entry)) })).filter(({ sessions }) => (!q && !showArchived) || sessions.length > 0);
  const menuItems: SidebarMenuItem[] = footMenu ?? (onOpenSettings ? [{ label: '설정', hint: `${isMacPlatform() ? '⌘' : 'Ctrl+'},`, run: onOpenSettings }] : []);
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        {onOpenFolder && (
          <button type="button" className="text-btn" onClick={() => setPicking((v) => !v)} title="아무 폴더에서 새 세션" aria-expanded={picking}>
            <FolderIcon /><span>폴더 열기</span>
          </button>
        )}
        <div className="view-toggle" role="group" aria-label="목록 보기">
          <button type="button" className={view === 'recent' ? 'on' : ''} aria-pressed={view === 'recent'} onClick={() => setView('recent')} title="최근 대화를 날짜별로">최근</button>
          <button type="button" className={view === 'projects' ? 'on' : ''} aria-pressed={view === 'projects'} onClick={() => setView('projects')} title="프로젝트별로 묶기">프로젝트</button>
        </div>
        <span className="grow" />
        {onArchive && (
          <button type="button" className={`text-btn archived-filter ${showArchived ? 'on' : ''}`} aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)} title={showArchived ? '보관된 세션 보는 중 · 클릭하면 전체' : '보관된 세션만 보기'}>보관됨</button>
        )}
        <button type="button" className="icon-btn" onClick={onRefresh} title="세션 목록 다시 읽기" aria-label="세션 목록 다시 읽기">↻</button>
      </div>
      {picking && onOpenFolder && <FolderPicker onOpen={(cwd) => { setPicking(false); onOpenFolder(cwd); }} onClose={() => setPicking(false)} {...(fetchFn ? { fetchFn } : {})} />}
      <label className="sidebar-search">
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="7" cy="7" r="4.75" /><path d="m10.5 10.5 3.25 3.25" /></svg>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="세션 검색" aria-label="세션 검색" />
      </label>
      {pinned.length > 0 && (
        <section className="project pinned-group" data-testid="pinned-group">
          <div className="project-head"><span className="project-name">고정됨</span></div>
          <ul {...pinDrag.listProps}>{pinned.map((it, i) => (it.kind === 'session' ? row(it.s, 'pinned', undefined, undefined, pinKey(i)) : desktopRow(it.d, 'pinned', pinKey(i))))}</ul>
          <span className="sr-only" role="status" aria-live="polite">{pinDrag.live}</span>
        </section>
      )}
      {view === 'projects' && desktopShown.length > 0 && (
        <section className="project desktop-group" data-testid="desktop-group">
          <div className="project-head"><span className="project-name">최근 Desktop 세션</span></div>
          <ul>{desktopShown.map((d) => desktopRow(d, 'desktop'))}</ul>
        </section>
      )}
      {projects.length === 0 && <div className="muted sidebar-empty">아직 대화가 없어요. 폴더 열기로 작업할 폴더를 고른 뒤, 아래 새 세션으로 시작해 보세요.</div>}
      {showArchived && !q && (view === 'recent' ? recentList.length === 0 : visible.length === 0) && pinned.length === 0 && desktopShown.length === 0 && <div className="muted sidebar-empty">보관된 세션이 없습니다.</div>}
      {view === 'recent' && groupByDate(recentList).map((g) => (
        <section key={g.label} className="project date-group" data-testid={`date-group-${g.label}`}>
          <div className="project-head"><span className="project-name">{g.label}</span></div>
          <ul>{g.items.map((t) => (t.kind === 'session' ? row(t.g.entry, 'recent', t.g, projectName.get(t.g.entry.sessionId)) : desktopRow(t.d, 'recent')))}</ul>
        </section>
      ))}
      {q && (view === 'recent' ? recentList.length === 0 : visible.length === 0 && desktopShown.length === 0) && pinned.length === 0 && hitsShown.length === 0 && !searching && <div className="muted sidebar-empty">“{query}” 와 맞는 세션이 없습니다.</div>}
      {view === 'projects' && visible.map(({ p, sessions }) => {
        const isCollapsed = !q && collapsed.has(p.cwd);
        const showAll = !!q || expanded.has(p.cwd);
        const shown = showAll ? sessions : sessions.slice(0, FOLD_AT);
        const hidden = sessions.length - shown.length;
        return (
          <section key={p.cwd} className={`project ${isCollapsed ? 'collapsed' : ''}`}>
            <div className="project-head">
              <button type="button" className="project-toggle" aria-expanded={!isCollapsed} title={p.cwd} onClick={() => setCollapsed((c) => toggle(c, p.cwd))}>
                <svg className="chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 3.75 5 6.25l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                <span className="project-name">{p.pinned ? '★ ' : ''}{p.name}</span>
              </button>
              <button type="button" className="icon-btn" aria-label={`${p.name} 새 세션`} title="+ 새 세션" onClick={() => onNew(p.cwd, p.name)}>+</button>
            </div>
            {!isCollapsed && (
              <>
                <ul>{shown.map((g) => row(g.entry, p.cwd, g))}</ul>
                {hidden > 0 && <button type="button" className="more-btn" onClick={() => setExpanded((e) => toggle(e, p.cwd))}>더 보기 ({hidden})</button>}
                {!q && expanded.has(p.cwd) && sessions.length > FOLD_AT && <button type="button" className="more-btn" onClick={() => setExpanded((e) => toggle(e, p.cwd))}>접기</button>}
              </>
            )}
          </section>
        );
      })}
      {fullOn && (searching || hitsShown.length > 0 || found?.error) && (
        <section className="project search-group" data-testid="search-group">
          <div className="project-head"><span className="project-name">대화 내용</span></div>
          {searching && hitsShown.length === 0 && <div className="muted sidebar-empty">검색 중…</div>}
          {found?.error && <div className="error sidebar-empty">{found.error}</div>}
          <ul>
            {hitsShown.map((h, i) => (
              <li key={`${h.sessionId}-${i}`} className="search-hit" title={`${h.title}\n${h.cwd}`} onClick={() => onOpenHit?.(h)}>
                <span className="session-row">
                  <span className="session-title"><EngineMark engine={h.engine} decorative />{h.title}</span>
                  <span className="session-meta">{h.role === 'user' ? '나' : h.engine === 'codex' ? 'GPT' : 'Claude'} · {ago(h.lastModified, now)}</span>
                </span>
                <span className="search-snippet">
                  {h.snippet.slice(0, h.matchStart)}<mark>{h.snippet.slice(h.matchStart, h.matchStart + h.matchLength)}</mark>{h.snippet.slice(h.matchStart + h.matchLength)}
                </span>
              </li>
            ))}
          </ul>
          {found?.q === fullQ && found.truncated && <div className="muted sidebar-empty">결과 일부만 표시됩니다.</div>}
        </section>
      )}
      {(menuItems.length > 0 || onNewChat) && (
        // As in Claude: the avatar (settings/account) bottom left, a floating 새 세션 pill bottom right; the list scrolls
        // under both behind a fade, and only the buttons take pointer events.
        <div className="sidebar-foot">
          {menuItems.length > 0 && (
            <span className="foot-menu-wrap">
              <button type="button" className="sidebar-avatar" aria-haspopup="menu" aria-expanded={footOpen} aria-label="설정 및 계정" title="설정 및 계정" onClick={() => setFootOpen((o) => !o)}>
                {avatar ?? 'D'}
              </button>
              {footOpen && (
                <MenuList className="session-menu foot-menu" label="설정 및 계정" onClose={() => setFootOpen(false)}>
                  {avatarTitle && <div className="foot-menu-head">{avatarTitle}</div>}
                  {menuItems.map((it) => (
                    <button key={it.label} type="button" role="menuitem" onClick={() => { setFootOpen(false); it.run(); }}>
                      <span>{it.label}</span>{it.hint && <kbd>{it.hint}</kbd>}
                    </button>
                  ))}
                </MenuList>
              )}
            </span>
          )}
          {onNewChat && (
            <button type="button" className="sidebar-new" onClick={onNewChat} title={`새 세션 (${isMacPlatform() ? '⌘' : 'Ctrl+'}N)`}>
              <PlusIcon /><span>새 세션</span>
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M6 1.75h4l-.5 4.5 2.5 2.5v1H4v-1l2.5-2.5z" />
      <path d="M8 9.75v4.5" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1l1.5 1.5h5.9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
    </svg>
  );
}
