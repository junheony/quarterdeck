// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useReducer } from 'react';
import type { ClientMessage, ServerMessage } from '../../shared/protocol';
import { newPane, nextQueued, reducer, initialState, type AppState, type ChatItem } from '../state';
import { AttachmentBar } from './AttachmentBar';
import { Chat, type ChatProps } from './Chat';
import { MessageView } from './MessageView';
import { Pane, STEER_ANSWER_MS, useQueueRunner } from './Pane';

Element.prototype.scrollIntoView = () => {};

const base = (extra: Partial<ChatProps> = {}) => (
  <Chat items={[]} pending={[]} questions={[]} activeTurnId="t1" busy title="t" model="opus" effort="high" engine="claude" sandbox="read-only" sessionEngine={null} sessionSandbox={null} isNew={false} codexAvailable={false} attachments={[]} onSend={() => {}} onInterrupt={() => {}} onDecide={() => {}} onAnswer={() => {}} onModel={() => {}} onEffort={() => {}} onEngine={() => {}} onSandbox={() => {}} onAttach={() => {}} onUnattach={() => {}} {...extra} />
);
const todoTurn = (todos: unknown[]): ChatItem => ({ kind: 'assistant', turnId: null, text: '', toolCalls: [{ toolUseId: 'u1', name: 'TodoWrite', input: { todos }, result: 'ok', isError: false }], badge: null, streaming: false, error: null, notes: [], attempts: [] });

