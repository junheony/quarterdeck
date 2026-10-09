import { useEffect } from 'react';

/** An info toast's life (ms): long enough to read a short line, short enough not to pile up. */
export const INFO_TOAST_MS = 5_000;
/** An error toast's life (ms): longer than info so a glance away does not miss it, but it still clears itself (the old band never did). */
export const ERROR_TOAST_MS = 12_000;
/** Visible at once; older ones are hidden (not dropped) until newer ones go, so a burst never covers the screen. */
export const MAX_TOASTS = 4;

export type ToastItem = { id: number; text: string; kind?: 'error' | 'info' };

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const kind = toast.kind ?? 'error';
  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), kind === 'info' ? INFO_TOAST_MS : ERROR_TOAST_MS);
    return () => clearTimeout(t);
    // onDismiss is a fresh closure each render; the timer belongs to the toast, so it must not restart.
  }, [toast.id, kind]);
  return (
    <div className={`toast-item ${kind}`} role={kind === 'info' ? 'status' : 'alert'}>
      <span>{toast.text}</span>
      <button type="button" className="icon-btn" aria-label="닫기" onClick={() => onDismiss(toast.id)}>✕</button>
    </div>
  );
}

/**
 * Fixed stack of transient messages (errors, notes): floats over the layout instead of pushing it down,
 * each closes itself and on ×, and several can be seen at once (the old single band overwrote the previous one).
 * `toasts` is oldest-first (append order); shown newest on top.
 */
export function Toasts({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  const shown = toasts.slice(-MAX_TOASTS).reverse();
  return <div className="toasts">{shown.map((t) => <Toast key={t.id} toast={t} onDismiss={onDismiss} />)}</div>;
}
