import { isTypingTarget } from './shortcuts';

/** The composers deck types into: an open chat's and the new-chat screen's. */
const COMPOSER = '.composer textarea, .newchat textarea';
/** Something on screen that owns the keyboard: a modal (palette, settings, confirm…), a popover dialog, a menu or a list. */
const POPUP = '[aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

export function hasOpenPopup(root: ParentNode = document): boolean {
  return root.querySelector(POPUP) !== null;
}

export function isComposer(el: Element | null): boolean {
  return !!el && el.matches(COMPOSER);
}

/** The composer of pane `paneId` (absent: the pane shows no composer, e.g. no projects yet). */
export function composerOf(paneId: string, root: ParentNode = document): HTMLTextAreaElement | null {
  return root.querySelector(`[data-pane="${paneId}"]`)?.querySelector<HTMLTextAreaElement>(COMPOSER) ?? null;
}

/**
 * Touch screens: focusing a textarea pops the on-screen keyboard over half the screen, so deck only moves focus by
 * itself with a mouse/trackpad as the primary pointer (Desktop; an iPad user taps the composer when they want to type).
 */
export function finePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
}

/**
 * May deck move focus to `target` (a pane's composer) now? Not over a palette/menu/dialog, and never out of a field the
 * user is typing in — a rename, 메시지 편집, or another pane's composer. From nowhere or a control just clicked (the
 * sidebar row that opened the chat) it may.
 */
export function canTakeFocus(doc: Document = document, target: Element | null = null): boolean {
  if (hasOpenPopup(doc)) return false;
  const a = doc.activeElement;
  return !isTypingTarget(a) || a === target;
}

/** Opening a chat / 새 채팅 / ⌘N / a pane switch: the caret goes to that pane's composer (end of any draft). */
export function focusComposer(paneId: string, opts: { fine?: boolean; doc?: Document } = {}): boolean {
  const doc = opts.doc ?? document;
  if (!(opts.fine ?? finePointer())) return false;
  const ta = composerOf(paneId, doc);
  if (!ta || !canTakeFocus(doc, ta)) return false;
  if (doc.activeElement !== ta) {
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  return true;
}

export type RoutedKey = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'> & { isComposing?: boolean; keyCode?: number; defaultPrevented?: boolean };

/**
 * Type-to-compose, for a key pressed while nothing editable has focus (Desktop): 'type' = printable ASCII, focus the
 * focused pane's composer and let the key land there; 'focus' = an IME / non-ASCII key (Korean jamo, Process, keyCode
 * 229): only focus the composer and swallow the key — re-targeting a composition mid-keystroke garbles it, so its first
 * jamo is lost instead. Never with ⌘/Ctrl/Alt (shortcuts), over a palette/menu/dialog, or for Space (it scrolls the
 * page or presses the focused button).
 */
export function routeKey(e: RoutedKey, ctx: { typing: boolean; popupOpen: boolean }): 'type' | 'focus' | null {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (ctx.typing || ctx.popupOpen) return null;
  if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return 'focus';
  if (/^[\x21-\x7E]$/.test(e.key)) return 'type';
  // One non-ASCII character (한글, é, an emoji…); not Enter, Tab, Escape, arrows, F-keys, Dead, Space…
  return [...e.key].length === 1 && !/^[\x00-\x7F]$/.test(e.key) ? 'focus' : null;
}

/** The keydown's context for routeKey, read from the DOM. */
export function routeContext(target: EventTarget | null, doc: Document = document): { typing: boolean; popupOpen: boolean } {
  return { typing: isTypingTarget(target), popupOpen: hasOpenPopup(doc) };
}
