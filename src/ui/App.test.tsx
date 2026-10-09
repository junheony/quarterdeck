// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ClientMessage, ServerMessage } from '../shared/protocol';

Element.prototype.scrollIntoView = () => {};

const sock = vi.hoisted(() => ({ frames: [] as unknown[], onMessage: null as ((m: unknown) => void) | null }));
vi.mock('./ws', () => ({
  createSocket: (onMessage: (m: unknown) => void, onStatus: (v: boolean) => void) => {
    sock.onMessage = onMessage;
    onStatus(true);
    return { send: (m: unknown) => { sock.frames.push(m); }, wake: () => {}, close: () => {} };
  },
}));

import { App } from './App';

const usage = { generatedAt: 'x', deckReachable: true, accounts: { a: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, b: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, c: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null } } } as const;
const entry = (sessionId: string, title: string) => ({ sessionId, account: 'b' as const, cwd: '/w', projectDir: '/p', title, lastModified: Date.now(), sizeBytes: 1 });

async function boot() {
  render(<App />);
  await waitFor(() => expect(sock.onMessage).not.toBeNull());
  server({ type: 'hello', usage, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one'), entry('s2', 'two')] }], running: [], codex: { available: false } } as unknown as ServerMessage);
}
function server(msg: ServerMessage) { act(() => sock.onMessage!(msg)); }
const frames = () => sock.frames as ClientMessage[];
const closes = () => frames().filter((f) => f.type === 'close_session').map((f) => (f as { sessionId: string }).sessionId);
const lastPane = () => screen.getAllByTestId(/^pane-/).at(-1)!;
const openSession = (title: string) => fireEvent.click(within(document.querySelector('.sidebar') as HTMLElement).getByText(title));

describe('App split view (D6)', () => {
  beforeEach(() => {
    localStorage.clear(); // ux-state: the app restores its layout from localStorage
    sock.frames = [];
    sock.onMessage = null;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('ux-state: a reload restores the split, each pane\'s session/picker and folded groups, and re-opens the sessions', async () => {
    localStorage.setItem('deck.sidebarView', 'projects'); // folding is a 프로젝트 view feature
    await boot();
    openSession('one');
    fireEvent.click(screen.getByText('+ 분할'));
    openSession('two');
    fireEvent.click(within(document.querySelector('.sidebar') as HTMLElement).getByTitle('/w')); // fold the project group
    const stored = JSON.parse(localStorage.getItem('deck.ui.v1')!) as { panes: { session: { sessionId: string } }[]; active: number; collapsed: string[] };
    expect(stored.panes.map((p) => p.session.sessionId)).toEqual(['s1', 's2']);
    expect(stored.active).toBe(1);
    expect(stored.collapsed).toEqual(['/w']);
    cleanup();
    sock.frames = [];
    sock.onMessage = null;
    await boot();
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(2);
    expect(frames().filter((f) => f.type === 'open_session').map((f) => (f as { sessionId: string }).sessionId)).toEqual(['s1', 's2']);
    expect(document.querySelector('.project.collapsed')).not.toBeNull();
    server({ type: 'history', sessionId: 's2', cwd: '/w', account: 'b', messages: [{ kind: 'user', text: 'restored', ts: null }], runningTurnId: null } as ServerMessage);
    expect(within(lastPane()).getByText('restored')).toBeTruthy();
  });

  it('ux-state: garbage in localStorage is ignored (one blank pane)', async () => {
    localStorage.setItem('deck.ui.v1', '{"v":1,"panes":"x"');
    await boot();
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(1);
  });

  it('splits into up to 5 equal columns; "+ 분할" disables at 5 and closing re-flows', async () => {
    await boot();
    const split = screen.getByText('+ 분할') as HTMLButtonElement;
    for (let i = 0; i < 4; i++) fireEvent.click(split);
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(5);
    const panes = document.querySelector('.panes') as HTMLElement;
    expect(panes.dataset.count).toBe('5');
    expect(panes.style.getPropertyValue('--cols')).toBe('5');
    expect(split.disabled).toBe(true);
    fireEvent.click(split);
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(5);
    fireEvent.click(within(lastPane()).getByLabelText('패널 닫기'));
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(4);
    expect(panes.style.getPropertyValue('--cols')).toBe('4');
    expect(split.disabled).toBe(false);
  });

  it('T9 (b): switching a pane to another session or closing it sends close_session only for sessions no pane still views', async () => {
    await boot();
    openSession('one');
    expect(frames()).toContainEqual({ type: 'open_session', sessionId: 's1' });
    fireEvent.click(screen.getByText('+ 분할'));
    openSession('two'); // p1 (active) → s2
    expect(frames()).toContainEqual({ type: 'open_session', sessionId: 's2' });
    expect(closes()).toEqual([]);
    openSession('one'); // p1 switches s2 → s1: s2 is released, s1 still shown by p0
    expect(closes()).toEqual(['s2']);
    fireEvent.click(within(screen.getByTestId('pane-p1')).getByLabelText('패널 닫기')); // p0 still shows s1
    expect(closes()).toEqual(['s2']);
    fireEvent.click(screen.getByText('+ 분할'));
    openSession('two');
    fireEvent.click(within(lastPane()).getByLabelText('패널 닫기'));
    expect(closes()).toEqual(['s2', 's2']);
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(1);
  });

  it('T9 (b): a pane closed while its open_session reply is in flight never gets its history into a blank pane', async () => {
    await boot();
    fireEvent.click(screen.getByText('+ 분할'));
    openSession('two'); // p1 → s2, history not yet arrived
    fireEvent.click(within(screen.getByTestId('pane-p1')).getByLabelText('패널 닫기'));
    expect(closes()).toEqual(['s2']);
    fireEvent.click(screen.getByText('+ 분할')); // blank active pane (ids are reused: max remaining + 1)
    server({ type: 'history', sessionId: 's2', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [{ kind: 'user', text: 'stale-history', ts: null }] });
    expect(screen.queryByText('stale-history')).toBeNull();
    expect(within(lastPane()).getByLabelText('첫 메시지')).toBeTruthy(); // the new-chat screen
  });

  it('every send carries a fresh clientRef; a reconnect re-opens each viewed session once', async () => {
    await boot();
    openSession('one');
    server({ type: 'history', sessionId: 's1', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [] });
    fireEvent.change(screen.getByPlaceholderText(/메시지/), { target: { value: 'hi' } });
    fireEvent.click(screen.getByText('보내기'));
    const send = frames().find((f) => f.type === 'send') as { clientRef?: string };
    expect(send.clientRef).toMatch(/.+/);
    fireEvent.click(screen.getByText('+ 분할'));
    openSession('one');
    sock.frames = [];
    server({ type: 'hello', usage, projects: [], running: [], codex: { available: false } } as unknown as ServerMessage);
    expect(frames().filter((f) => f.type === 'open_session')).toEqual([{ type: 'open_session', sessionId: 's1' }]);
  });
});

/** A matchMedia mock whose `matches` can flip after mount (simulating a viewport/orientation change) and notifies listeners registered via useIsPhone's addEventListener('change', …). */
function mockMatchMedia(initialPhone: boolean) {
  let matches = initialPhone;
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) => ({
    get matches() { return matches && query.includes('720'); },
    media: query,
    onchange: null,
    addEventListener: (_: string, cb: () => void) => { listeners.add(cb); },
    removeEventListener: (_: string, cb: () => void) => { listeners.delete(cb); },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return { setPhone: (v: boolean) => act(() => { matches = v; listeners.forEach((cb) => cb()); }) };
}

describe('App type-to-compose', () => {
  beforeEach(() => { localStorage.clear(); sock.frames = []; sock.onMessage = null; vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('ASCII lands in the active composer; a Korean / IME key only moves focus and is swallowed; Space is left to the page', async () => {
    await boot();
    openSession('one');
    const ta = within(lastPane()).getByLabelText('메시지');
    (document.activeElement as HTMLElement | null)?.blur();
    expect(fireEvent.keyDown(document.body, { key: ' ' })).toBe(true);
    expect(document.activeElement).not.toBe(ta);
    expect(fireEvent.keyDown(document.body, { key: 'a' })).toBe(true); // default kept: the browser types it into the composer
    expect(document.activeElement).toBe(ta);
    ta.blur();
    expect(fireEvent.keyDown(document.body, { key: 'Process', keyCode: 229 })).toBe(false);
    expect(document.activeElement).toBe(ta);
    ta.blur();
    expect(fireEvent.keyDown(document.body, { key: 'ㅎ' })).toBe(false);
    expect(document.activeElement).toBe(ta);
  });

  it('a file dragged over the sidebar gets the no-drop cursor and never navigates; the chat pane keeps its own drop', async () => {
    await boot();
    openSession('one');
    const side = { types: ['Files'], files: [], items: [], dropEffect: 'copy' };
    expect(fireEvent.dragOver(document.querySelector('.sidebar')!, { dataTransfer: side })).toBe(false);
    expect(side.dropEffect).toBe('none');
    expect(fireEvent.drop(document.querySelector('.sidebar')!, { dataTransfer: side })).toBe(false);
    const pane = { types: ['Files'], files: [], items: [], dropEffect: 'copy' };
    expect(fireEvent.dragOver(within(lastPane()).getByLabelText('메시지'), { dataTransfer: pane })).toBe(false);
    expect(pane.dropEffect).toBe('copy');
    expect(fireEvent.dragOver(document.querySelector('.sidebar')!, { dataTransfer: { types: ['text/plain'] } })).toBe(true);
  });
});

describe('App phone layout (D10)', () => {
  beforeEach(() => {
    localStorage.clear(); // ux-state: the app restores its layout from localStorage
    sock.frames = [];
    sock.onMessage = null;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); (window as { matchMedia?: unknown }).matchMedia = undefined; });

  it('phone: drawer sidebar, single pane, no split button; opening a session closes the drawer', async () => {
    mockMatchMedia(true);
    await boot();
    expect(screen.queryByText('+ 분할')).toBeNull();
    const menu = screen.getByLabelText('메뉴');
    expect(document.querySelector('.sidebar-wrap.drawer.open')).toBeNull();
    fireEvent.click(menu);
    expect(document.querySelector('.sidebar-wrap.drawer.open')).not.toBeNull();
    openSession('one');
    expect(frames()).toContainEqual({ type: 'open_session', sessionId: 's1' });
    expect(document.querySelector('.sidebar-wrap.drawer.open')).toBeNull();
    expect(document.querySelectorAll('.pane')).toHaveLength(1);
  });

  it('phone with two panes: only the active pane renders, and the pane switcher changes which one renders (PF16)', async () => {
    const mm = mockMatchMedia(false);
    await boot();
    openSession('one'); // p0 -> s1
    fireEvent.click(screen.getByText('+ 분할')); // adds p1, active
    openSession('two'); // p1 -> s2
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(2);

    mm.setPhone(true);
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(1);
    expect(screen.getByTestId('pane-p1')).toBeTruthy(); // active pane (p1) is the one shown
    expect(screen.queryByTestId('pane-p0')).toBeNull();

    fireEvent.click(screen.getByText(/^1 ·/)); // switcher: select pane 1 (p0)
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(1);
    expect(screen.getByTestId('pane-p0')).toBeTruthy();
    expect(screen.queryByTestId('pane-p1')).toBeNull();
  });

  it('Escape closes the open phone drawer', async () => {
    mockMatchMedia(true);
    await boot();
    fireEvent.click(screen.getByLabelText('메뉴'));
    expect(document.querySelector('.sidebar-wrap.drawer.open')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('.sidebar-wrap.drawer.open')).toBeNull();
  });
});

describe('App 고정됨 reorder', () => {
  beforeEach(() => { localStorage.clear(); sock.frames = []; sock.onMessage = null; });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const pinnedTitles = () => [...screen.getByTestId('pinned-group').querySelectorAll('.session-title')].map((e) => e.textContent);
  const bootPinned = async () => {
    render(<App />);
    await waitFor(() => expect(sock.onMessage).not.toBeNull());
    server({ type: 'hello', usage, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one'), entry('s2', 'two')] }], pins: ['s1', 's2'], running: [], codex: { available: false } } as unknown as ServerMessage);
  };
  const moveFirstDown = () => fireEvent.keyDown(screen.getByTestId('pinned-group').querySelector('li button')!, { key: 'ArrowDown', altKey: true });

  it('shows the new order at once and saves it', async () => {
    let release: (r: Response) => void = () => {};
    const fetchFn = vi.fn((url: string) => (url === '/api/pins/order' ? new Promise<Response>((r) => { release = r; }) : Promise.resolve(new Response('{}', { status: 200 }))));
    vi.stubGlobal('fetch', fetchFn);
    await bootPinned();
    moveFirstDown();
    expect(pinnedTitles()).toEqual(['two', 'one']);
    expect(fetchFn).toHaveBeenCalledWith('/api/pins/order', expect.objectContaining({ body: JSON.stringify({ order: ['s2', 's1'] }) }));
    await act(async () => { release(new Response(JSON.stringify({ pins: ['s2', 's1'] }), { status: 200 })); });
    expect(pinnedTitles()).toEqual(['two', 'one']);
    expect(document.querySelector('.toast-item')).toBeNull();
  });

  it('a late answer to an older move does not undo a newer one (success or failure)', async () => {
    const pending: { resolve: (r: Response) => void; reject: (e: unknown) => void }[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/pins/order' ? new Promise<Response>((resolve, reject) => { pending.push({ resolve, reject }); }) : Promise.resolve(new Response('{}', { status: 200 })))));
    await bootPinned();
    moveFirstDown(); // two, one
    moveFirstDown(); // one, two
    expect(pinnedTitles()).toEqual(['one', 'two']);
    await act(async () => { pending[1]!.resolve(new Response(JSON.stringify({ pins: ['s1', 's2'] }), { status: 200 })); });
    await act(async () => { pending[0]!.resolve(new Response(JSON.stringify({ pins: ['s2', 's1'] }), { status: 200 })); });
    expect(pinnedTitles()).toEqual(['one', 'two']);
    moveFirstDown(); // two, one
    moveFirstDown(); // one, two
    await act(async () => { pending[3]!.resolve(new Response(JSON.stringify({ pins: ['s1', 's2'] }), { status: 200 })); });
    await act(async () => { pending[2]!.reject(new TypeError('Failed to fetch')); });
    expect(pinnedTitles()).toEqual(['one', 'two']);
    expect(document.querySelector('.toast-item')).toBeNull();
  });

  it('a failed save keeps a pin added meanwhile', async () => {
    let fail: (e: unknown) => void = () => {};
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/pins/order' ? new Promise<Response>((_, reject) => { fail = reject; }) : Promise.resolve(new Response('{}', { status: 200 })))));
    await bootPinned();
    moveFirstDown(); // two, one
    server({ type: 'index', projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one'), entry('s2', 'two'), entry('s3', 'three')] }], pins: ['s3', 's2', 's1'] } as unknown as ServerMessage);
    await act(async () => { fail(new TypeError('Failed to fetch')); });
    expect(pinnedTitles()).toEqual(['three', 'one', 'two']);
    expect(document.querySelector('.toast-item')?.textContent).toContain('고정 순서 변경 실패');
  });

  it('puts the old order back with a Korean error when the save fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { if (url === '/api/pins/order') throw new TypeError('Failed to fetch'); return new Response('{}', { status: 200 }); }));
    await bootPinned();
    moveFirstDown();
    await waitFor(() => expect(document.querySelector('.toast-item')?.textContent).toContain('고정 순서 변경 실패: 네트워크 오류'));
    expect(pinnedTitles()).toEqual(['one', 'two']);
  });
});

describe('App ⌘1 … ⌘9 (고정됨)', () => {
  beforeEach(() => { localStorage.clear(); sock.frames = []; sock.onMessage = null; vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const bootPinned = async () => {
    render(<App />);
    await waitFor(() => expect(sock.onMessage).not.toBeNull());
    server({ type: 'hello', usage, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one'), entry('s2', 'two'), entry('s3', 'three')] }], pins: ['s2', 's1'], running: [], codex: { available: false } } as unknown as ServerMessage);
  };
  /** jsdom has no Mac platform: the modifier is Ctrl. Returns false when the key was taken (preventDefault). */
  const press = (n: number, extra: Record<string, unknown> = {}, target: Element | Window = window) => fireEvent.keyDown(target, { code: `Digit${n}`, key: String(n), ctrlKey: true, ...extra });
  const opened = () => frames().filter((f) => f.type === 'open_session').map((f) => (f as { sessionId: string }).sessionId);

  it('opens the nth pinned session in the active pane, in the sidebar order — also from the composer', async () => {
    await bootPinned();
    expect(press(1)).toBe(false);
    expect(opened()).toEqual(['s2']);
    expect(document.querySelector('.sidebar li.active .session-title')?.textContent).toBe('two');
    expect(press(2, {}, within(lastPane()).getByLabelText('메시지'))).toBe(false);
    expect(opened()).toEqual(['s2', 's1']);
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(1);
    expect(document.querySelector('.sidebar li.active .session-title')?.textContent).toBe('one');
  });

  it('follows the order the sidebar shows: a reorder and the 세션 검색 filter both renumber', async () => {
    await bootPinned();
    server({ type: 'index', projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one'), entry('s2', 'two'), entry('s3', 'three')] }], pins: ['s1', 's2'] } as unknown as ServerMessage);
    press(1);
    expect(opened()).toEqual(['s1']);
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'two' } });
    press(1);
    expect(opened()).toEqual(['s1', 's2']);
    expect(press(2)).toBe(true); // only one pinned row shows now
  });

  it('does nothing past the end of the list, with Shift / Alt, on a key repeat, or under a dialog — and leaves the key alone (a repeat excepted)', async () => {
    await bootPinned();
    expect(press(3)).toBe(true);
    expect(press(9)).toBe(true);
    expect(press(1, { shiftKey: true })).toBe(true);
    expect(press(1, { altKey: true })).toBe(true);
    expect(press(1, { repeat: true })).toBe(false); // a held key is kept from the browser, but opens nothing
    expect(press(1, { ctrlKey: false })).toBe(true);
    fireEvent.keyDown(window, { code: 'KeyK', key: 'k', ctrlKey: true });
    expect(screen.queryByRole('dialog', { name: '명령 팔레트' })).not.toBeNull();
    expect(press(1)).toBe(true);
    expect(opened()).toEqual([]);
  });
});

describe('App new build without a server restart', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    sock.frames = [];
    sock.onMessage = null;
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

  const bootWithBuild = async (build: string) => {
    render(<App />);
    await waitFor(() => expect(sock.onMessage).not.toBeNull());
    server({ type: 'hello', usage, projects: [], running: [], codex: { available: false }, build } as unknown as ServerMessage);
  };

  it('coming back to the page asks /api/build; a new id offers the 새 버전 pill, the same id or a failed fetch does not', async () => {
    let answer: () => Response = () => new Response(JSON.stringify({ build: 'b1' }), { status: 200 });
    const fetchMock = vi.fn(async (url: string) => (url === '/api/build' ? answer() : new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    sessionStorage.setItem('deck.reloadedFor', 'b2'); // already reloaded once for b2: the pill, not another reload
    await bootWithBuild('b1');
    const asked = () => fetchMock.mock.calls.filter((c) => c[0] === '/api/build').length;
    expect(asked()).toBe(0);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(asked()).toBe(1));
    expect(screen.queryByText(/새 버전이 있어요/)).toBeNull();
    answer = () => new Response('nope', { status: 500 });
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });
    await waitFor(() => expect(asked()).toBe(2));
    expect(screen.queryByText(/새 버전이 있어요/)).toBeNull();
    answer = () => new Response(JSON.stringify({ build: 'b2' }), { status: 200 });
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });
    expect(await screen.findByText(/새 버전이 있어요/)).toBeTruthy();
  });

  it('the avatar menu ends with 새로고침', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await bootWithBuild('b1');
    fireEvent.click(screen.getByRole('button', { name: '설정 및 계정' }));
    const labels = screen.getAllByRole('menuitem').map((b) => b.textContent ?? '');
    expect(labels).toHaveLength(5);
    expect(labels[0]).toMatch(/^설정/);
    expect(labels[1]).toBe('사용량 기록');
    expect(labels[2]).toMatch(/^테마: /);
    expect(labels[3]).toMatch(/^단축키/);
    expect(labels[4]).toBe('새로고침');
  });
});

describe('App boot', () => {
  beforeEach(() => { localStorage.clear(); sock.frames = []; sock.onMessage = null; vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('boot: an unreachable server is retried, not left at 확인 중…', async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementation(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByText('확인 중…')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await waitFor(() => expect(screen.queryByText('확인 중…')).toBeNull());
    expect(fetchFn.mock.calls.filter((c) => c[0] === '/api/me').length).toBe(2);
  });
});

describe('App error toasts', () => {
  beforeEach(() => { localStorage.clear(); sock.frames = []; sock.onMessage = null; vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const toasts = () => [...document.querySelectorAll('.toast-item')].map((e) => e.textContent);

  it('a server error shows as an error toast, not the old band', async () => {
    await boot();
    server({ type: 'error', turnId: null, message: '세션을 열 수 없습니다' } as ServerMessage);
    expect(screen.getByRole('alert').textContent).toContain('세션을 열 수 없습니다');
    expect(document.querySelector('.banner.error')).toBeNull();
  });

  it('"already resolved" replies (another device answered the card) show nothing', async () => {
    await boot();
    server({ type: 'error', turnId: null, message: '이미 처리된 권한 요청입니다', requestId: 'r1' } as ServerMessage);
    server({ type: 'error', turnId: null, message: '이미 처리된 질문입니다', requestId: 'q1' } as ServerMessage);
    expect(toasts()).toEqual([]);
    expect(document.body.textContent).not.toContain('이미 처리된');
  });

  it('two errors show two toasts, newest on top, and × closes one', async () => {
    await boot();
    server({ type: 'error', turnId: null, message: 'first' } as ServerMessage);
    server({ type: 'error', turnId: null, message: 'second' } as ServerMessage);
    expect(toasts()).toHaveLength(2);
    expect(toasts()[0]).toContain('second');
    fireEvent.click(screen.getAllByRole('button', { name: '닫기' })[0]!);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toContain('first');
  });

  it('the same error twice is two toasts (the slot is cleared once it becomes a toast)', async () => {
    await boot();
    server({ type: 'error', turnId: null, message: 'same' } as ServerMessage);
    server({ type: 'error', turnId: null, message: 'same' } as ServerMessage);
    expect(toasts()).toHaveLength(2);
  });
});
