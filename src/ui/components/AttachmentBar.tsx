import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from 'react';
import type { UploadedAttachment } from '../state';
import { usePopoverPlacement } from './usePopoverPlacement';

function kb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

const coarsePointer = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

const svg = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const PhotoIcon = () => <svg {...svg}><rect x="2" y="3" width="12" height="10" rx="1.8" /><circle cx="5.8" cy="6.5" r="1.1" /><path d="M2.5 11.5l3.3-3 2.4 2.1 2.1-1.8 3.2 2.7" /></svg>;
const CameraIcon = () => <svg {...svg}><path d="M2.5 5.5c0-.6.4-1 1-1h1.8l1-1.5h3.4l1 1.5h1.8c.6 0 1 .4 1 1v6.5c0 .6-.4 1-1 1h-9c-.6 0-1-.4-1-1z" /><circle cx="8" cy="8.5" r="2.2" /></svg>;
const FileIcon = () => <svg {...svg}><path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3" /></svg>;

/**
 * The composer's [+]: a small menu — 사진 보관함 (image picker; Android opens the system photo picker), 카메라 (touch
 * devices only) and 파일 (any file). Picked files go to `onFiles`; size and count limits stay with the uploader.
 */
export function AttachMenu({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [open, setOpen] = useState(false);
  const [camera, setCamera] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const cam = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const pos = usePopoverPlacement(open, btnRef, popRef, 180, 'start');

  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); // one Esc closes the menu only (not the side panel, not the running turn)
      e.stopPropagation();
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  const pick = (input: RefObject<HTMLInputElement | null>) => { setOpen(false); input.current?.click(); };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(popRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Tab') setOpen(false);
  };
  const changed = (e: ChangeEvent<HTMLInputElement>) => { const files = Array.from(e.target.files ?? []); if (files.length) onFiles(files); e.target.value = ''; };

  return (
    <>
      <button ref={btnRef} type="button" className={`attach ${open ? 'open' : ''}`} aria-label="첨부" aria-haspopup="menu" aria-expanded={open}
        title="사진·파일 첨부 (붙여넣기·끌어놓기도 됩니다)"
        onClick={() => { if (!open) setCamera(coarsePointer()); setOpen((o) => !o); }}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setCamera(coarsePointer()); setOpen(true); } }}>+</button>
      {open && (
        <div ref={popRef} className="attach-pop" role="menu" aria-label="첨부" style={pos} onKeyDown={onMenuKey} data-testid="attach-menu">
          <button type="button" role="menuitem" className="attach-item" onClick={() => pick(gallery)}><PhotoIcon />사진 보관함</button>
          {camera && <button type="button" role="menuitem" className="attach-item" onClick={() => pick(cam)}><CameraIcon />카메라</button>}
          <button type="button" role="menuitem" className="attach-item" onClick={() => pick(file)}><FileIcon />파일</button>
        </div>
      )}
      <input ref={gallery} data-testid="attachment-gallery" type="file" accept="image/*" multiple hidden onChange={changed} />
      <input ref={cam} data-testid="attachment-camera" type="file" accept="image/*" capture="environment" hidden onChange={changed} />
      <input ref={file} data-testid="attachment-input" type="file" multiple hidden onChange={changed} />
    </>
  );
}

/** Left cluster of the composer's bottom row: [+] attach, then the attached files as chips (`onFiles` absent: chips only). */
export function AttachmentBar({ attachments, uploading, error, onFiles, onRemove }: {
  attachments: UploadedAttachment[];
  uploading: number;
  error: string | null;
  onFiles?: (files: File[]) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="attachment-bar">
      {onFiles && <AttachMenu onFiles={onFiles} />}
      {attachments.map((a) => (
        <span key={a.id} className={`chip attachment ${a.previewUrl ? 'has-thumb' : ''}`} title={a.name}>
          {a.previewUrl ? <img className="attach-preview" src={a.previewUrl} alt="" /> : a.isImage ? '🖼 ' : '📄 '}{a.name} <span className="muted">{kb(a.size)}</span>
          <button type="button" className="chip-remove" aria-label="첨부 제거" onClick={() => onRemove(a.id)}>✕</button>
        </span>
      ))}
      {uploading > 0 && <span className="muted">업로드 중 {uploading}</span>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}
