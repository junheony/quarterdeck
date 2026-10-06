// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ClientMessage } from '../../shared/protocol';
import type { SessionEntry } from '../../shared/session-types';
import { initialState, reducer, type ChatItem, type PaneState } from '../state';
import { Chat, type ChatProps } from './Chat';
import { Pane } from './Pane';
import { Sidebar } from './Sidebar';

Element.prototype.scrollIntoView = () => {};
afterEach(cleanup);

const reply = (text: string): ChatItem => ({ kind: 'assistant', turnId: null, text, toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] });
const ITEMS: ChatItem[] = [{ kind: 'user', text: '첫 질문', n: 0 }, reply('답 0'), { kind: 'user', text: '두 번째', n: 1 }, reply('답 1')];

function renderChat(items: ChatItem[], extra: Partial<ChatProps> = {}) {
  const onSend = vi.fn();
  render(<Chat items={items} pending={[]} questions={[]} activeTurnId={null} busy={false} title="제목" model="opus" effort="high" engine="claude" sandbox="read-only" sessionEngine="claude" sessionSandbox={null} isNew={false} codexAvailable={false} attachments={[]} onSend={onSend} onInterrupt={() => {}} onDecide={() => {}} onAnswer={() => {}} onModel={() => {}} onEffort={() => {}} onEngine={() => {}} onSandbox={() => {}} onAttach={() => {}} onUnattach={() => {}} sessionId="s-1" {...extra} />);
  return onSend;
}
const editButtons = () => screen.getAllByRole('button', { name: '편집' });
const editor = () => screen.getByLabelText('메시지 편집') as HTMLTextAreaElement;

describe('메시지 편집 갈래 · inline edit', () => {
  it('편집 turns the bubble into an editor; Enter sends the edit for that message, Shift+Enter does not', () => {
    const onBranch = vi.fn();
    const onSend = renderChat(ITEMS, { onBranch });
    fireEvent.click(editButtons()[1]!);
    expect(editor().value).toBe('두 번째');
    fireEvent.change(editor(), { target: { value: '고친 두 번째' } });
    fireEvent.keyDown(editor(), { key: 'Enter', shiftKey: true });
    expect(onBranch).not.toHaveBeenCalled();
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(onBranch).toHaveBeenCalledWith(1, '고친 두 번째', '두 번째');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByTestId('inline-edit')).toBeNull();
  });

  it('IME: an Enter that commits a Korean syllable never sends', () => {
    const onBranch = vi.fn();
    renderChat(ITEMS, { onBranch });
    fireEvent.click(editButtons()[0]!);
    fireEvent.compositionStart(editor());
    fireEvent.keyDown(editor(), { key: 'Enter' });
    fireEvent.compositionEnd(editor());
    fireEvent.keyDown(editor(), { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(editor(), { key: 'Enter', isComposing: true });
    expect(onBranch).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByTestId('inline-edit')).getByRole('button', { name: '보내기' }));
    expect(onBranch).toHaveBeenCalledWith(0, '첫 질문', '첫 질문');
  });

  it('취소 and Esc restore the bubble without sending', () => {
    const onBranch = vi.fn();
    renderChat(ITEMS, { onBranch });
    fireEvent.click(editButtons()[0]!);
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.queryByTestId('inline-edit')).toBeNull();
    fireEvent.click(editButtons()[0]!);
    fireEvent.keyDown(editor(), { key: 'Escape' });
    expect(screen.queryByTestId('inline-edit')).toBeNull();
    expect(onBranch).not.toHaveBeenCalled();
  });

  it('fallback: without onBranch (GPT/Gemini) or a message position, 편집 fills the composer and the tooltip says why', () => {
    renderChat(ITEMS, { editNote: 'GPT·Gemini 세션은 대화를 갈라 편집할 수 없어 입력창에 넣습니다' });
    expect(editButtons()[0]!.getAttribute('title')).toContain('GPT·Gemini');
    fireEvent.click(editButtons()[0]!);
    expect(screen.queryByTestId('inline-edit')).toBeNull();
    expect((screen.getByPlaceholderText(/메시지 입력/) as HTMLTextAreaElement).value).toBe('첫 질문');
    cleanup();
    renderChat([{ kind: 'user', text: '위치 모름' }, reply('답')], { onBranch: vi.fn() });
    expect(editButtons()[0]!.getAttribute('title')).toContain('메시지 위치를 알 수 없어');
    fireEvent.click(editButtons()[0]!);
    expect(screen.queryByTestId('inline-edit')).toBeNull();
  });
});

