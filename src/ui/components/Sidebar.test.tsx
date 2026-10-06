// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { META_TICK_MS, Sidebar } from './Sidebar';

const noop = () => {};
/** Fixture times: now, each one 1 ms older, so the 최근 view's newest-first order is the creation order (equal / ms-apart Date.now() made it flaky). */
const stamp = (() => { const base = Date.now(); let k = 0; return () => base - k++; })();

describe('Sidebar 폴더 열기 (F1)', () => {
  afterEach(cleanup);

  it('opens the folder picker and hands the server-validated path to onOpenFolder', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ path: '/Users/u/x', recent: ['/Users/u/x'] }), { status: 200 });
      if (url === '/api/recent-folders') return new Response(JSON.stringify({ recent: [] }), { status: 200 });
      return new Response(JSON.stringify({ path: '/Users/u', parent: null, dirs: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const onOpenFolder = vi.fn();
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onOpenFolder={onOpenFolder} fetchFn={fetchFn} />);
    expect(screen.queryByLabelText('폴더 경로')).toBeNull();
    fireEvent.click(screen.getByText('폴더 열기'));
    fireEvent.change(screen.getByLabelText('폴더 경로'), { target: { value: '~/x' } });
    fireEvent.click(screen.getByText('열기'));
    await waitFor(() => expect(onOpenFolder).toHaveBeenCalledWith('/Users/u/x'));
    expect(screen.queryByLabelText('폴더 경로')).toBeNull();
  });
});

describe('Sidebar pins (F2)', () => {
  afterEach(cleanup);
  const s = (id: string, cwd: string, title: string) => ({ sessionId: id, account: 'b' as const, cwd, projectDir: '/p', file: '/f', title, lastModified: stamp(), sizeBytes: 1 });
  const projects = [
    { cwd: '/w/one', name: 'one', pinned: false, sessions: [s('s1', '/w/one', 'first'), s('s2', '/w/one', 'second')] },
    { cwd: '/w/two', name: 'two', pinned: false, sessions: [s('s3', '/w/two', 'third')] },
  ];

  it('shows a 고정됨 group at the top in pin order across projects, skipping unknown ids', () => {
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} pins={['s3', 'gone', 's1']} onTogglePin={noop} />);
    const group = screen.getByTestId('pinned-group');
    expect(group.textContent).toContain('고정됨');
    const titles = [...group.querySelectorAll('.session-title')].map((e) => e.textContent);
    expect(titles).toEqual(['third', 'first']);
  });

  it('no 고정됨 group without pins; the pin toggle reports the new state and does not open the session', () => {
    const onTogglePin = vi.fn();
    const onOpen = vi.fn();
    const { rerender } = render(<Sidebar projects={projects} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} pins={[]} onTogglePin={onTogglePin} />);
    expect(screen.queryByTestId('pinned-group')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: '고정' })[0]!);
    expect(onTogglePin).toHaveBeenCalledWith('s1', true);
    expect(onOpen).not.toHaveBeenCalled();
    rerender(<Sidebar projects={projects} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} pins={['s1']} onTogglePin={onTogglePin} />);
    fireEvent.click(screen.getAllByRole('button', { name: '고정 해제' })[0]!);
    expect(onTogglePin).toHaveBeenLastCalledWith('s1', false);
  });

  it('프로젝트 view: each session once — pinned rows leave their project list (as in 최근)', () => {
    const { container } = render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} view="projects" pins={['s1', 's3']} onTogglePin={noop} />);
    const pinnedTitles = [...screen.getByTestId('pinned-group').querySelectorAll('.session-title')].map((e) => e.textContent);
    expect(pinnedTitles).toEqual(['first', 'third']);
    const listed = [...container.querySelectorAll('section.project:not([data-testid]) .session-title')].map((e) => e.textContent);
    expect(listed).toEqual(['second']);
    // The project whose only session is pinned keeps its header (+ 새 세션).
    expect(screen.getByRole('button', { name: 'two 새 세션' })).toBeTruthy();
  });

  it('clicking a pinned row opens its session', () => {
    const onOpen = vi.fn();
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} pins={['s3']} onTogglePin={noop} />);
    fireEvent.click(screen.getByTestId('pinned-group').querySelector('li')!);
    expect(onOpen).toHaveBeenCalledWith('s3', '/w/two', 'third');
  });
});

