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
    return { send: (m: unknown) => { sock.frames.push(m); }, close: () => {} };
  },
}));

import { App } from './App';

const usage = { generatedAt: 'x', deckReachable: true, accounts: { a: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, b: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, c: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null } } } as const;
const T = Date.now();
const entry = (sessionId: string, title: string, ago: number) => ({ sessionId, account: 'b' as const, cwd: '/w', projectDir: '/p', title, lastModified: T - ago, sizeBytes: 1 });
const OLD = 400 * 86_400_000;

async function boot() {
  render(<App />);
  await waitFor(() => expect(sock.onMessage).not.toBeNull());
  server({ type: 'hello', usage, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one', 0), entry('s2', 'two', 1000), entry('s3', 'ancient', OLD)] }], running: [], codex: { available: false } } as unknown as ServerMessage);
}
function server(msg: ServerMessage) { act(() => sock.onMessage!(msg)); }
const frames = () => sock.frames as ClientMessage[];
const opened = () => frames().filter((f) => f.type === 'open_session').map((f) => (f as { sessionId: string }).sessionId);
const sidebar = () => document.querySelector('.sidebar') as HTMLElement;
/** jsdom has no Mac platform: the modifier is Ctrl. */
const press = (code: string, extra: Record<string, unknown> = {}, target: EventTarget = window) => fireEvent.keyDown(target, { code, key: '', ctrlKey: true, ...extra });
let fetchMock: ReturnType<typeof vi.fn>;

describe('desktop-like navigation', () => {
  beforeEach(() => {
    localStorage.clear();
    sock.frames = [];
    sock.onMessage = null;
    fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/session-trash') return new Response(JSON.stringify({ ok: true, trashId: `20261002-120000-s2` }), { status: 200 });
      if (url === '/api/session-trash/restore') return new Response(JSON.stringify({ ok: true, sessionId: 's2' }), { status: 200 });
      if (String(url).startsWith('/api/search')) return new Response(JSON.stringify({ hits: [], truncated: false }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('Ctrl+K palette: fuzzy session search, arrows + Enter open it, Esc closes, Enter mid-IME is ignored', async () => {
    await boot();
    press('KeyK');
    const input = screen.getByLabelText('세션 검색 또는 명령');
    fireEvent.change(input, { target: { value: 'tw' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(screen.queryByRole('dialog', { name: '명령 팔레트' })).not.toBeNull();
    const options = screen.getAllByRole('option');
    expect(options[0]!.textContent).toContain('two');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('dialog', { name: '명령 팔레트' })).toBeNull();
    expect(opened()).toEqual(['s2']);

    press('KeyK');
    fireEvent.change(screen.getByLabelText('세션 검색 또는 명령'), { target: { value: '사용량' } });
    fireEvent.keyDown(screen.getByLabelText('세션 검색 또는 명령'), { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: '토큰 사용량' })).toBeTruthy();
  });

  it('palette actions dispatch the settings / theme events; Esc and Ctrl+K close it', async () => {
    await boot();
    const seen: string[] = [];
    const on = (e: Event) => seen.push(e.type);
    window.addEventListener('deck:open-settings', on);
    window.addEventListener('deck:cycle-theme', on);
    press('KeyK');
    fireEvent.click(screen.getByText('설정 열기'));
    press('KeyK');
    fireEvent.click(screen.getByText('테마 전환'));
    expect(seen).toEqual(['deck:open-settings', 'deck:cycle-theme']);
    press('KeyK');
    fireEvent.keyDown(screen.getByLabelText('세션 검색 또는 명령'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    press('KeyK');
    press('KeyK', {}, screen.getByLabelText('세션 검색 또는 명령'));
    expect(screen.queryByRole('dialog')).toBeNull();
    window.removeEventListener('deck:open-settings', on);
    window.removeEventListener('deck:cycle-theme', on);
  });

  it('설정 열기 opens Settings, 테마 전환 cycles 시스템 → 라이트 → 다크 → 시스템, Ctrl+, toggles Settings', async () => {
    await boot();
    press('KeyK');
    fireEvent.click(screen.getByText('설정 열기'));
    expect(screen.getByRole('dialog', { name: '설정' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull();
    const theme = () => document.documentElement.getAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme'); // an earlier test's 테마 전환 (prefs were reset by localStorage.clear)
    for (const want of ['light', 'dark', null]) {
      press('KeyK');
      fireEvent.click(screen.getByText('테마 전환'));
      expect(theme()).toBe(want);
    }
    press('Comma');
    expect(screen.getByRole('dialog', { name: '설정' })).toBeTruthy();
    press('Comma');
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull();
    press('Slash');
    const help = screen.getByRole('dialog', { name: '단축키' }).textContent ?? '';
    expect(help).toContain('Ctrl+,');
    expect(help).toContain('⇧Tab');
  });

  it('Ctrl+/ cheat sheet, Ctrl+\\ hides the sidebar, Ctrl+] / Ctrl+[ walk the list (not from a text field)', async () => {
    await boot();
    press('Slash');
    expect(screen.getByRole('dialog', { name: '단축키' }).textContent).toContain('Ctrl+K');
    press('BracketRight'); // blocked while a dialog is open
    expect(opened()).toEqual([]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    press('Backslash');
    expect(document.querySelector('.sidebar-wrap')!.classList.contains('hidden')).toBe(true);
    press('Backslash');
    expect(document.querySelector('.sidebar-wrap')!.classList.contains('hidden')).toBe(false);

    press('BracketRight'); // nothing open → the newest
    press('BracketRight');
    expect(opened()).toEqual(['s1', 's2']);
    press('BracketLeft', {}, screen.getByPlaceholderText(/메시지/));
    expect(opened()).toEqual(['s1', 's2']);
    press('BracketLeft');
    expect(opened()).toEqual(['s1', 's2', 's1']);
  });

  it('Ctrl+N: the pane shows the new-chat screen for its project; the start box opens and sends', async () => {
    await boot();
    fireEvent.click(within(sidebar()).getByText('one'));
    press('KeyN');
    const pane = screen.getAllByTestId(/^pane-/)[0]!;
    expect((within(pane).getByLabelText('프로젝트') as HTMLSelectElement).value).toBe('/w');
    expect(within(pane).getByText('two')).toBeTruthy(); // recent card
    const box = within(pane).getByLabelText('첫 메시지');
    fireEvent.change(box, { target: { value: '안녕' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(frames().some((f) => f.type === 'send')).toBe(false);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(frames().find((f) => f.type === 'send')).toMatchObject({ type: 'send', sessionId: null, cwd: '/w', text: '안녕' });
  });

  it('new-chat screen: an attachment picked before the first message rides its send frame', async () => {
    fetchMock.mockImplementation(async (url: string) => (url === '/api/attachments'
      ? new Response(JSON.stringify({ id: 'att-1', name: 'shot.png', size: 1, isImage: true }), { status: 200 })
      : new Response('{}', { status: 200 })));
    await boot();
    const pane = screen.getAllByTestId(/^pane-/)[0]!;
    fireEvent.change(within(pane).getByTestId('attachment-gallery'), { target: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] } });
    await waitFor(() => expect(within(pane).getByText(/shot\.png/)).toBeTruthy());
    const box = within(pane).getByLabelText('첫 메시지');
    fireEvent.change(box, { target: { value: '봐줘' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(frames().find((f) => f.type === 'send')).toMatchObject({ type: 'send', sessionId: null, cwd: '/w', text: '봐줘', attachments: ['att-1'] });
  });

  it('sidebar 최근 view groups by date; 삭제 asks, moves to trash, offers undo', async () => {
    await boot();
    expect(within(sidebar()).getByTestId('date-group-오늘').textContent).toContain('two');
    expect(within(sidebar()).getByTestId('date-group-이전').textContent).toContain('ancient');
    fireEvent.click(within(sidebar()).getByText('프로젝트'));
    expect(within(sidebar()).queryByTestId('date-group-오늘')).toBeNull();
    expect(localStorage.getItem('deck.sidebarView')).toBe('projects');
    fireEvent.click(within(sidebar()).getByText('최근'));

    const row = within(sidebar()).getByText('two').closest('li')!;
    fireEvent.click(within(row).getByLabelText('세션 메뉴'));
    fireEvent.click(within(row).getByText('삭제…'));
    const dlg = screen.getByRole('alertdialog', { name: '대화 삭제' });
    fireEvent.click(within(dlg).getByText('삭제'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('삭제됨'));
    expect(fetchMock.mock.calls.find((c) => c[0] === '/api/session-trash')![1]).toMatchObject({ method: 'POST', body: JSON.stringify({ sessionId: 's2' }) });
    fireEvent.click(screen.getByText('되돌리기'));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === '/api/session-trash/restore')).toBe(true));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('refuses 삭제 of a session with a turn running here', async () => {
    await boot();
    fireEvent.click(within(sidebar()).getByText('two'));
    server({ type: 'history', sessionId: 's2', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [] } as ServerMessage);
    fireEvent.change(screen.getByPlaceholderText(/메시지/), { target: { value: 'go' } });
    fireEvent.click(screen.getByText('보내기'));
    const row = within(sidebar()).getByText('two').closest('li')!;
    fireEvent.click(within(row).getByLabelText('세션 메뉴'));
    fireEvent.click(within(row).getByText('삭제…'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText(/실행 중인 대화는 삭제할 수 없어요/)).toBeTruthy();
  });
});
