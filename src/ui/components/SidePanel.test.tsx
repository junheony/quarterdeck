// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Pane } from './Pane';
import { PREVIEW_FRAME_SRC, SidePanel } from './SidePanel';
import { newPane, type PaneState } from '../state';
import { Markdown } from './MessageView';
import { SidePanelContext } from '../sidePanel';

Element.prototype.scrollIntoView = () => {};

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('SidePanel', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('shows a text file with line numbers, path relative to the cwd, and asks the server with cwd + session', async () => {
    const fetchFn = mockFetch({ path: '/w/src/a.ts', size: 4, kind: 'text', text: 'a\nb\nc\n' });
    render(<SidePanel doc={{ kind: 'file', path: '/w/src/a.ts' }} cwd="/w" sessionId="s1" onClose={() => {}} onOpen={() => {}} />);
    expect((await screen.findByTestId('side-text')).textContent).toContain('a\nb\nc');
    expect(screen.getByTestId('side-text').querySelector('.side-gutter')!.textContent).toBe('1\n2\n3');
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toBe('/api/file?cwd=%2Fw&path=%2Fw%2Fsrc%2Fa.ts&session=s1');
    expect(screen.getByText('경로 복사')).toBeTruthy();
  });

  it('shows the server error (e.g. outside the folder)', async () => {
    mockFetch({ error: '세션 폴더 안의 파일만 열 수 있습니다' }, 403);
    render(<SidePanel doc={{ kind: 'file', path: '/etc/hosts' }} cwd="/w" sessionId={null} onClose={() => {}} onOpen={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toBe('세션 폴더 안의 파일만 열 수 있습니다');
  });

  it('HTML preview: sandboxed iframe (scripts only, never same-origin) on the shell URL; 원문 tab shows the source', () => {
    render(<SidePanel doc={{ kind: 'html', title: 'HTML 미리보기', html: '<b>hi</b>' }} cwd="/w" sessionId={null} onClose={() => {}} onOpen={() => {}} />);
    const frame = screen.getByTestId('html-preview') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe(PREVIEW_FRAME_SRC);
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    fireEvent.click(screen.getByRole('tab', { name: '원문' }));
    expect(screen.getByTestId('side-text').textContent).toContain('<b>hi</b>');
  });

  it('an edit opens on its 변경 사항 tab', async () => {
    mockFetch({ path: '/w/a.ts', size: 1, kind: 'text', text: 'x' });
    const diff = { path: '/w/a.ts', isNew: false, isDeleted: false, note: null, added: 1, removed: 0, lines: [{ kind: 'add' as const, text: 'x', oldNo: null, newNo: 1 }] };
    render(<SidePanel doc={{ kind: 'file', path: '/w/a.ts', diffs: [diff] }} cwd="/w" sessionId={null} onClose={() => {}} onOpen={() => {}} />);
    expect(screen.getByRole('tab', { name: '변경 사항' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('diff-card')).toBeTruthy();
  });
});

describe('Pane side panel', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const pane: PaneState = {
    ...newPane('p1'),
    session: { sessionId: 's1', cwd: '/w', account: null, title: 't', engine: 'claude', sandbox: null },
    items: [{ kind: 'assistant', turnId: 't1', text: 'See `src/b.md` and\n\n```html\n<p>x</p>\n```\n', toolCalls: [{ toolUseId: 'u1', name: 'Read', input: { file_path: '/w/src/a.ts' }, result: 'ok', isError: false }], badge: null, streaming: false, error: null, notes: [], attempts: [] }],
  };
  const renderPane = () => render(<Pane pane={pane} app={{ pending: [], questions: [], codexAvailable: false }} active closable={false} dispatch={() => {}} send={() => {}} onClose={() => {}} />);

  it('a Read path opens the panel; Esc closes it', async () => {
    mockFetch({ path: '/w/src/a.ts', size: 1, kind: 'text', text: 'x' });
    renderPane();
    expect(screen.queryByTestId('side-panel')).toBeNull();
    fireEvent.click(screen.getByTitle('/w/src/a.ts — 사이드 패널에서 열기'));
    expect(await screen.findByTestId('side-text')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('side-panel')).toBeNull();
  });

  it('inline code paths, the html block 미리보기 and the 파일 button open it too', async () => {
    mockFetch({ path: '/w/src/b.md', size: 1, kind: 'text', text: '# T' });
    renderPane();
    fireEvent.click(screen.getByTitle('src/b.md — 사이드 패널에서 열기'));
    expect((await screen.findByRole('heading', { name: 'T' }))).toBeTruthy();
    fireEvent.click(screen.getByText('미리보기'));
    expect(screen.getByTestId('html-preview')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('사이드 패널 닫기'));
    fireEvent.click(screen.getByRole('button', { name: '채팅 메뉴' })); // 파일 lives in the header ⋯ menu
    fireEvent.click(screen.getByRole('menuitem', { name: '파일 열기' }));
    expect(screen.getByLabelText('세션 폴더의 파일 경로')).toBeTruthy();
  });
});

describe('html block with md-render highlighting', () => {
  afterEach(cleanup);

  it('keeps the language label, 미리보기 and 코드 복사 together once highlight.js has run; 미리보기 gets the raw source', async () => {
    const open = vi.fn();
    const { container } = render(<SidePanelContext.Provider value={open}><Markdown text={'```html\n<b class="x">hi</b>\n```'} /></SidePanelContext.Provider>);
    await waitFor(() => expect(container.querySelector('.code-block code.hljs')).not.toBeNull());
    expect(container.querySelector('.code-lang')!.textContent).toBe('html');
    expect(screen.getByLabelText('코드 복사')).toBeTruthy();
    fireEvent.click(screen.getByText('미리보기'));
    expect(open).toHaveBeenCalledWith({ kind: 'html', title: 'HTML 미리보기', html: '<b class="x">hi</b>' });
  });
});