describe('메시지 편집 갈래 · inline edit × 설정 / 권한 모드', () => {
  afterEach(() => localStorage.clear());

  it('설정 › Enter 동작 = ⌘Enter: plain Enter is a newline in the editor too, ⌘Enter sends', () => {
    localStorage.setItem('deck.prefs.v1', JSON.stringify({ sendKey: 'mod-enter' }));
    const onBranch = vi.fn();
    renderChat(ITEMS, { onBranch });
    fireEvent.click(editButtons()[1]!);
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(onBranch).not.toHaveBeenCalled();
    fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true });
    expect(onBranch).toHaveBeenCalledWith(1, '두 번째', '두 번째');
  });

  it('Shift+Tab cycles the permission mode only from the composer, never from the inline editor', () => {
    const onPermMode = vi.fn();
    renderChat(ITEMS, { onBranch: vi.fn(), permMode: 'default', onPermMode });
    fireEvent.click(editButtons()[0]!);
    fireEvent.keyDown(editor(), { key: 'Tab', shiftKey: true });
    expect(onPermMode).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByPlaceholderText(/메시지 입력/), { key: 'Tab', shiftKey: true });
    expect(onPermMode).toHaveBeenCalledTimes(1);
  });
});

describe('메시지 편집 갈래 · version switcher', () => {
  it('shows i/N under a message with versions and switches', () => {
    const go = vi.fn();
    renderChat(ITEMS, { versions: (n) => (n === 1 ? { index: 1, count: 2, go } : null) });
    const v = screen.getAllByTestId('msg-versions');
    expect(v).toHaveLength(1);
    expect(v[0]!.textContent).toContain('2/2');
    expect((screen.getByRole('button', { name: '다음 버전' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '이전 버전' }));
    expect(go).toHaveBeenCalledWith(0);
  });

  it('Pane: versions come from the index links; switching opens the sibling session', () => {
    const e = (sessionId: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({ sessionId, account: 'b', cwd: '/w', projectDir: '/p', file: '/f', title: '원본', lastModified: 1, sizeBytes: 1, ...extra });
    const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [e('R'), e('A', { branch: { parent: 'R', n: 1 } })] }];
    let s = reducer(initialState, { type: 'open', sessionId: 'A', cwd: '/w', title: '원본' });
    s = reducer(s, { type: 'server', msg: { type: 'history', sessionId: 'A', cwd: '/w', account: 'b', engine: 'claude', runningTurnId: null, messages: [{ kind: 'user', text: '첫 질문', ts: null, n: 0 }, { kind: 'user', text: '고친 두 번째', ts: null, n: 1 }] } });
    const onOpenSession = vi.fn();
    render(<Pane pane={s.panes[0]!} app={{ pending: [], questions: [], codexAvailable: false, projects }} active closable={false} dispatch={() => {}} send={() => {}} onClose={() => {}} onOpenSession={onOpenSession} />);
    expect(screen.getByTestId('msg-versions').textContent).toContain('2/2');
    fireEvent.click(screen.getByRole('button', { name: '이전 버전' }));
    expect(onOpenSession).toHaveBeenCalledWith('R', '/w', '원본');
  });

  it('Pane: a deleted (휴지통) version drops out of the switcher; its children still switch between themselves', () => {
    const e = (sessionId: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({ sessionId, account: 'b', cwd: '/w', projectDir: '/p', file: '/f', title: '원본', lastModified: 1, sizeBytes: 1, ...extra });
    const msgs = [{ kind: 'user' as const, text: '첫 질문', ts: null, n: 0 }, { kind: 'user' as const, text: '고친 두 번째', ts: null, n: 1 }];
    const open = (projects: { cwd: string; name: string; pinned: boolean; sessions: SessionEntry[] }[]) => {
      let s = reducer(initialState, { type: 'open', sessionId: 'A', cwd: '/w', title: '원본' });
      s = reducer(s, { type: 'server', msg: { type: 'history', sessionId: 'A', cwd: '/w', account: 'b', engine: 'claude', runningTurnId: null, messages: msgs } });
      const onOpenSession = vi.fn();
      render(<Pane pane={s.panes[0]!} app={{ pending: [], questions: [], codexAvailable: false, projects }} active closable={false} dispatch={() => {}} send={() => {}} onClose={() => {}} onOpenSession={onOpenSession} />);
      return onOpenSession;
    };
    // R (the root) was deleted; A and B both edited message 1 of it.
    const onOpenSession = open([{ cwd: '/w', name: 'w', pinned: false, sessions: [e('A', { branch: { parent: 'R', n: 1 } }), e('B', { branch: { parent: 'R', n: 1 } })] }]);
    expect(screen.getByTestId('msg-versions').textContent).toContain('1/2');
    fireEvent.click(screen.getByRole('button', { name: '다음 버전' }));
    expect(onOpenSession).toHaveBeenCalledWith('B', '/w', '원본');
    cleanup();
    // Only A is left: no switcher at all.
    open([{ cwd: '/w', name: 'w', pinned: false, sessions: [e('A', { branch: { parent: 'R', n: 1 } })] }]);
    expect(screen.queryByTestId('msg-versions')).toBeNull();
  });

  it('Pane: sending an edit makes the pane the new branch session and sends branch with the shown text', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 'R', cwd: '/w', title: '원본' });
    s = reducer(s, { type: 'server', msg: { type: 'history', sessionId: 'R', cwd: '/w', account: 'b', engine: 'claude', accountPin: 'c', runningTurnId: null, messages: [{ kind: 'user', text: '첫 질문', ts: null, n: 0 }, { kind: 'user', text: '두 번째', ts: null, n: 1 }] } });
    const sent: ClientMessage[] = [];
    let pane: PaneState = s.panes[0]!;
    const dispatch = (a: Parameters<typeof reducer>[1]) => { s = reducer(s, a); pane = s.panes[0]!; };
    render(<Pane pane={pane} app={{ pending: [], questions: [], codexAvailable: false, projects: [] }} active closable={false} dispatch={dispatch} send={(m) => sent.push(m)} onClose={() => {}} />);
    fireEvent.click(editButtons()[1]!);
    fireEvent.change(editor(), { target: { value: '고친 두 번째' } });
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(sent[0]).toMatchObject({ type: 'send', sessionId: null, cwd: '/w', text: '고친 두 번째', engine: 'claude', accountPin: 'c', branch: { from: 'R', n: 1, expect: '두 번째' } });
    expect(pane.session).toMatchObject({ sessionId: null, cwd: '/w', title: '원본', accountPin: 'c' });
    expect(pane.items).toEqual([{ kind: 'user', text: '첫 질문', n: 0 }, { kind: 'user', text: '고친 두 번째', n: 1 }]);
    expect(pane.awaitingStart).toBe(true);
  });

  it('Pane: a refused edit goes back to the original session', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 'R', cwd: '/w', title: '원본' });
    s = reducer(s, { type: 'server', msg: { type: 'history', sessionId: 'R', cwd: '/w', account: 'b', engine: 'claude', runningTurnId: null, messages: [{ kind: 'user', text: '첫 질문', ts: null, n: 0 }] } });
    const sent: ClientMessage[] = [];
    const dispatch = (a: Parameters<typeof reducer>[1]) => { s = reducer(s, a); };
    const onOpenSession = vi.fn();
    const ui = (pane: PaneState) => <Pane pane={pane} app={{ pending: [], questions: [], codexAvailable: false, projects: [] }} active closable={false} dispatch={dispatch} send={(m) => sent.push(m)} onClose={() => {}} onOpenSession={onOpenSession} />;
    const { rerender } = render(ui(s.panes[0]!));
    fireEvent.click(editButtons()[0]!);
    fireEvent.keyDown(editor(), { key: 'Enter' });
    rerender(ui(s.panes[0]!));
    expect(onOpenSession).not.toHaveBeenCalled();
    const ref = (sent[0] as { clientRef: string }).clientRef;
    dispatch({ type: 'server', msg: { type: 'error', turnId: null, message: '편집할 메시지를 기록에서 찾지 못해', clientRef: ref } });
    rerender(ui(s.panes[0]!));
    expect(onOpenSession).toHaveBeenCalledWith('R', '/w', '원본');
    // H1: the edited text goes back with it (the open that follows restores it, paused)
    expect(s.parked.R!.queue.map((q) => q.text)).toEqual(['첫 질문']);
  });
});