describe('Sidebar ⌘1 … ⌘9 hints', () => {
  afterEach(cleanup);
  const s = (i: number) => ({ sessionId: `s${i}`, account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title: `session ${i}`, lastModified: stamp(), sizeBytes: 1 });
  const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: Array.from({ length: 12 }, (_, i) => s(i)) }];
  // 11 pinned; the first is a Desktop-only session.
  const desktop = [{ sessionId: 'd1', account: 'a' as const, cwd: '/d', title: 'desk', project: 'd', lastModified: stamp() }];
  const pins = ['d1', ...Array.from({ length: 10 }, (_, i) => `s${i}`)];
  const hints = () => [...screen.getByTestId('pinned-group').querySelectorAll('li')].map((li) => li.querySelector('.pin-key')?.textContent ?? null);
  /** jsdom has no Mac platform: the modifier is Ctrl. */
  const hold = (extra: Record<string, unknown> = {}) => fireEvent.keyDown(window, { key: 'Control', ctrlKey: true, ...extra });
  const nine = [...Array.from({ length: 9 }, (_, i) => `Ctrl+${i + 1}`), null, null];
  const none = Array.from({ length: 11 }, () => null);
  const setup = (onOpen: (id: string, cwd: string, title: string) => void = noop) => {
    const pinShortcut = { current: (_: number) => false };
    render(<Sidebar projects={projects} desktop={desktop} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} pins={pins} pinShortcut={pinShortcut} onTogglePin={noop} />);
    return pinShortcut;
  };

  it('shows the number on the first nine pinned rows only, while Ctrl is held alone', () => {
    setup();
    expect(hints()).toEqual(none);
    hold();
    expect(hints()).toEqual(nine);
    fireEvent.keyUp(window, { key: 'Control' });
    expect(hints()).toEqual(none);
    hold({ shiftKey: true });
    expect(hints()).toEqual(none);
    hold({ altKey: true });
    expect(hints()).toEqual(none);
    // Only pinned rows carry it.
    hold();
    expect(document.querySelectorAll('.pin-key')).toHaveLength(9);
  });

  it('cannot stick: window blur and a hidden page clear it', () => {
    setup();
    hold();
    fireEvent.blur(window);
    expect(hints()).toEqual(none);
    hold();
    fireEvent(document, new Event('visibilitychange'));
    expect(hints()).toEqual(none);
  });

  it('no hints without the shortcut wired; with a filter the numbers follow the rows shown, and the opener opens that row', () => {
    const onOpen = vi.fn();
    const pinShortcut = setup(onOpen);
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'session 1' } }); // "session 1" (s10 is not pinned)
    hold();
    expect(hints()).toEqual(['Ctrl+1']);
    expect(pinShortcut.current(0)).toBe(true);
    expect(onOpen).toHaveBeenLastCalledWith('s1', '/w', 'session 1');
    expect(pinShortcut.current(1)).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: '' } });
    expect(pinShortcut.current(0)).toBe(true);
    expect(onOpen).toHaveBeenLastCalledWith('d1', '/d', 'desk');
    cleanup();
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} pins={pins} onTogglePin={noop} />);
    hold();
    expect(document.querySelector('.pin-key')).toBeNull();
  });
});

describe('Sidebar folding and search', () => {
  afterEach(cleanup);
  const s = (i: number) => ({ sessionId: `s${i}`, account: 'a' as const, cwd: '/w', projectDir: '/p', file: '/f', title: `session ${i}`, lastModified: Date.now() - 3 * 3_600_000, sizeBytes: 1 });
  const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: Array.from({ length: 8 }, (_, i) => s(i)) }];

  it('shows 5 sessions then 더 보기; the project header collapses its list; rows carry the time, not an account letter', () => {
    const { container } = render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    expect(container.querySelectorAll('li')).toHaveLength(5);
    expect(container.querySelector('.session-meta')?.textContent).toBe('3시간 전'); // turns are spread over accounts, so a per-session letter would mislead
    fireEvent.click(screen.getByText('더 보기 (3)'));
    expect(container.querySelectorAll('li')).toHaveLength(8);
    fireEvent.click(screen.getByText('접기'));
    expect(container.querySelectorAll('li')).toHaveLength(5);
    fireEvent.click(screen.getByText('w'));
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });

  it('the search box filters sessions by title across the fold', () => {
    const onNew = vi.fn();
    const { container } = render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={onNew} onRefresh={noop} />);
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'session 7' } });
    expect([...container.querySelectorAll('.session-title')].map((e) => e.textContent)).toEqual(['session 7']);
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'nothing' } });
    expect(screen.getByText(/맞는 세션이 없습니다/)).toBeTruthy();
    expect(screen.queryByLabelText('w 새 세션')).toBeNull(); // the project hides while nothing in it matches
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('w 새 세션'));
    expect(onNew).toHaveBeenCalledWith('/w', 'w');
  });
});

