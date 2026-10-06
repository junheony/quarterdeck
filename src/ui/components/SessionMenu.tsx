import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { SessionEntry } from '../../shared/session-types';

/**
 * Why deck cannot delete this session (null = it can): the trash only moves Claude transcripts. GPT / Gemini /
 * Codex-app sessions live in those tools' own folders, which deck never writes.
 */
export function deleteBlockedReason(s: Pick<SessionEntry, 'imported' | 'engine' | 'account'>): string | null {
  if (s.imported) return 'Codex 앱 기록은 deck에서 지울 수 없어요';
  if (s.engine === 'codex' || s.account === 'gpt') return 'GPT 대화 기록은 Codex 폴더에 있어 deck에서 지울 수 없어요';
  if (s.engine === 'gemini') return 'Gemini 대화 기록은 deck에서 지울 수 없어요';
  return null;
}

/** 삭제 deck cannot do: disabled, with the reason as a second line (a touch screen shows no title tooltip). */
export function BlockedDeleteItem({ reason }: { reason: string }) {
  const id = useId();
  return (
    <button type="button" role="menuitem" className="danger" aria-disabled="true" aria-label="삭제…" aria-describedby={id} title={reason}>
      삭제…<span id={id} className="menu-note">{reason}</span>
    </button>
  );
}

/** Roving focus: the item index a key moves to (wrapping), or null for keys the menu does not move on. */
export function menuStep(current: number, key: string, count: number): number | null {
  if (count === 0) return null;
  if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count;
  if (key === 'ArrowUp') return current < 0 ? count - 1 : (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

const ITEMS = '[role="menuitem"]';

/**
 * A row / title menu (the sidebar ⋯, the chat title ⌄): the first item takes focus, ↑/↓ (Home/End) move it, Enter
 * activates (a button), Esc or Tab closes and Esc puts focus back on the button that opened it (the sibling with
 * aria-haspopup="menu"). A click outside closes it too.
 */
export function MenuList({ className = 'session-menu', label, onClose, children }: { className?: string; label?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const trigger = () => ref.current?.parentElement?.querySelector<HTMLElement>('[aria-haspopup="menu"]') ?? null;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(ITEMS)?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !trigger()?.contains(t)) closeRef.current();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const t = trigger();
      onClose();
      t?.focus();
      return;
    }
    if (e.key === 'Tab') { onClose(); return; }
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    const next = menuStep(items.indexOf(document.activeElement as HTMLElement), e.key, items.length);
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  };
  return (
    <div ref={ref} className={className} role="menu" aria-label={label} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}