describe('메시지 편집 갈래 · state', () => {
  it('live messages carry the next ordinal; another device’s echo too', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 'R', cwd: '/w', title: 't' });
    s = reducer(s, { type: 'server', msg: { type: 'history', sessionId: 'R', cwd: '/w', account: 'b', runningTurnId: null, messages: [{ kind: 'user', text: 'q', ts: null, n: 41 }] } });
    s = reducer(s, { type: 'sent', text: 'next', clientRef: 'r1' });
    expect(s.panes[0]!.items.at(-1)).toMatchObject({ text: 'next', n: 42 });
    s = reducer(s, { type: 'server', msg: { type: 'turn_started', turnId: 't1', sessionId: 'R', cwd: '/w', account: 'b', model: 'opus', reason: '', attempt: 0, clientRef: 'r1' } });
    s = reducer(s, { type: 'server', msg: { type: 'turn_result', turnId: 't1', sessionId: 'R', cwd: '/w', ok: true, text: '', badge: null, errorText: null } });
    s = reducer(s, { type: 'server', msg: { type: 'turn_started', turnId: 't2', sessionId: 'R', cwd: '/w', account: 'b', model: 'opus', reason: '', attempt: 0, prompt: { text: 'other device', attachments: [] } } });
    expect(s.panes[0]!.items.filter((it) => it.kind === 'user').at(-1)).toMatchObject({ text: 'other device', n: 43 });
  });
});