describe('Sidebar 최근 Desktop 세션 / 자동 승인', () => {
  afterEach(cleanup);
  const d = (n: number, title: string, project: string) => ({ sessionId: `d${n}`, account: 'a' as const, title, cwd: `/Users/u/${project}`, project, lastModified: Date.now() - n * 3_600_000 });

  it('lists the Desktop sessions with project and relative time; a click opens it like any session; search filters them', () => {
    const onOpen = vi.fn();
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} desktop={[d(1, 'Fix login', 'deck'), d(2, 'Write docs', 'harness')]} />);
    const group = screen.getByTestId('desktop-group');
    expect(group.textContent).toContain('최근 Desktop 세션');
    expect(group.textContent).toContain('deck · 1시간 전');
    fireEvent.click(screen.getByText('Write docs'));
    expect(onOpen).toHaveBeenCalledWith('d2', '/Users/u/harness', 'Write docs');
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'harness' } });
    expect(screen.queryByText('Fix login')).toBeNull();
    expect(screen.getByText('Write docs')).toBeTruthy();
  });

  it('최근 view: each session once — pinned rows leave the date groups, Desktop sessions merge into them, no separate Desktop section', () => {
    const s = (id: string, title: string) => ({ sessionId: id, account: 'b' as const, cwd: '/w/one', projectDir: '/p', file: '/f', title, lastModified: Date.now() - 60_000, sizeBytes: 1 });
    const projects = [{ cwd: '/w/one', name: 'one', pinned: false, sessions: [s('s1', 'first'), s('s2', 'second'), s('d1', 'Fix login')] }];
    const onTogglePin = vi.fn();
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} view="recent" pins={['s1', 'd3']} onTogglePin={onTogglePin}
      desktop={[d(1, 'Fix login', 'one'), d(2, 'Write docs', 'harness'), d(3, 'Pinned desktop', 'x')]} />);
    expect(screen.queryByTestId('desktop-group')).toBeNull();
    const titles = [...document.querySelectorAll('.session-title')].map((e) => e.textContent);
    // every title exactly once
    expect([...titles].sort()).toEqual(['Fix login', 'Pinned desktop', 'Write docs', 'first', 'second']);
    const pinnedTitles = [...screen.getByTestId('pinned-group').querySelectorAll('.session-title')].map((e) => e.textContent);
    expect(pinnedTitles).toEqual(['first', 'Pinned desktop']);
    // a Desktop-only row sits in its date group (which one depends on the clock), labelled, and can be pinned too
    const docs = [...document.querySelectorAll('.date-group li')].find((li) => li.textContent?.includes('Write docs'))!;
    expect(docs.textContent).toContain('harness · Desktop');
    fireEvent.click(docs.querySelector('button[aria-label="고정"]')!);
    expect(onTogglePin).toHaveBeenCalledWith('d2', true);
  });

  it('프로젝트 view: the Desktop section skips sessions a project already lists', () => {
    const s = { sessionId: 'd1', account: 'a' as const, cwd: '/w/deck', projectDir: '/p', file: '/f', title: 'Fix login', lastModified: Date.now(), sizeBytes: 1 };
    render(<Sidebar projects={[{ cwd: '/w/deck', name: 'deck', pinned: true, sessions: [s] }]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop}
      desktop={[d(1, 'Fix login', 'deck'), d(2, 'Write docs', 'harness')]} />);
    const group = screen.getByTestId('desktop-group');
    expect(group.textContent).not.toContain('Fix login');
    expect(group.textContent).toContain('Write docs');
    expect(screen.getAllByText('Fix login')).toHaveLength(1);
  });

  it('no Desktop sessions → no section', () => {
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    expect(screen.queryByTestId('desktop-group')).toBeNull();
  });

});

