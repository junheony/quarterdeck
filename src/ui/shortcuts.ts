/** Global keyboard shortcuts: ⌘ on Mac, Ctrl elsewhere. */
export type ShortcutId = 'palette' | 'help' | 'new-chat' | 'new-pane' | 'prev-session' | 'next-session' | 'toggle-sidebar' | 'settings';

/**
 * By physical key (`code`), so a Korean input source still matches. `typing`: also fires while a text field
 * has focus — ⌘[ / ⌘] do not (they would yank the user out of a half-written message).
 */
const BINDINGS: { id: ShortcutId; code: string; shift: boolean; typing: boolean; keys: string; label: string }[] = [
  { id: 'palette', code: 'KeyK', shift: false, typing: true, keys: 'K', label: '명령 팔레트 · 세션 검색' },
  { id: 'new-chat', code: 'KeyN', shift: false, typing: true, keys: 'N', label: '새 대화 (지금 패널의 프로젝트)' },
  { id: 'new-pane', code: 'KeyO', shift: true, typing: true, keys: '⇧O', label: '새 분할 패널' },
  { id: 'prev-session', code: 'BracketLeft', shift: false, typing: false, keys: '[', label: '이전 세션 (목록 위)' },
  { id: 'next-session', code: 'BracketRight', shift: false, typing: false, keys: ']', label: '다음 세션 (목록 아래)' },
  { id: 'toggle-sidebar', code: 'Backslash', shift: false, typing: true, keys: '\\', label: '사이드바 열기/닫기' },
  { id: 'settings', code: 'Comma', shift: false, typing: true, keys: ',', label: '설정' },
  { id: 'help', code: 'Slash', shift: false, typing: true, keys: '/', label: '단축키 보기' },
];

/** `code` fallback from `key` for synthetic events / old browsers. */
const KEY_TO_CODE: Record<string, string> = { k: 'KeyK', n: 'KeyN', o: 'KeyO', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', '/': 'Slash', ',': 'Comma' };

export function isMacPlatform(nav: { platform?: string; userAgent?: string } | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(nav?.platform || nav?.userAgent || '');
}

/** Focus is somewhere text is typed. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes((el as HTMLInputElement).type);
}

export type ShortcutKey = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'> & { isComposing?: boolean; keyCode?: number };

/** The shortcut this keydown is, or null. Never during IME composition. */
export function matchShortcut(e: ShortcutKey, opts: { mac: boolean; typing: boolean }): ShortcutId | null {
  if (e.isComposing || e.keyCode === 229) return null;
  const mod = opts.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey) return null;
  const code = e.code || KEY_TO_CODE[e.key.toLowerCase()] || '';
  const b = BINDINGS.find((x) => x.code === code && x.shift === e.shiftKey);
  if (!b || (opts.typing && !b.typing)) return null;
  return b.id;
}

/** 고정됨 rows with a number shortcut: ⌘1 … ⌘9. */
export const PIN_KEYS = 9;

/** ⌘/Ctrl alone — no Shift or Alt, and not the other platform's modifier. */
export function isPlainMod(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac: boolean): boolean {
  return (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.shiftKey && !e.altKey;
}

/**
 * ⌘1 … ⌘9 (Ctrl elsewhere): the index of the 고정됨 row this keydown opens, or null. By physical key, top row only;
 * never with Shift / Alt or during IME composition. A repeat matches too, so the caller can keep the browser's own ⌘N off it.
 */
export function matchPinShortcut(e: ShortcutKey, mac: boolean): number | null {
  if (e.isComposing || e.keyCode === 229 || !isPlainMod(e, mac)) return null;
  const digit = /^Digit([1-9])$/.exec(e.code || '') ?? (e.code ? null : /^([1-9])$/.exec(e.key));
  return digit ? Number(digit[1]) - 1 : null;
}

/** The hint on the nth 고정됨 row ("⌘1"), or null past the ninth. */
export function pinKeyLabel(index: number, mac: boolean): string | null {
  return index < PIN_KEYS ? `${mac ? '⌘' : 'Ctrl+'}${index + 1}` : null;
}

/** Cheat-sheet rows: key label with the platform's modifier. */
export function shortcutList(mac: boolean): { id: ShortcutId; keys: string; label: string }[] {
  const mod = mac ? '⌘' : 'Ctrl+';
  return BINDINGS.map((b) => ({ id: b.id, keys: `${mod}${b.keys}`, label: b.label }));
}
