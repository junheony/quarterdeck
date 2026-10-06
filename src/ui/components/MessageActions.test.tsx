// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Chat, type ChatProps } from './Chat';
import { MessageView } from './MessageView';
import { ToolCallView } from './ToolCallView';
import { useState } from 'react';
import { useShareActions, sessionLink, type ShareOpts } from './ShareMenu';
import { copyText } from '../clipboard';
import type { ChatItem } from '../state';
import { HANDOFF_PROMPT } from '../../shared/handoff';

Element.prototype.scrollIntoView = () => {};

const reply = (text: string, extra: Partial<Extract<ChatItem, { kind: 'assistant' }>> = {}): ChatItem => ({ kind: 'assistant', turnId: 't', text, toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [], ...extra });

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});
afterEach(cleanup);

function renderChat(items: ChatItem[], extra: Partial<ChatProps> = {}) {
  const onSend = vi.fn();
  render(<Chat items={items} pending={[]} questions={[]} activeTurnId={null} busy={false} title="제목" model="opus" effort="high" engine="claude" sandbox="read-only" sessionEngine="claude" sessionSandbox={null} isNew={false} codexAvailable={false} attachments={[]} onSend={onSend} onInterrupt={() => {}} onDecide={() => {}} onAnswer={() => {}} onModel={() => {}} onEffort={() => {}} onEngine={() => {}} onSandbox={() => {}} onAttach={() => {}} onUnattach={() => {}} sessionId="s-1" {...extra} />);
  return onSend;
}