describe('Sidebar rename / archive / 대화 내용 검색', () => {
  afterEach(cleanup);
  const s = (id: string, title: string, archived = false) => ({ sessionId: id, account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title, lastModified: stamp(), sizeBytes: 1, ...(archived ? { archived } : {}) });
  const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [s('s1', 'Alpha'), s('s2', 'Beta'), s('s3', 'Old', true)] }];

  it('double-click renames inline: Enter saves, Esc cancels, empty resets to the transcript title; the 2nd click does not re-open', () => {
    const onRename = vi.fn();
    const onOpen = vi.fn();
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} onRename={onRename} onArchive={noop} />);
    const title = screen.getByText('Alpha');
    fireEvent.click(title, { detail: 1 });
    fireEvent.click(title, { detail: 2 });
    fireEvent.doubleClick(title);
    expect(onOpen).toHaveBeenCalledTimes(1);
    const input = screen.getByLabelText('세션 이름') as HTMLInputElement;
    expect(input.value).toBe('Alpha');
    fireEvent.change(input, { target: { value: '  Release   notes ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('s1', 'Release notes');
    expect(screen.queryByLabelText('세션 이름')).toBeNull();

    fireEvent.doubleClick(screen.getByText('Beta'));
    fireEvent.change(screen.getByLabelText('세션 이름'), { target: { value: 'nope' } });
    fireEvent.keyDown(screen.getByLabelText('세션 이름'), { key: 'Escape' });
    fireEvent.doubleClick(screen.getByText('Beta'));
    fireEvent.change(screen.getByLabelText('세션 이름'), { target: { value: '   ' } });
    fireEvent.blur(screen.getByLabelText('세션 이름'));
    expect(onRename.mock.calls).toEqual([['s1', 'Release notes'], ['s2', null]]);
  });

  it('context menu archives; archived sessions only show under 보관됨, where they can be unarchived or renamed', () => {
    const onArchive = vi.fn();
    const onRename = vi.fn();
    const { container } = render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onRename={onRename} onArchive={onArchive} pins={['s3']} onTogglePin={noop} />);
    const titles = () => [...container.querySelectorAll('.session-title')].map((e) => e.textContent);
    expect(titles()).toEqual(['Alpha', 'Beta']);
    expect(screen.queryByTestId('pinned-group')).toBeNull(); // a pinned but archived session hides too
    fireEvent.contextMenu(screen.getByText('Beta'));
    fireEvent.click(screen.getByRole('menuitem', { name: '보관' }));
    expect(onArchive).toHaveBeenCalledWith('s2', true);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByText('보관됨'));
    // Pinned: listed once, under 고정됨 (not again under its project).
    expect(titles()).toEqual(['Old']);
    expect(screen.getByTestId('pinned-group').textContent).toContain('Old');
    fireEvent.click(screen.getAllByLabelText('세션 메뉴')[0]!);
    fireEvent.click(screen.getByRole('menuitem', { name: '보관 해제' }));
    expect(onArchive).toHaveBeenLastCalledWith('s3', false);
    fireEvent.click(screen.getAllByLabelText('세션 메뉴')[0]!);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('보관됨 with nothing archived says so; no menu without handlers', () => {
    render(<Sidebar projects={[{ ...projects[0]!, sessions: [s('s1', 'Alpha')] }]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onArchive={noop} />);
    fireEvent.click(screen.getByText('보관됨'));
    expect(screen.getByText('보관된 세션이 없습니다.')).toBeTruthy();
    cleanup();
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    expect(screen.queryByLabelText('세션 메뉴')).toBeNull();
    expect(screen.queryByText('보관됨')).toBeNull();
  });

  it('full-text search: debounced, highlighted snippet, archived-session hits hidden, click opens the hit', async () => {
    const hit = (sessionId: string, snippet: string, matchStart: number) => ({ sessionId, title: `T ${sessionId}`, cwd: '/w', account: 'b', engine: 'claude' as const, lastModified: Date.now(), role: 'assistant' as const, snippet, matchStart, matchLength: 5 });
    const searchFn = vi.fn(async (q: string) => ({ hits: [hit('s1', '…fix the flaky test…', 9), hit('s3', 'flaky old', 0), hit('zz', 'other flaky', 6)], truncated: q === 'flaky' }));
    const onOpenHit = vi.fn();
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onOpenHit={onOpenHit} searchFn={searchFn} onArchive={noop} />);
    const box = screen.getByLabelText('세션 검색');
    fireEvent.change(box, { target: { value: 'f' } });
    fireEvent.change(box, { target: { value: 'fl' } });
    fireEvent.change(box, { target: { value: 'flaky' } });
    const group = await screen.findByTestId('search-group');
    await waitFor(() => expect(group.querySelectorAll('.search-hit')).toHaveLength(2));
    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(searchFn).toHaveBeenCalledWith('flaky');
    expect([...group.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['flaky', 'flaky']);
    expect(group.querySelector('.search-snippet')!.textContent).toBe('…fix the flaky test…');
    expect(screen.getByText('결과 일부만 표시됩니다.')).toBeTruthy();
    fireEvent.click(group.querySelector('.search-hit')!);
    expect(onOpenHit).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
    fireEvent.change(box, { target: { value: 'f' } });
    expect(screen.queryByTestId('search-group')).toBeNull();
  });
});

