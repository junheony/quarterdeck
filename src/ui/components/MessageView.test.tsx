// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { MessageView } from './MessageView';

describe('MessageView', () => {
  afterEach(cleanup);

  it('a Stop-hook item is a muted system row with the feedback collapsed until clicked — not a user bubble', () => {
    const { container, getByTestId } = render(<MessageView item={{ kind: 'system', source: 'Stop', label: 'Stop 훅이 이어서 진행시킴', text: 'Stop hook feedback:\n[verify] 테스트가 실패합니다' }} />);
    const row = getByTestId('system-row');
    expect(row.classList.contains('system')).toBe(true);
    expect(container.querySelector('.msg.user')).toBeNull();
    expect(row.querySelector('summary')?.textContent).toContain('Stop 훅이 이어서 진행시킴');
    const details = row.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(row.querySelector('.sys-body')!.textContent).toBe('[verify] 테스트가 실패합니다');
    fireEvent.click(row.querySelector('summary')!);
    expect(details.open).toBe(true);
  });

  it('strips only the hook header, not the colons inside the message', () => {
    const { getByTestId } = render(<MessageView item={{ kind: 'system', source: 'PreToolUse', label: 'PreToolUse 훅 메시지', text: 'PreToolUse:Bash hook blocking error from command: "x": denied' }} />);
    const row = getByTestId('system-row');
    expect(row.querySelector('summary')?.textContent).toContain('PreToolUse 훅 메시지');
    expect(row.querySelector('.sys-body')!.textContent).toBe('"x": denied');
  });

  it("another session's message keeps its whole text as the collapsed body", () => {
    const text = 'Another Claude session sent a message:\n<agent-message from="a1">보고: 끝</agent-message>';
    const { getByTestId } = render(<MessageView item={{ kind: 'system', source: 'peer', label: '다른 세션의 메시지', text }} />);
    expect(getByTestId('system-row').querySelector('summary')?.textContent).toContain('다른 세션의 메시지');
    expect(getByTestId('system-row').querySelector('.sys-body')!.textContent).toBe(text);
  });

  it('renders markdown images as links, never as <img> (no auto-loading remote URLs)', () => {
    const { container } = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: 'see ![pixel](https://evil.example/p.png?leak=1) here', toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    expect(container.querySelector('img')).toBeNull();
    const a = container.querySelector('a[href="https://evil.example/p.png?leak=1"]');
    expect(a).not.toBeNull();
    expect(a?.getAttribute('rel')).toBe('noreferrer noopener');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.textContent).toContain('pixel');
  });

  it('renders GFM: a pipe table becomes a scrollable <table>, plus strikethrough and task lists', () => {
    const text = '| 계정 | 남음 |\n|---|---|\n| A | 42% |\n| B | 7% |\n\n~~old~~\n\n- [x] done\n- [ ] todo';
    const { container } = render(<MessageView item={{ kind: 'assistant', turnId: 't', text, toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    const table = container.querySelector('.md-table > table');
    expect(table).not.toBeNull();
    expect([...table!.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['계정', '남음']);
    expect(table!.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.querySelector('del')?.textContent).toBe('old');
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(container.textContent).not.toContain('|---|');
  });

  it('shows the role-distribution badge for subagent/offload calls and attachment chips on user messages', () => {
    const { container } = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: 'done', toolCalls: [
      { toolUseId: '1', name: 'Agent', input: { subagent_type: 'explore', model: 'sonnet', description: 'find' }, result: 'ok', isError: false },
      { toolUseId: '2', name: 'Bash', input: { command: 'offload cross "x"' }, result: 'ok', isError: false },
    ], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    expect(container.querySelector('.role-badge')?.textContent).toContain('explore');
    expect(container.querySelector('.role-badge')?.textContent).toContain('offload cross');
    cleanup();
    const u = render(<MessageView item={{ kind: 'user', text: 'look', attachments: [{ id: '11111111-2222-3333-4444-555555555555', name: 'shot.png', isImage: false }] }} />);
    expect(u.container.querySelector('.attach-tile .attach-name')?.textContent).toBe('shot.png');
    expect(u.container.querySelector('.attach-tile')?.classList.contains('image')).toBe(true);
  });
});

describe('MessageView tool lines (Desktop style)', () => {
  afterEach(cleanup);
  const tc = (id: string, name: string, input: unknown, extra = {}) => ({ toolUseId: id, name, input, result: 'out', isError: false, ...extra });

  it('one tool call is one collapsed line; several are one collapsed group line that expands to per-call lines', () => {
    const one = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: 'ok', toolCalls: [tc('1', 'Bash', { command: 'npm test', description: 'Run tests' })], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    const line = one.container.querySelector('[data-testid="tool-call"]') as HTMLDetailsElement;
    expect(line.querySelector('summary')?.textContent).toContain('Run tests');
    expect(line.open).toBe(false);
    expect(one.container.querySelector('.tool-group')).toBeNull();
    cleanup();
    const many = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: '', toolCalls: [tc('1', 'Bash', { command: 'a' }), tc('2', 'Bash', { command: 'b' }, { isError: true })], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    const group = many.container.querySelector('[data-testid="tool-group"]') as HTMLDetailsElement;
    expect(group.querySelector('summary')?.textContent).toContain('실행된 명령 2개');
    expect(group.querySelector('summary')?.textContent).toContain('오류 1');
    expect(group.open).toBe(false);
    expect(group.querySelectorAll('[data-testid="tool-call"]')).toHaveLength(2);
    expect(many.container.querySelector('.markdown')).toBeNull();
  });

  it('a call without a result shows 실행 중 only while the turn streams', () => {
    const item = { kind: 'assistant' as const, turnId: 't', text: '', toolCalls: [{ toolUseId: '1', name: 'Read', input: { file_path: '/w/x.ts' }, result: null, isError: false }], badge: null, streaming: true, error: null, notes: [], attempts: [] };
    const live = render(<MessageView item={item} />);
    expect(live.container.querySelector('.tool-call.running')?.textContent).toContain('실행 중');
    cleanup();
    const done = render(<MessageView item={{ ...item, streaming: false }} />);
    expect(done.container.querySelector('.tool-call')?.textContent).not.toContain('실행 중');
  });
});

describe('MessageView injected user turns', () => {
  afterEach(cleanup);
  const notif = '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Agent "research" finished</summary>\n<result>**done** here</result>\n</task-notification>';

  it('renders a task-notification turn as a compact system line, not a raw user bubble', () => {
    const { container } = render(<MessageView item={{ kind: 'user', text: notif }} />);
    expect(container.querySelector('.msg.user')).toBeNull();
    const line = container.querySelector('[data-testid="sys-notice"]') as HTMLDetailsElement;
    expect(line.open).toBe(false);
    expect(line.querySelector('summary')?.textContent).toContain('백그라운드 작업 완료');
    expect(line.querySelector('summary')?.textContent).toContain('Agent "research" finished');
    expect(line.querySelector('summary')?.textContent).not.toContain('<task-id>');
    // expanded: the result as markdown plus the verbatim block
    expect(line.querySelector('.sys-detail strong')?.textContent).toBe('done');
    expect(line.querySelector('.sys-raw pre')?.textContent).toBe(notif);
  });

  it('strips system-reminder from a user bubble; a reminder-only turn renders nothing', () => {
    const a = render(<MessageView item={{ kind: 'user', text: 'hi\n<system-reminder>secret ctx</system-reminder>' }} />);
    expect(a.container.querySelector('.msg.user pre')?.textContent).toBe('hi');
    expect(a.container.textContent).not.toContain('secret ctx');
    cleanup();
    const b = render(<MessageView item={{ kind: 'user', text: '<system-reminder>only</system-reminder>' }} />);
    expect(b.container.innerHTML).toBe('');
  });
});

describe('MessageView code blocks and turn footer', () => {
  afterEach(cleanup);

  it('fenced code gets a language label and a copy button; inline code stays a chip', () => {
    const text = 'run `npm test` then:\n\n```ts\nconst a = 1;\n```\n\n```\nplain\n```';
    const { container } = render(<MessageView item={{ kind: 'assistant', turnId: 't', text, toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    const blocks = container.querySelectorAll('.code-block');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.querySelector('.code-lang')?.textContent).toBe('ts');
    expect(blocks[0]!.querySelector('pre code')?.textContent).toContain('const a = 1;');
    expect(blocks[1]!.querySelector('.code-lang')?.textContent).toBe('text');
    expect(container.querySelector('p > code')?.textContent).toBe('npm test');
  });

  it('copy button copies the code text and confirms', async () => {
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    const { container, findByText } = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: '```sh\necho hi\n```', toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    fireEvent.click(container.querySelector('.code-copy')!);
    expect(await findByText('복사됨')).toBeTruthy();
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('turn badge keeps account, model, all four token counts and the reason', () => {
    const badge = { account: 'b', model: 'opus', reason: '가장 여유', usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 56000, cacheCreationTokens: 0 } } as never;
    const { container } = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: 'ok', toolCalls: [], badge, streaming: false, error: null, notes: [], attempts: [] }} />);
    const t = container.querySelector('.turn-foot .turn-badge')?.textContent ?? '';
    for (const s of ['B', '입력 1.2k', '출력 340', '캐시 읽기 56.0k', '캐시 쓰기 0', '가장 여유']) expect(t).toContain(s);
  });
});
