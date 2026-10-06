// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewChat } from './NewChat';
import type { ProjectEntry } from '../../shared/session-types';

const projects = [{ cwd: '/w', name: 'w', pinned: true, sessions: [] }] as unknown as ProjectEntry[];

describe('NewChat', () => {
  afterEach(cleanup);

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
    expect(onStart).toHaveBeenCalledWith('/w', 'w', '', []);
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
    ]);
  });

  it('attachments alone still send (with the attachment-only text); a removed one does not', async () => {
    const onStart = vi.fn();
    const uploadFn = vi.fn(async (f: File) => ({ id: f.name, name: f.name, size: f.size, isImage: false }));
    render(<NewChat projects={projects} onStart={onStart} uploadFn={uploadFn} />);
    fireEvent.change(screen.getByTestId('attachment-input'), { target: { files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')] } });
    await waitFor(() => expect(screen.getAllByLabelText('첨부 제거')).toHaveLength(2));
    fireEvent.click(screen.getAllByLabelText('첨부 제거')[0]!);
    fireEvent.click(screen.getByLabelText(/^보내기/));
    expect(onStart).toHaveBeenCalledWith('/w', 'w', '첨부 파일을 확인해 주세요.', [{ id: 'b.txt', name: 'b.txt', size: 1, isImage: false }]);
  });
});