describe('Sidebar activity dots', () => {
  afterEach(cleanup);
  const s = (id: string, title: string) => ({ sessionId: id, account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title, lastModified: stamp(), sizeBytes: 1 });
  it('running → spinner, background only → pulsing dot, finished unseen → unread dot', () => {
    const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [s('s1', 'one'), s('s2', 'two'), s('s3', 'three'), s('s4', 'four')] }];
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop}
      activity={[{ sessionId: 's1', cwd: '/w', turnId: 't1', running: true, bg: 0, forMs: 0 }, { sessionId: 's2', cwd: '/w', turnId: 't2', running: false, bg: 2, forMs: 0 }]}
      unread={['s3']} />);
    const dotOf = (title: string) => screen.getByText(title).closest('li')!.querySelector('.row-dot');
    expect(dotOf('one')?.classList.contains('running')).toBe(true);
    expect(dotOf('two')?.getAttribute('aria-label')).toBe('백그라운드 작업 2개');
    expect(dotOf('three')?.classList.contains('unread')).toBe(true);
    expect(dotOf('four')).toBeNull();
  });
});

describe('Sidebar row status and time', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  const s = (id: string, title: string, lastModified = Date.now() - 2 * 60_000) => ({ sessionId: id, account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title, lastModified, sizeBytes: 1 });
  const metaOf = (title: string) => screen.getByText(title).closest('li')!.querySelector('.session-meta')?.textContent;

  it('승인 대기 → 실행 중 → 백그라운드 N개 → 새 응답 replace the time; otherwise the time', () => {
    const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [s('s0', 'zero'), s('s1', 'one'), s('s2', 'two'), s('s3', 'three'), s('s4', 'four')] }];
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop}
      activity={[{ sessionId: 's0', cwd: '/w', turnId: 't0', running: true, bg: 0, forMs: 0 }, { sessionId: 's1', cwd: '/w', turnId: 't1', running: true, bg: 1, forMs: 0 }, { sessionId: 's2', cwd: '/w', turnId: 't2', running: false, bg: 2, forMs: 0 }]}
      unread={['s2', 's3']} waiting={['s0']} />);
    expect(metaOf('zero')).toBe('승인 대기');
    expect(metaOf('one')).toBe('실행 중');
    expect(metaOf('two')).toBe('백그라운드 2개');
    expect(metaOf('three')).toBe('새 응답');
    expect(metaOf('four')).toBe('2분 전');
  });

  it('"N분 전" advances every minute without a new index', () => {
    vi.useFakeTimers();
    const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [s('s1', 'one', Date.now() - 2 * 60_000)] }];
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    expect(metaOf('one')).toBe('2분 전');
    act(() => { vi.advanceTimersByTime(META_TICK_MS * 3); });
    expect(metaOf('one')).toBe('5분 전');
  });
});