describe('메시지 편집 갈래 · sidebar', () => {
  const e = (sessionId: string, title: string, lastModified: number, extra: Partial<SessionEntry> = {}): SessionEntry => ({ sessionId, account: 'b', cwd: '/w', projectDir: '/p', file: '/f', title, lastModified, sizeBytes: 1, ...extra });
  const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [e('B', '원본', 30, { branch: { parent: 'R', n: 1 } }), e('X', '다른 세션', 20), e('A', '원본', 15, { branch: { parent: 'R', n: 1 } }), e('R', '원본', 10)] }];

  it('one row per branch tree (the root), opening the newest version; active for any version', () => {
    const onOpen = vi.fn();
    render(<Sidebar projects={projects} currentSessionId="A" onOpen={onOpen} onNew={() => {}} onRefresh={() => {}} />);
    const rows = [...document.querySelectorAll('.project li')];
    expect(rows.map((r) => r.querySelector('.session-title')?.textContent)).toEqual(['원본', '다른 세션']);
    expect(rows[0]!.className).toContain('active');
    expect(rows[0]!.textContent).toContain('갈래 3');
    fireEvent.click(rows[0]!);
    expect(onOpen).toHaveBeenCalledWith('B', '/w', '원본');
  });

  it('the row menu acts on the version a click opens (the newest) and names it', () => {
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    const onRename = vi.fn();
    const now = Date.now();
    const tree = [{ cwd: '/w', name: 'w', pinned: false, sessions: [e('B', '원본 B', now - 120_000, { branch: { parent: 'R', n: 1 } }), e('A', '원본 A', now - 600_000, { branch: { parent: 'R', n: 1 } }), e('R', '원본', now - 3_600_000)] }];
    render(<Sidebar projects={tree} currentSessionId={null} onOpen={() => {}} onNew={() => {}} onRefresh={() => {}} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />);
    const row = document.querySelector('.project li')!;
    expect(row.querySelector('.session-title')?.textContent).toBe('원본 B');
    fireEvent.click(screen.getByLabelText('세션 메뉴'));
    expect(screen.getByTestId('session-menu-which').textContent).toBe('갈래 3/3 · 2분 전 수정');
    fireEvent.click(screen.getByText('보관'));
    expect(onArchive).toHaveBeenCalledWith('B', true);
    fireEvent.click(screen.getByLabelText('세션 메뉴'));
    fireEvent.click(screen.getByText('삭제…'));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'B' }), '갈래 3/3 · 2분 전 수정');
    fireEvent.click(screen.getByLabelText('세션 메뉴'));
    fireEvent.click(screen.getByText('이름 바꾸기'));
    const box = screen.getByLabelText('세션 이름') as HTMLInputElement;
    expect(box.value).toBe('원본 B');
    fireEvent.change(box, { target: { value: '새 이름' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('B', '새 이름');
    cleanup();
  });

  it('a deleted root: the remaining versions still group as one row (under the oldest left), in both views', () => {
    const left = [{ cwd: '/w', name: 'w', pinned: false, sessions: projects[0]!.sessions.filter((x) => x.sessionId !== 'R') }];
    for (const view of ['projects', 'recent'] as const) {
      const onOpen = vi.fn();
      render(<Sidebar projects={left} currentSessionId={null} onOpen={onOpen} onNew={() => {}} onRefresh={() => {}} view={view} onViewChange={() => {}} />);
      const rows = [...document.querySelectorAll('.project li')];
      expect(rows.map((r) => r.querySelector('.session-title')?.textContent)).toEqual(['원본', '다른 세션']);
      expect(rows[0]!.textContent).toContain('갈래 2');
      fireEvent.click(rows[0]!);
      expect(onOpen).toHaveBeenCalledWith('B', '/w', '원본');
      cleanup();
    }
  });
});
