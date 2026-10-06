// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AttachmentBar } from './AttachmentBar';

describe('AttachmentBar (D7)', () => {
  afterEach(cleanup);

  it('lists chips with remove buttons, shows upload progress and errors, and forwards picked files', () => {
    const onRemove = vi.fn();
    const onFiles = vi.fn();
    render(<AttachmentBar attachments={[{ id: '1', name: 'shot.png', size: 2048, isImage: true }, { id: '2', name: 'notes.md', size: 10, isImage: false }]} uploading={1} error="업로드 실패" onFiles={onFiles} onRemove={onRemove} />);
    expect(screen.getByText(/shot\.png/).textContent).toContain('🖼');
    expect(screen.getByText(/notes\.md/).textContent).toContain('📄');
    expect(screen.getByText('업로드 중 1')).toBeTruthy();
    expect(screen.getByText('업로드 실패')).toBeTruthy();
    fireEvent.click(screen.getAllByLabelText('첨부 제거')[0]!);
    expect(onRemove).toHaveBeenCalledWith('1');
    const input = screen.getByTestId('attachment-input') as HTMLInputElement;
    const f = new File(['x'], 'x.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [f] } });
    expect(onFiles).toHaveBeenCalledWith([f]);
  });

  it('[+] opens a menu — 사진 보관함 (image picker), 파일 — closed by Esc and outside clicks, walked with arrows', () => {
    const onFiles = vi.fn();
    render(<AttachmentBar attachments={[]} uploading={0} error={null} onFiles={onFiles} onRemove={() => {}} />);
    const plus = screen.getByLabelText('첨부');
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(plus);
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['사진 보관함', '파일']); // no camera without a coarse pointer
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(plus);
    fireEvent.click(plus);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();

    const gallery = screen.getByTestId('attachment-gallery') as HTMLInputElement;
    expect(gallery.accept).toBe('image/*');
    expect(gallery.multiple).toBe(true);
    const click = vi.spyOn(gallery, 'click');
    fireEvent.click(plus);
    fireEvent.click(screen.getByText('사진 보관함'));
    expect(click).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    const f = new File(['x'], 'p.jpg', { type: 'image/jpeg' });
    fireEvent.change(gallery, { target: { files: [f] } });
    expect(onFiles).toHaveBeenCalledWith([f]);
  });

  it('offers 카메라 (capture) on a touch screen', () => {
    const was = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q === '(pointer: coarse)', media: q })) as unknown as typeof window.matchMedia;
    render(<AttachmentBar attachments={[]} uploading={0} error={null} onFiles={() => {}} onRemove={() => {}} />);
    fireEvent.click(screen.getByLabelText('첨부'));
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['사진 보관함', '카메라', '파일']);
    const cam = screen.getByTestId('attachment-camera') as HTMLInputElement;
    expect(cam.accept).toBe('image/*');
    expect(cam.getAttribute('capture')).toBe('environment');
    window.matchMedia = was;
  });
});