describe('Sidebar imported Codex threads', () => {
  afterEach(cleanup);

  it('marks a Codex app/CLI thread with the Codex mark (no redundant meta text) and opens it like any session', () => {
    const onOpen = vi.fn();
    const e = { sessionId: 'tid', account: 'gpt' as const, engine: 'codex' as const, cwd: '/w', projectDir: '/r', file: '/r/f', title: 'from codex', lastModified: Date.now(), sizeBytes: 1, imported: true };
    render(<Sidebar projects={[{ cwd: '/w', name: 'w', pinned: false, sessions: [e] }]} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} />);
    const li = screen.getByText('from codex').closest('li')!;
    expect(li.querySelector('.session-title .engine-mark.codex')?.getAttribute('title')).toBe('Codex (GPT)');
    expect(li.querySelector('.session-meta')?.textContent).toBe('방금');
    fireEvent.click(screen.getByText('from codex'));
    expect(onOpen).toHaveBeenCalledWith('tid', '/w', 'from codex');
  });

  it('tags a `codex exec` thread 자동 실행 in the meta', () => {
    const e = { sessionId: 'x1', account: 'gpt' as const, engine: 'codex' as const, cwd: '/w', projectDir: '/r', file: '/r/f', title: 'You are the docs lane', lastModified: Date.now() - 120_000, sizeBytes: 1, imported: true, codexExec: true };
    const { container } = render(<Sidebar projects={[{ cwd: '/w', name: 'w', pinned: false, sessions: [e] }]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    expect(container.querySelector('.session-meta')?.textContent).toBe('자동 실행 · 2분 전');
    expect(container.querySelector('.engine-mark.codex')).not.toBeNull();
  });

  it('tags a gone-folder thread 폴더 없음 and a Codex-archived one Codex 보관 (no 보관 해제: only Codex can)', () => {
    const base = { account: 'gpt' as const, engine: 'codex' as const, cwd: '/w', projectDir: '/r', file: '/r/f', lastModified: Date.now() - 120_000, sizeBytes: 1, imported: true };
    const gone = { ...base, sessionId: 'x2', title: 'gone', cwdMissing: true };
    const arch = { ...base, sessionId: 'x3', title: 'arch', archived: true, codexArchived: true };
    render(<Sidebar projects={[{ cwd: '/w', name: 'w', pinned: false, sessions: [gone, arch] }]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onArchive={noop} />);
    const goneMeta = screen.getByText('gone').closest('li')!.querySelector('.session-meta')!;
    expect(goneMeta.textContent).toBe('폴더 없음 · 2분 전');
    expect(goneMeta.getAttribute('title')).toContain('폴더가 없어 이어서 보낼 수 없음');
    fireEvent.click(screen.getByRole('button', { name: '보관됨' }));
    const li = screen.getByText('arch').closest('li')!;
    expect(li.querySelector('.session-meta')?.textContent).toBe('Codex 보관 · 2분 전');
    fireEvent.click(li.querySelector('.row-more-btn')!);
    expect(screen.queryByRole('menuitem', { name: '보관 해제' })).toBeNull();
  });
});

describe('Sidebar engine marks', () => {
  afterEach(cleanup);
  const claude = { sessionId: 'c1', account: 'a' as const, cwd: '/w', projectDir: '/p', file: '/f', title: 'claude chat', lastModified: stamp(), sizeBytes: 1 };
  const codex = { sessionId: 'g1', account: 'gpt' as const, engine: 'codex' as const, cwd: '/w', projectDir: '', file: '', title: 'codex chat', lastModified: stamp(), sizeBytes: 1 };
  const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [claude, codex] }];
  const markOf = (title: string) => screen.getByText(title).closest('li')!.querySelector('.engine-mark');

  it('puts a Claude / Codex mark before the title in the 프로젝트 view; no account letter on either row', () => {
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    expect(markOf('claude chat')?.getAttribute('title')).toBe('Claude');
    expect(markOf('codex chat')?.getAttribute('title')).toBe('Codex (GPT)');
    // Dense list: the row's text already identifies it, so the mark stays out of the accessibility tree.
    expect(markOf('claude chat')?.getAttribute('aria-hidden')).toBe('true');
    expect(markOf('claude chat')?.hasAttribute('role')).toBe(false);
    // Inside the truncating title (first child), so the ellipsis never hides it and the row does not grow.
    const title = screen.getByText('claude chat');
    expect(title.classList.contains('session-title')).toBe(true);
    expect(title.firstElementChild?.classList.contains('engine-mark')).toBe(true);
    expect(title.textContent).toBe('claude chat');
    expect(screen.getByText('claude chat').closest('li')!.querySelector('.session-meta')?.textContent).not.toMatch(/^[ABC] · /);
  });

  it('marks rows in 최근, 고정됨 and Desktop rows, next to an unchanged unread / running dot', () => {
    const desktop = [{ sessionId: 'd1', account: 'a' as const, title: 'desk chat', cwd: '/d', project: 'd', lastModified: stamp() }];
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} view="recent" pins={['c1']} onTogglePin={noop}
      desktop={desktop} unread={['g1']} activity={[{ sessionId: 'c1', cwd: '/w', turnId: 't', running: true, bg: 0, forMs: 0 }]} />);
    expect(screen.getByTestId('pinned-group').querySelector('.engine-mark.claude')).not.toBeNull();
    expect(markOf('codex chat')?.classList.contains('codex')).toBe(true);
    expect(markOf('desk chat')?.classList.contains('claude')).toBe(true);
    const codexRow = screen.getByText('codex chat').closest('li')!;
    expect(codexRow.querySelector('.session-row > .row-dot.unread')).not.toBeNull();
    expect(screen.getByText('claude chat').closest('li')!.querySelector('.session-row > .row-dot.running')).not.toBeNull();
  });

  it('marks 대화 내용 search hits by engine; Gemini gets none', async () => {
    const hit = (id: string, engine: 'claude' | 'codex' | 'gemini') => ({ sessionId: id, title: `hit ${id}`, cwd: '/w', account: 'a', engine, lastModified: Date.now(), role: 'assistant' as const, snippet: 'abc', matchStart: 0, matchLength: 2 });
    const searchFn = vi.fn(async () => ({ hits: [hit('h1', 'claude'), hit('h2', 'codex'), hit('h3', 'gemini')], truncated: false }));
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onOpenHit={noop} searchFn={searchFn} />);
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'ab' } });
    await waitFor(() => expect(screen.getByText('hit h2')).toBeTruthy());
    expect(screen.getByText('hit h1').querySelector('.engine-mark')?.getAttribute('title')).toBe('Claude');
    expect(screen.getByText('hit h2').querySelector('.engine-mark')?.getAttribute('title')).toBe('Codex (GPT)');
    expect(screen.getByText('hit h3').querySelector('.engine-mark')).toBeNull();
  });
});

