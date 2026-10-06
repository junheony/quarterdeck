import { useEffect } from 'react';

/** URL of an uploaded image (authed GET; the browser sends the session cookie). */
export const attachmentUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}`;

/** ux-state: full-size image over everything; click anywhere or Esc closes. */
export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt} data-testid="lightbox" onClick={onClose}>
      <img src={src} alt={alt} />
      <button type="button" className="lightbox-close" aria-label="닫기" onClick={onClose}>✕</button>
    </div>
  );
}