describe('composer queue (ux-state)', () => {
  afterEach(cleanup);

  it('while a turn runs, ⌘Enter / the + button queue the message instead of sending; stop stays', () => {
    const onSend = vi.fn();
    const onQueue = vi.fn();
    render(base({ onSend, onQueue }));
    const box = screen.getByLabelText('메시지');
    expect((box as HTMLTextAreaElement).disabled).toBe(false);
    fireEvent.change(box, { target: { value: 'next one' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(onQueue).toHaveBeenCalledWith('next one');
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: 'another' } });
    fireEvent.click(screen.getByText('대기열에 추가'));
    expect(onQueue).toHaveBeenLastCalledWith('another');
    expect(screen.getByTitle('중단')).toBeTruthy();
  });

  it('queue chips: click to edit, ✕ removes, 모두 지우기 clears, 이어서 보내기 only when paused', () => {
    const onQueueEdit = vi.fn();
    const onQueueRemove = vi.fn();
    const onQueueClear = vi.fn();
    const onQueueResume = vi.fn();
    const queue = [{ id: 'q1', text: 'first', attachments: [] }, { id: 'q2', text: 'second', attachments: [] }];
    const { rerender } = render(base({ queue, queuePaused: false, onQueue: () => {}, onQueueEdit, onQueueRemove, onQueueClear, onQueueResume }));
    expect(screen.getByTestId('queue').textContent).toContain('대기열 2');
    expect(screen.queryByText('이어서 보내기')).toBeNull();
    fireEvent.click(screen.getByText('first'));
    const input = screen.getByLabelText('대기 메시지 1 수정');
    fireEvent.change(input, { target: { value: 'first (edited)' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onQueueEdit).toHaveBeenCalledWith('q1', 'first (edited)');
    fireEvent.click(screen.getByLabelText('대기 메시지 2 삭제'));
    expect(onQueueRemove).toHaveBeenCalledWith('q2');
    fireEvent.click(screen.getByText('모두 지우기'));
    expect(onQueueClear).toHaveBeenCalled();
    rerender(base({ queue, queuePaused: true, onQueue: () => {}, onQueueResume }));
    expect(screen.getByTestId('queue').textContent).toContain('대기열 멈춤');
    fireEvent.click(screen.getByText('이어서 보내기'));
    expect(onQueueResume).toHaveBeenCalled();
  });

  it('Pane: a mode picked during a new session\'s first turn is sent once the id arrives', () => {
    const send = vi.fn<(m: ClientMessage) => void>();
    const start: AppState = { ...initialState, connected: true, defaultPermMode: 'default', panes: [{ ...newPane('p0'), session: { sessionId: null, cwd: '/w', account: null, title: 't', engine: 'claude', sandbox: null } }] };
    let dispatchOut: (a: Parameters<typeof reducer>[1]) => void = () => {};
    let state = start;
    function Harness() {
      const [s, dispatch] = useReducer(reducer, start);
      dispatchOut = dispatch;
      state = s;
      useQueueRunner(s.panes, s.connected, dispatch, send, s.defaultPermMode);
      return <Pane pane={s.panes[0]!} app={s} active closable={false} dispatch={dispatch} send={send} onClose={() => {}} />;
    }
    render(<Harness />);
    const server = (msg: ServerMessage) => act(() => dispatchOut({ type: 'server', msg }));
    fireEvent.change(screen.getByLabelText('메시지'), { target: { value: 'one' } });
    fireEvent.click(screen.getByText('보내기'));
    const ref1 = (send.mock.lastCall![0] as { clientRef: string }).clientRef;
    server({ type: 'turn_started', turnId: 't1', sessionId: null, cwd: '/w', clientRef: ref1 } as ServerMessage);
    fireEvent.change(screen.getByTestId('perm-select'), { target: { value: 'plan' } });
    expect(send.mock.calls.some(([m]) => m.type === 'set_permission_mode')).toBe(false);
    server({ type: 'turn_result', turnId: 't1', sessionId: 'n1', cwd: '/w', ok: true, text: 'done', badge: null, errorText: null });
    expect(send).toHaveBeenLastCalledWith({ type: 'set_permission_mode', sessionId: 'n1', mode: 'plan' });
    expect(send.mock.calls.filter(([m]) => m.type === 'set_permission_mode')).toHaveLength(1);
    expect(state.panes[0]!.session).toMatchObject({ sessionId: 'n1', permissionMode: 'plan' });
    expect(state.panes[0]!.session?.permissionModePending).toBeUndefined();
    // The server's announcement of the turn's mode, then its echo of the pick: the pane ends on the pick.
    server({ type: 'permission_mode', sessionId: 'n1', mode: 'default' });
    server({ type: 'permission_mode', sessionId: 'n1', mode: 'plan' });
    expect(state.panes[0]!.session?.permissionMode).toBe('plan');
    // Once synced, the server's broadcasts apply again.
    server({ type: 'permission_mode', sessionId: 'n1', mode: 'acceptEdits' });
    expect(state.panes[0]!.session?.permissionMode).toBe('acceptEdits');
  });

  it('Pane (Codex): the next queued message goes out by itself when the turn ends; stop pauses the queue', () => {
    const send = vi.fn<(m: ClientMessage) => void>();
    const start: AppState = { ...initialState, connected: true, panes: [{ ...newPane('p0'), session: { sessionId: 's1', cwd: '/w', account: 'gpt', title: 't', engine: 'codex', sandbox: 'workspace-write' } }] };
    let dispatchOut: (a: Parameters<typeof reducer>[1]) => void = () => {};
    function Harness() {
      const [s, dispatch] = useReducer(reducer, start);
      dispatchOut = dispatch;
      useQueueRunner(s.panes, s.connected, dispatch, send);
      return <Pane pane={s.panes[0]!} app={s} active closable={false} dispatch={dispatch} send={send} onClose={() => {}} />;
    }
    render(<Harness />);
    const server = (msg: ServerMessage) => act(() => dispatchOut({ type: 'server', msg }));
    fireEvent.change(screen.getByLabelText('메시지'), { target: { value: 'one' } });
    fireEvent.click(screen.getByText('보내기'));
    const ref1 = (send.mock.lastCall![0] as { clientRef: string }).clientRef;
    server({ type: 'turn_started', turnId: 't1', sessionId: 's1', cwd: '/w', engine: 'codex', clientRef: ref1 } as ServerMessage);
    fireEvent.change(screen.getByLabelText('메시지'), { target: { value: 'two' } });
    fireEvent.keyDown(screen.getByLabelText('메시지'), { key: 'Enter', ctrlKey: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('queue').textContent).toContain('two');
    server({ type: 'turn_result', turnId: 't1', sessionId: 's1', cwd: '/w', ok: true, text: 'done', badge: null, errorText: null });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.lastCall![0]).toMatchObject({ type: 'send', text: 'two', sessionId: 's1' });
    expect(screen.queryByTestId('queue')).toBeNull();
    // stop with a queued message: interrupt goes out, the queue stays and does not fire
    const ref2 = (send.mock.lastCall![0] as { clientRef: string }).clientRef;
    server({ type: 'turn_started', turnId: 't2', sessionId: 's1', cwd: '/w', engine: 'codex', clientRef: ref2 } as ServerMessage);
    fireEvent.change(screen.getByLabelText('메시지'), { target: { value: 'three' } });
    fireEvent.keyDown(screen.getByLabelText('메시지'), { key: 'Enter', ctrlKey: true });
    fireEvent.click(screen.getByTitle('중단'));
    expect(send.mock.lastCall![0]).toEqual({ type: 'interrupt', turnId: 't2' });
    server({ type: 'turn_result', turnId: 't2', sessionId: 's1', cwd: '/w', ok: false, text: '', badge: null, errorText: '중단됨' });
    expect(send).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('queue').textContent).toContain('대기열 멈춤');
    fireEvent.click(screen.getByText('이어서 보내기'));
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.lastCall![0]).toMatchObject({ type: 'send', text: 'three' });
  });

  it('Pane (Codex): 지금 전송 interrupts the turn and sends that item first; the rest of the queue follows', () => {
    const send = vi.fn<(m: ClientMessage) => void>();
    const start: AppState = { ...initialState, connected: true, panes: [{ ...newPane('p0'), session: { sessionId: 's1', cwd: '/w', account: 'gpt', title: 't', engine: 'codex', sandbox: 'workspace-write' } }] };
    let dispatchOut: (a: Parameters<typeof reducer>[1]) => void = () => {};
    function Harness() {
      const [s, dispatch] = useReducer(reducer, start);
      dispatchOut = dispatch;
      useQueueRunner(s.panes, s.connected, dispatch, send);
      return <Pane pane={s.panes[0]!} app={s} active closable={false} dispatch={dispatch} send={send} onClose={() => {}} />;
    }
    render(<Harness />);
    const server = (msg: ServerMessage) => act(() => dispatchOut({ type: 'server', msg }));
    const box = () => screen.getByLabelText('메시지');
    fireEvent.change(box(), { target: { value: 'one' } });
    fireEvent.click(screen.getByText('보내기'));
    const ref1 = (send.mock.lastCall![0] as { clientRef: string }).clientRef;
    server({ type: 'turn_started', turnId: 't1', sessionId: 's1', cwd: '/w', engine: 'codex', clientRef: ref1 } as ServerMessage);
    for (const t of ['two', 'three']) {
      fireEvent.change(box(), { target: { value: t } });
      fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    }
    fireEvent.click(screen.getByLabelText('대기 메시지 2 지금 전송'));
    expect(send.mock.lastCall![0]).toEqual({ type: 'interrupt', turnId: 't1' });
    expect(send).toHaveBeenCalledTimes(2);
    server({ type: 'turn_result', turnId: 't1', sessionId: 's1', cwd: '/w', ok: false, text: '', badge: null, errorText: '중단됨' });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.lastCall![0]).toMatchObject({ type: 'send', text: 'three', sessionId: 's1' });
    expect(screen.getByTestId('queue').textContent).toContain('two');
    const ref3 = (send.mock.lastCall![0] as { clientRef: string }).clientRef;
    server({ type: 'turn_started', turnId: 't3', sessionId: 's1', cwd: '/w', engine: 'codex', clientRef: ref3 } as ServerMessage);
    server({ type: 'turn_result', turnId: 't3', sessionId: 's1', cwd: '/w', ok: true, text: 'ok', badge: null, errorText: null });
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.lastCall![0]).toMatchObject({ type: 'send', text: 'two' });
  });

  function claudeHarness() {
    const send = vi.fn<(m: ClientMessage) => unknown>();
    const start: AppState = { ...initialState, connected: true, panes: [{ ...newPane('p0'), session: { sessionId: 's1', cwd: '/w', account: null, title: 't', engine: 'claude', sandbox: null } }] };
    let dispatchOut: (a: Parameters<typeof reducer>[1]) => void = () => {};
    let state = start;
    function Harness() {
      const [s, dispatch] = useReducer(reducer, start);
      dispatchOut = dispatch;
      state = s;
      useQueueRunner(s.panes, s.connected, dispatch, send);
      return <Pane pane={s.panes[0]!} app={s} active closable={false} dispatch={dispatch} send={send} onClose={() => {}} />;
    }
    render(<Harness />);
    const server = (msg: ServerMessage) => act(() => dispatchOut({ type: 'server', msg }));
    const box = () => screen.getByLabelText('메시지');
    fireEvent.change(box(), { target: { value: 'one' } });
    fireEvent.click(screen.getByText('보내기'));
    const ref1 = (send.mock.lastCall![0] as { clientRef: string }).clientRef;
    server({ type: 'turn_started', turnId: 't1', sessionId: 's1', cwd: '/w', engine: 'claude', clientRef: ref1 } as ServerMessage);
    return { send, server, box, pane: () => state.panes[0]! };
  }

  it('Pane (Claude): Enter during a running turn sends a steer; 전달 대기 until delivered, then a user bubble at that point', () => {
    const { send, server, box, pane } = claudeHarness();
    server({ type: 'delta', turnId: 't1', sessionId: 's1', cwd: '/w', text: 'working' });
    fireEvent.change(box(), { target: { value: 'also check b' } });
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    expect(send).toHaveBeenCalledTimes(2);
    const steer = send.mock.lastCall![0] as Extract<ClientMessage, { type: 'steer' }>;
    expect(steer).toMatchObject({ type: 'steer', turnId: 't1', text: 'also check b' });
    expect(steer.steerId).toBeTruthy();
    expect(screen.getByTestId('queue').textContent).toContain('보냄 · 다음 단계에서 반영');
    expect(screen.getByTestId('queue').textContent).toContain('실행 중에 보냄');
    expect(screen.getByText('멈추고 지금 보내기')).toBeTruthy();
    // Pending steer: the queue runner must not resend it when the turn ends.
    server({ type: 'steer_delivered', turnId: 't1', sessionId: 's1', cwd: '/w', steerId: steer.steerId, prompt: { text: 'also check b', attachments: [] } });
    expect(screen.queryByTestId('queue')).toBeNull();
    server({ type: 'delta', turnId: 't1', sessionId: 's1', cwd: '/w', text: 'done b' });
    const items = pane().items;
    expect(items.map((it) => it.kind === 'user' ? `u:${it.text}` : `a:${(it as { text: string }).text}`)).toEqual(['u:one', 'a:working', 'u:also check b', 'a:done b']);
    server({ type: 'turn_result', turnId: 't1', sessionId: 's1', cwd: '/w', ok: true, text: 'done b', badge: null, errorText: null });
    expect(send).toHaveBeenCalledTimes(2);
    expect(pane().items.filter((it) => it.kind === 'assistant' && (it as { streaming: boolean }).streaming)).toHaveLength(0);
  });

  it('Pane (Claude): a refused steer stays queued and goes out after the turn; another device shows a delivered steer from its prompt', () => {
    const { send, server, box, pane } = claudeHarness();
    fireEvent.change(box(), { target: { value: 'later please' } });
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    const steer = send.mock.lastCall![0] as Extract<ClientMessage, { type: 'steer' }>;
    server({ type: 'turn_result', turnId: 't1', sessionId: 's1', cwd: '/w', ok: true, text: 'ok', badge: null, errorText: null });
    expect(send).toHaveBeenCalledTimes(2);
    server({ type: 'steer_rejected', turnId: 't1', sessionId: 's1', cwd: '/w', steerId: steer.steerId, message: 'no' });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.lastCall![0]).toMatchObject({ type: 'send', text: 'later please', sessionId: 's1' });
    // Someone else's steer into this session's running turn: shown from the server's prompt.
    const ref = (send.mock.lastCall![0] as { clientRef: string }).clientRef;
    server({ type: 'turn_started', turnId: 't2', sessionId: 's1', cwd: '/w', engine: 'claude', clientRef: ref } as ServerMessage);
    server({ type: 'steer_delivered', turnId: 't2', sessionId: 's1', cwd: '/w', steerId: 'other-1', prompt: { text: 'from phone', attachments: [] } });
    expect(pane().items.some((it) => it.kind === 'user' && it.text === 'from phone')).toBe(true);
  });

  it('Pane (Claude): 지금 전송 on a pending steer interrupts; the rejected steer then goes out first', () => {
    const { send, server, box, pane } = claudeHarness();
    fireEvent.change(box(), { target: { value: 'urgent' } });
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    const steer = send.mock.lastCall![0] as Extract<ClientMessage, { type: 'steer' }>;
    fireEvent.click(screen.getByLabelText('대기 메시지 1 멈추고 지금 보내기'));
    expect(send.mock.lastCall![0]).toEqual({ type: 'interrupt', turnId: 't1' });
    // An older server still sends the SDK's own abort text: no "오류:" line for a stop the user asked for.
    server({ type: 'turn_result', turnId: 't1', sessionId: 's1', cwd: '/w', ok: false, text: '', badge: { account: 'b', model: 'opus', reason: 'r', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, modelNote: null }, errorText: 'Claude Code process aborted by user' });
    expect(document.querySelector('.msg.assistant .error')).toBeNull();
    // The turn is marked as interrupted by this client: any error text it ends with is the stop.
    expect(pane().items.some((it) => it.kind === 'assistant' && it.turnId === 't1' && it.interrupted)).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
    server({ type: 'steer_rejected', turnId: 't1', sessionId: 's1', cwd: '/w', steerId: steer.steerId, message: 'closed' });
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.lastCall![0]).toMatchObject({ type: 'send', text: 'urgent' });
  });

  it('Pane (Claude): a steer re-sent after history (replay) is not shown twice when the transcript already has it', () => {
    const { server, pane } = claudeHarness();
    const users = () => pane().items.filter((it) => it.kind === 'user').map((it) => (it as { text: string }).text);
    server({ type: 'steer_delivered', turnId: 't1', sessionId: 's1', cwd: '/w', steerId: 'x1', prompt: { text: 'one', attachments: [] }, replay: true });
    expect(users()).toEqual(['one']);
    server({ type: 'steer_delivered', turnId: 't1', sessionId: 's1', cwd: '/w', steerId: 'x2', prompt: { text: 'not logged yet', attachments: [] }, replay: true });
    expect(users()).toEqual(['one', 'not logged yet']);
  });

  it('Pane (Claude): a steer the socket could not send is an ordinary queue item at once', () => {
    const { send, server, box } = claudeHarness();
    send.mockReturnValueOnce(false);
    fireEvent.change(box(), { target: { value: 'offline' } });
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    expect(send.mock.lastCall![0]).toMatchObject({ type: 'steer' });
    expect(screen.getByTestId('queue').textContent).not.toContain('전달 대기');
    server({ type: 'turn_result', turnId: 't1', sessionId: 's1', cwd: '/w', ok: true, text: 'ok', badge: null, errorText: null });
    expect(send.mock.lastCall![0]).toMatchObject({ type: 'send', text: 'offline' });
  });

  it('Pane (Claude): a reconnect turns in-flight steers back into paused queue items; a late delivery still drops it', () => {
    const { send, server, box, pane } = claudeHarness();
    fireEvent.change(box(), { target: { value: 'lost' } });
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    const steer = send.mock.lastCall![0] as Extract<ClientMessage, { type: 'steer' }>;
    server({ type: 'hello', usage: { accounts: [] }, projects: [], running: [{ turnId: 't1', sessionId: 's1' }], codex: { available: false } } as unknown as ServerMessage);
    expect(pane().queue[0]).toMatchObject({ text: 'lost', lostSteer: steer.steerId });
    expect(pane().queue[0]!.steer).toBeUndefined();
    expect(screen.getByTestId('queue').textContent).toContain('대기열 멈춤');
    server({ type: 'steer_delivered', turnId: 't1', sessionId: 's1', cwd: '/w', steerId: steer.steerId, prompt: { text: 'lost', attachments: [] } });
    expect(pane().queue).toHaveLength(0);
    expect(pane().items.filter((it) => it.kind === 'user' && it.text === 'lost')).toHaveLength(1);
  });

  it('Pane (Claude): a steer unanswered STEER_ANSWER_MS after its turn ended becomes a paused queue item (no deadlock)', () => {
    vi.useFakeTimers();
    try {
      const { send, server, box, pane } = claudeHarness();
      fireEvent.change(box(), { target: { value: 'silent' } });
      fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
      // While the turn runs a steer may wait as long as a tool takes: no timeout.
      act(() => { vi.advanceTimersByTime(STEER_ANSWER_MS * 3); });
      expect(pane().queue[0]!.steer).toBeTruthy();
      server({ type: 'turn_result', turnId: 't1', sessionId: 's1', cwd: '/w', ok: true, text: 'ok', badge: null, errorText: null });
      expect(nextQueued(pane())).toBeNull();
      act(() => { vi.advanceTimersByTime(STEER_ANSWER_MS); });
      expect(pane().queue[0]).toMatchObject({ text: 'silent' });
      expect(pane().queue[0]!.steer).toBeUndefined();
      expect(pane().queuePaused).toBe(true);
      fireEvent.click(screen.getByText('이어서 보내기'));
      expect(send.mock.lastCall![0]).toMatchObject({ type: 'send', text: 'silent' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('todo panel (ux-state)', () => {
  afterEach(cleanup);

  it('shows the latest list with a done/total count and folds to the current item', () => {
    render(base({ busy: false, activeTurnId: null, items: [
      todoTurn([{ content: 'old', status: 'pending' }]),
      todoTurn([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress', activeForm: 'doing b' }, { content: 'c', status: 'pending' }]),
    ] }));
    const panel = screen.getByTestId('todo-panel');
    expect(panel.querySelector('.todo-count')?.textContent).toBe('1/3');
    expect([...panel.querySelectorAll('.todo')].map((li) => li.className)).toEqual(['todo completed', 'todo in_progress', 'todo pending']);
    expect(panel.textContent).not.toContain('old');
    fireEvent.click(panel.querySelector('.todo-head')!);
    expect(panel.querySelector('.todo-list')).toBeNull();
    expect(panel.querySelector('.todo-current')?.textContent).toBe('doing b');
  });

  it('no todo tool call → no panel; the TodoWrite tool line expands to a checklist, not JSON', () => {
    render(base({ busy: false, activeTurnId: null, items: [{ kind: 'user', text: 'hi' }] }));
    expect(screen.queryByTestId('todo-panel')).toBeNull();
    cleanup();
    const { container } = render(<MessageView item={todoTurn([{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }])} />);
    expect(container.querySelector('.todo-detail .todo-list')).toBeTruthy();
    expect(container.querySelector('.tool-input')).toBeNull();
    expect(container.querySelector('.tool-call .todo-count')?.textContent).toBe('1/2');
  });
});

describe('attachment previews (ux-state)', () => {
  afterEach(cleanup);
  const id = '11111111-2222-3333-4444-555555555555';

  it('sent images load from the authed endpoint; click opens a lightbox (Esc closes); a purged upload falls back to a tile', () => {
    const { container } = render(<MessageView item={{ kind: 'user', text: 'look', attachments: [{ id, name: 'shot.png', isImage: true }, { id: id.replace('1', '9'), name: 'n.md', isImage: false }] }} />);
    const img = container.querySelector('.attach-thumb img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(`/api/attachments/${id}`);
    expect(container.querySelector('.attach-tile.file')?.textContent).toContain('n.md');
    fireEvent.click(screen.getByLabelText('shot.png 크게 보기'));
    expect(screen.getByTestId('lightbox').querySelector('img')?.getAttribute('src')).toBe(`/api/attachments/${id}`);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('lightbox')).toBeNull();
    fireEvent.error(img);
    expect(container.querySelector('.attach-thumb')).toBeNull();
    expect(container.querySelector('.attach-tile.image')?.textContent).toContain('shot.png');
  });

  it('composer chips show the local preview (object URL) for images', () => {
    const { container } = render(<AttachmentBar attachments={[{ id: 'a', name: 'x.png', size: 10, isImage: true, previewUrl: 'blob:http://x/1' }, { id: 'b', name: 'y.md', size: 10, isImage: false }]} uploading={0} error={null} onFiles={() => {}} onRemove={() => {}} />);
    expect(container.querySelector('img.attach-preview')?.getAttribute('src')).toBe('blob:http://x/1');
    expect(container.querySelectorAll('img.attach-preview')).toHaveLength(1);
  });
});