describe('Sidebar: Desktop parity (새 세션, avatar menu, empty copy, menu keyboard, 삭제 reasons)', () => {
  afterEach(cleanup);
  const e = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ sessionId: id, account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title, lastModified: stamp(), sizeBytes: 1, ...extra });

  it('새 세션 is a pill at the bottom (after the list) in both views and calls onNewChat', () => {
    const onNewChat = vi.fn();
    const { container, rerender } = render(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onNewChat={onNewChat} view="recent" />);
    const foot = container.querySelector('.sidebar')!.lastElementChild!;
    expect(foot.className).toBe('sidebar-foot');
    expect(foot.querySelector('.sidebar-new')?.textContent).toBe('새 세션');
    expect(screen.queryByText('새 채팅')).toBeNull(); // no second, top-of-list button
    fireEvent.click(screen.getByRole('button', { name: '새 세션' }));
    rerender(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onNewChat={onNewChat} view="projects" />);
    fireEvent.click(screen.getByRole('button', { name: '새 세션' }));
    expect(onNewChat).toHaveBeenCalledTimes(2);
  });

  it('the empty list points at 폴더 열기 / 새 세션, not a config file', () => {
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    const text = document.querySelector('.sidebar-empty')!.textContent!;
    expect(text).toContain('새 세션');
    expect(text.indexOf('폴더 열기')).toBeGreaterThan(-1);
    expect(text.indexOf('폴더 열기')).toBeLessThan(text.indexOf('새 세션')); // no folder yet: picking one comes first
    expect(text).not.toContain('projects.json');
  });

  it('avatar (bottom left) opens 설정 및 계정: header, items with hints, keyboard, Esc back to the avatar', () => {
    const settings = vi.fn();
    const usage = vi.fn();
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onNewChat={noop} avatar="B" avatarTitle="deck · 계정 B"
      footMenu={[{ label: '설정', hint: '⌘,', run: settings }, { label: '사용량 기록', run: usage }]} />);
    const avatar = screen.getByRole('button', { name: '설정 및 계정' });
    expect(avatar.textContent).toBe('B');
    expect(avatar.getAttribute('aria-haspopup')).toBe('menu');
    expect(avatar.getAttribute('aria-expanded')).toBe('false');
    // focus order: the avatar comes before the 새 세션 pill
    const foot = document.querySelector('.sidebar-foot')!;
    const buttons: HTMLElement[] = Array.from(foot.querySelectorAll('button'));
    expect(buttons.indexOf(avatar)).toBeLessThan(buttons.indexOf(screen.getByRole('button', { name: '새 세션' })));
    fireEvent.click(avatar);
    expect(avatar.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu', { name: '설정 및 계정' });
    expect(menu.querySelector('.foot-menu-head')?.textContent).toBe('deck · 계정 B');
    const items = screen.getAllByRole('menuitem');
    expect(items.map((b) => b.textContent)).toEqual(['설정⌘,', '사용량 기록']);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(avatar);
    fireEvent.click(avatar);
    fireEvent.click(screen.getByRole('menuitem', { name: /사용량 기록/ }));
    expect(usage).toHaveBeenCalledTimes(1);
    expect(settings).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('without footMenu the avatar menu still offers 설정 (onOpenSettings)', () => {
    const settings = vi.fn();
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onOpenSettings={settings} />);
    fireEvent.click(screen.getByRole('button', { name: '설정 및 계정' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /설정/ }));
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it('⋯ menu: first item focused, ↑/↓ rove (wrapping), Esc closes and refocuses ⋯', () => {
    const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [e('s1', 'one')] }];
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onRename={noop} onArchive={noop} onTogglePin={noop} onDelete={noop} />);
    const more = screen.getByLabelText('세션 메뉴');
    fireEvent.click(more);
    const items = screen.getAllByRole('menuitem');
    expect(items.map((b) => b.textContent)).toEqual(['이름 바꾸기', '맨 위에 고정', '보관', '삭제…']);
    expect(document.activeElement).toBe(items[0]);
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[3]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('삭제 stays visible but disabled, with the reason, for GPT / Gemini / Codex-app sessions', () => {
    const onDelete = vi.fn();
    const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [
      e('i1', 'imported', { account: 'gpt', engine: 'codex', imported: true }),
      e('g1', 'gpt', { account: 'gpt', engine: 'codex' }),
      e('m1', 'gem', { engine: 'gemini' }),
      e('c1', 'claude'),
    ] }];
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onDelete={onDelete} />);
    const del = (title: string) => {
      fireEvent.click(screen.getByText(title).closest('li')!.querySelector('[aria-label="세션 메뉴"]')!);
      const b = screen.getByRole('menuitem', { name: '삭제…' });
      return b;
    };
    const imported = del('imported');
    expect(imported.getAttribute('aria-disabled')).toBe('true');
    expect(imported.getAttribute('title')).toBe('Codex 앱 기록은 deck에서 지울 수 없어요');
    // touch screens show no tooltip: the reason is also on screen, under the item
    expect(imported.querySelector('.menu-note')?.textContent).toBe('Codex 앱 기록은 deck에서 지울 수 없어요');
    expect(imported.getAttribute('aria-describedby')).toBe(imported.querySelector('.menu-note')!.id);
    fireEvent.click(imported);
    expect(onDelete).not.toHaveBeenCalled();
    expect(del('gpt').getAttribute('title')).toContain('GPT');
    expect(del('gem').getAttribute('title')).toContain('Gemini');
    const claude = del('claude');
    expect(claude.hasAttribute('aria-disabled')).toBe(false);
    fireEvent.click(claude);
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'c1' }), undefined);
  });
});