describe('clipboard', () => {
  it('falls back to execCommand outside a secure context', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    expect(await copyText('x')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('message actions', () => {
  it('assistant reply: 응답 복사 copies the markdown and shows 복사됨, then resets', async () => {
    render(<MessageView item={reply('**굵게** 답')} last />);
    fireEvent.click(screen.getByRole('button', { name: '응답 복사' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '복사됨' })).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith('**굵게** 답');
    await waitFor(() => expect(screen.getByRole('button', { name: '응답 복사' })).toBeTruthy(), { timeout: 2500 });
  });

  it('no actions while streaming', () => {
    render(<MessageView item={reply('부분', { streaming: true })} last />);
    expect(screen.queryByTestId('turn-actions')).toBeNull();
  });

  it('code block copy copies the raw code', async () => {
    const { container } = render(<MessageView item={reply('```ts\nconst a = 1;\n```')} />);
    fireEvent.click(container.querySelector('.code-copy')!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const a = 1;'));
  });

  it('tool card copies the command and the full output', async () => {
    render(<ToolCallView call={{ toolUseId: 'u', name: 'Bash', input: { command: 'ls -la' }, result: 'a\nb', isError: false }} />);
    fireEvent.click(screen.getByRole('button', { name: '명령 복사' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ls -la'));
    fireEvent.click(screen.getByRole('button', { name: '출력 복사' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('a\nb'));
  });

  it('user message: 복사 copies the text; 편집 puts it in the composer to resend as a new turn', async () => {
    const onSend = renderChat([{ kind: 'user', text: '원래 질문' }, reply('답')]);
    fireEvent.click(screen.getByRole('button', { name: '메시지 복사' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('원래 질문'));
    fireEvent.click(screen.getByRole('button', { name: '편집' }));
    const ta = screen.getByLabelText('메시지') as HTMLTextAreaElement;
    expect(ta.value).toBe('원래 질문');
    fireEvent.change(ta, { target: { value: '고친 질문' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('고친 질문');
  });

  it('재시도 on the last reply re-sends the last prompt; not on earlier replies, not while busy', () => {
    const items = [{ kind: 'user', text: '하나' }, reply('일'), { kind: 'user', text: '둘' }, reply('이')] as ChatItem[];
    const onSend = renderChat(items);
    const retries = screen.getAllByRole('button', { name: '재시도' });
    expect(retries).toHaveLength(1);
    fireEvent.click(retries[0]!);
    expect(onSend).toHaveBeenCalledWith('둘');
    cleanup();
    renderChat(items, { busy: true });
    expect(screen.queryByRole('button', { name: '재시도' })).toBeNull();
  });

  it('no 재시도 after a handoff-note request (it would re-run the note prompt as a plain turn with tools)', () => {
    renderChat([{ kind: 'user', text: HANDOFF_PROMPT }, reply('실패한 메모', { error: 'boom' })]);
    expect(screen.queryByRole('button', { name: '재시도' })).toBeNull();
  });
});


/** Minimal menu over useShareActions (the real one lives in the chat header's ⋯ menu). */
function ShareMenu(opts: ShareOpts) {
  const [open, setOpen] = useState(false);
  const { actions, done } = useShareActions(opts, () => setOpen(false));
  return (
    <div>
      <button type="button" aria-label="공유" onClick={() => setOpen((o) => !o)} />
      {done && <span role="status">{done}</span>}
      {open && <div role="menu">{actions.map((a) => <button key={a.key} type="button" role="menuitem" disabled={a.disabled} onClick={a.run}>{a.label}</button>)}</div>}
    </div>
  );
}

describe('useShareActions', () => {
  const items: ChatItem[] = [{ kind: 'user', text: '질문' }, reply('답변')];

  it('대화 복사 copies the conversation markdown; 링크 복사 copies the deck link', async () => {
    render(<ShareMenu title="제목" items={items} sessionId="abc" />);
    fireEvent.click(screen.getByRole('button', { name: '공유' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '대화 복사 (마크다운)' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const md = writeText.mock.calls[0]![0] as string;
    expect(md).toContain('# 제목');
    expect(md).toContain('## 사용자\n\n질문');
    expect(md).toContain('## Claude\n\n답변');
    expect(await screen.findByRole('status')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '공유' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '링크 복사' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}/?session=abc`));
  });

  it('마크다운으로 내보내기 downloads a .md file', () => {
    const create = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<ShareMenu title="제목" items={items} sessionId="abc" />);
    fireEvent.click(screen.getByRole('button', { name: '공유' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '마크다운으로 내보내기' }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toMatch(/^제목 \d{4}-\d{2}-\d{2}\.md$/);
    click.mockRestore();
  });

  it('uses the system share sheet when available', () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    render(<ShareMenu title="제목" items={items} sessionId="abc" />);
    fireEvent.click(screen.getByRole('button', { name: '공유' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '공유…' }));
    expect(share).toHaveBeenCalledWith({ title: '제목', url: sessionLink('abc') });
    delete (navigator as { share?: unknown }).share;
  });

  it('chat header: the share actions sit in the ⋯ menu, for an existing session only', async () => {
    renderChat(items);
    expect(screen.queryByRole('button', { name: '공유' })).toBeNull(); // no separate share button: Claude keeps one ⋯
    fireEvent.click(screen.getByRole('button', { name: '채팅 메뉴' }));
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['대화 복사 (마크다운)', '마크다운으로 내보내기', '링크 복사']);
    fireEvent.click(screen.getByRole('menuitem', { name: '링크 복사' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}/?session=s-1`));
    expect(screen.queryByRole('menu')).toBeNull();
    expect((await screen.findByRole('status')).textContent).toBe('링크를 복사했습니다');
    cleanup();
    renderChat([], { isNew: true, sessionId: null });
    expect(screen.queryByRole('button', { name: '채팅 메뉴' })).toBeNull();
  });

  it('⋯ menu: session actions, share, pane items, then 삭제 last; keyboard roving and Esc back to ⋯', () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    const onFiles = vi.fn();
    renderChat(items, { cwd: '/w/deck', titleMenu: { pinned: false, archived: false, onRename, onTogglePin: () => {}, onArchive: () => {}, onDelete }, headMenu: [{ label: '파일 열기', run: onFiles }] });
    // the title (centred) carries the folder as its second line
    expect(document.querySelector('.chat-head-main .chat-subtitle')?.textContent).toBe('deck');
    const more = screen.getByRole('button', { name: '채팅 메뉴' });
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(more);
    const menu = screen.getByRole('menu', { name: '채팅 메뉴' });
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['이름 바꾸기', '맨 위에 고정', '보관', '대화 복사 (마크다운)', '마크다운으로 내보내기', '링크 복사', '파일 열기', '삭제…']);
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(2);
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement?.textContent).toBe('삭제…');
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: '파일 열기' }));
    expect(onFiles).toHaveBeenCalledTimes(1);
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: '이름 바꾸기' }));
    expect(screen.getByLabelText('채팅 이름')).toBeTruthy();
  });

  it('⋯ menu: an empty conversation shows copy / export disabled, not missing', () => {
    renderChat([], { titleMenu: { pinned: false, archived: false } });
    fireEvent.click(screen.getByRole('button', { name: '채팅 메뉴' }));
    expect(screen.getByRole('menuitem', { name: '대화 복사 (마크다운)' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitem', { name: '링크 복사' }).hasAttribute('aria-disabled')).toBe(false);
  });
});
