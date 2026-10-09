// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewChat } from './NewChat';
import type { ProjectEntry } from '../../shared/session-types';
import { loadDraft, saveDraft } from '../drafts';

const projects = [{ cwd: '/w', name: 'w', pinned: true, sessions: [] }] as unknown as ProjectEntry[];

describe('NewChat', () => {
  afterEach(cleanup);
  beforeEach(() => localStorage.clear());

  it('최근 대화 cards carry the engine mark before the title', () => {
    const sessions = [
      { sessionId: 'c', account: 'a', cwd: '/w', projectDir: '/p', file: '/f', title: 'claude one', lastModified: 2, sizeBytes: 1 },
      { sessionId: 'g', account: 'gpt', engine: 'codex', cwd: '/w', projectDir: '', file: '', title: 'codex one', lastModified: 1, sizeBytes: 1 },
    ];
    render(<NewChat projects={[{ cwd: '/w', name: 'w', pinned: true, sessions }] as unknown as ProjectEntry[]} onStart={vi.fn()} onOpenSession={vi.fn()} now={10} />);
    expect(screen.getByText('claude one').querySelector('.engine-mark')?.getAttribute('title')).toBe('Claude');
    expect(screen.getByText('codex one').querySelector('.engine-mark')?.getAttribute('title')).toBe('Codex (GPT)');
  });

  it('the ↑ button opens an empty new session when nothing is typed', () => {
    const onStart = vi.fn();
    render(<NewChat projects={projects} onStart={onStart} />);
    const go = screen.getByLabelText('빈 새 대화 열기');
    fireEvent.click(go);
    expect(onStart).toHaveBeenCalledWith('/w', 'w', '', [], { engine: 'claude', sandbox: 'workspace-write' });
  });

  it('picked and pasted attachments ride the first message', async () => {
    const onStart = vi.fn();
    const uploadFn = vi.fn(async (f: File) => ({ id: `id-${f.name}`, name: f.name, size: f.size, isImage: f.type.startsWith('image/') }));
    render(<NewChat projects={projects} onStart={onStart} uploadFn={uploadFn} />);
    const shot = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('attachment-gallery'), { target: { files: [shot] } });
    const notes = new File(['y'], 'notes.md', { type: 'text/markdown' });
    fireEvent.paste(screen.getByLabelText('첫 메시지'), { clipboardData: { files: [notes] } });
    await waitFor(() => expect(screen.getByText(/notes\.md/)).toBeTruthy());
    expect(screen.getByText(/shot\.png/)).toBeTruthy();
    const box = screen.getByLabelText('첫 메시지');
    fireEvent.change(box, { target: { value: '이거 봐줘' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onStart).toHaveBeenCalledWith('/w', 'w', '이거 봐줘', [
      { id: 'id-shot.png', name: 'shot.png', size: 1, isImage: true },
      { id: 'id-notes.md', name: 'notes.md', size: 1, isImage: false },
    ], { engine: 'claude', sandbox: 'workspace-write' });
  });

  it('attachments alone still send (with the attachment-only text); a removed one does not', async () => {
    const onStart = vi.fn();
    const uploadFn = vi.fn(async (f: File) => ({ id: f.name, name: f.name, size: f.size, isImage: false }));
    render(<NewChat projects={projects} onStart={onStart} uploadFn={uploadFn} />);
    fireEvent.change(screen.getByTestId('attachment-input'), { target: { files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')] } });
    await waitFor(() => expect(screen.getAllByLabelText('첨부 제거')).toHaveLength(2));
    fireEvent.click(screen.getAllByLabelText('첨부 제거')[0]!);
    fireEvent.click(screen.getByLabelText(/^보내기/));
    expect(onStart).toHaveBeenCalledWith('/w', 'w', '첨부 파일을 확인해 주세요.', [{ id: 'b.txt', name: 'b.txt', size: 1, isImage: false }], { engine: 'claude', sandbox: 'workspace-write' });
  });

  it('restores its draft (per draftKey), saves on change and clears it on send', () => {
    saveDraft('new:p1', '어제 쓰던 글');
    const onStart = vi.fn();
    render(<NewChat projects={projects} onStart={onStart} draftKey="new:p1" />);
    const box = screen.getByLabelText('첫 메시지') as HTMLTextAreaElement;
    expect(box.value).toBe('어제 쓰던 글');
    fireEvent.change(box, { target: { value: '고친 글' } });
    expect(loadDraft('new:p1')).toBe('고친 글');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onStart).toHaveBeenCalledWith('/w', 'w', '고친 글', [], { engine: 'claude', sandbox: 'workspace-write' });
    expect(loadDraft('new:p1')).toBe('');
  });

  it('without a draftKey it uses the shared new-chat key', () => {
    render(<NewChat projects={projects} onStart={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('첫 메시지'), { target: { value: '초안' } });
    expect(loadDraft('new')).toBe('초안');
  });

  it('no engine picker when only Claude is available', () => {
    render(<NewChat projects={projects} onStart={vi.fn()} />);
    expect(screen.queryByTestId('engine-select')).toBeNull();
    expect(screen.queryByTestId('sandbox-select')).toBeNull();
  });

  it('engine picker; picking GPT shows the sandbox picker and the submit carries both', () => {
    const onStart = vi.fn();
    const onEngine = vi.fn();
    const onSandbox = vi.fn();
    render(<NewChat projects={projects} onStart={onStart} codexAvailable onEngine={onEngine} onSandbox={onSandbox} />);
    const engine = screen.getByTestId('engine-select') as HTMLSelectElement;
    expect(engine.value).toBe('claude');
    expect(screen.queryByTestId('sandbox-select')).toBeNull();
    fireEvent.change(engine, { target: { value: 'codex' } });
    expect(onEngine).toHaveBeenCalledWith('codex');
    const sandbox = screen.getByTestId('sandbox-select') as HTMLSelectElement;
    // 다 붙여: workspace-write with network is the default; read-only stays selectable.
    expect(sandbox.value).toBe('workspace-write');
    expect(sandbox.parentElement!.querySelector('.pick-label')!.textContent).toBe('작업폴더 쓰기 · 네트워크');
    fireEvent.change(sandbox, { target: { value: 'read-only' } });
    expect(onSandbox).toHaveBeenCalledWith('read-only');
    expect(sandbox.parentElement!.querySelector('.pick-label')!.textContent).toBe('읽기 전용');
    fireEvent.change(screen.getByLabelText('첫 메시지'), { target: { value: '고쳐줘' } });
    fireEvent.click(screen.getByLabelText(/^보내기/));
    expect(onStart).toHaveBeenCalledWith('/w', 'w', '고쳐줘', [], { engine: 'codex', sandbox: 'read-only' });
  });

  it('starts from the pane engine/sandbox; Gemini shows its own sandbox labels and needs a login', () => {
    const gemini = { available: true, loggedIn: { g1: true, g2: false } };
    render(<NewChat projects={projects} onStart={vi.fn()} engine="gemini" sandbox="workspace-write" gemini={gemini} />);
    expect((screen.getByTestId('engine-select') as HTMLSelectElement).value).toBe('gemini');
    expect(screen.getByTestId('sandbox-select').parentElement!.querySelector('.pick-label')!.textContent).toBe('파일 편집 허용(셸 거부)');
    cleanup();
    render(<NewChat projects={projects} onStart={vi.fn()} gemini={{ available: true, loggedIn: { g1: false, g2: false } }} />);
    expect((screen.getByRole('option', { name: 'Gemini · 로그인 필요' }) as HTMLOptionElement).disabled).toBe(true);
  });
});