describe('Sidebar rows: Claude parity (icon left, quiet trailing meta)', () => {
  afterEach(cleanup);
  const s = (id: string, cwd: string, title: string) => ({ sessionId: id, account: 'b' as const, cwd, projectDir: '/p', file: '/f', title, lastModified: stamp(), sizeBytes: 1 });
  const projects = [{ cwd: '/w/one', name: 'one', pinned: false, sessions: [s('s1', '/w/one', 'first')] }];
  const desktop = [{ sessionId: 'd1', account: 'a' as const, title: 'desk chat', cwd: '/d', project: 'd', lastModified: stamp() }];

  it('the title leads with its engine mark; meta, ⋯ and pin form one trailing group; the dot stays outside it', () => {
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} view="recent" onTogglePin={noop} onRename={noop}
      desktop={desktop} unread={['s1']} />);
    for (const title of ['first', 'desk chat']) {
      const row = screen.getByText(title).closest('li')!.querySelector('.session-row')!;
      const kids = Array.from(row.children).map((el) => el.className.split(' ')[0]);
      expect(kids.slice(-2)).toEqual(['session-title', 'row-end']);
      expect(row.querySelector('.session-title')!.firstElementChild!.classList.contains('engine-mark')).toBe(true);
      const end = row.querySelector('.row-end')!;
      expect(Array.from(end.children).map((el) => el.className.split(' ')[0])).toEqual(['session-meta', 'row-more-btn', 'pin-btn']);
      // keyboard: ⋯ then 고정, both labelled
      const btns = Array.from(end.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));
      expect(btns).toEqual(['세션 메뉴', '고정']);
    }
    const first = screen.getByText('first').closest('li')!;
    expect(first.querySelector('.session-row > .row-dot.unread')).not.toBeNull();
    expect(first.querySelector('.row-end .row-dot')).toBeNull();
    expect(first.querySelector('.row-end .session-meta')!.textContent).toMatch(/^one · /);
  });
});
