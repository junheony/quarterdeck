import type { AppState } from './state';

/** Nothing the user would lose or be interrupted by: no attachments, no running turn on the focused pane, no open card, no open dialog. */
export type ReloadSafety = { draftText: boolean; /** A modal (⌘K palette, 사용량, confirm…) is open. */ modalOpen?: boolean; state: Pick<AppState, 'panes' | 'activePaneId' | 'pending' | 'questions'> };

/** Reload now only when it cannot lose or interrupt anything; otherwise the caller shows the "새 버전" pill. */
export function shouldAutoReload({ draftText, modalOpen = false, state }: ReloadSafety): boolean {
  if (draftText || modalOpen) return false;
  if (state.panes.some((p) => p.attachments.length > 0)) return false;
  const focused = state.panes.find((p) => p.id === state.activePaneId) ?? state.panes[0];
  if (focused?.activeTurnId) return false;
  return state.pending.length === 0 && state.questions.length === 0;
}

/** A later hello with a different, non-null build id (the first hello's id is the baseline). */
export function isNewBuild(first: string | null | undefined, now: string | null | undefined): boolean {
  return !!first && !!now && first !== now;
}

const GUARD_KEY = 'deck.reloadedFor';

/** Loop guard: true once per build id (the id is remembered in sessionStorage before the reload). */
export function claimReload(build: string, store: Pick<Storage, 'getItem' | 'setItem'> | null = sessionStorage): boolean {
  try {
    if (store?.getItem(GUARD_KEY) === build) return false;
    store?.setItem(GUARD_KEY, build);
  } catch { /* storage unavailable: still reload once; the next page load adopts the new id as its baseline */ }
  return true;
}

/** Any composer holding unsent text (the draft lives in Chat's local state, so the DOM is the source of truth). */
export function hasDraftText(root: ParentNode = document): boolean {
  return Array.from(root.querySelectorAll<HTMLTextAreaElement>('.composer textarea, .newchat textarea')).some((t) => t.value.trim().length > 0);
}

/** Any modal dialog on screen (the DOM is the source of truth: palette, cheat sheet, 사용량, confirm). */
export function hasOpenModal(root: ParentNode = document): boolean {
  return root.querySelector('[aria-modal="true"]') !== null;
}

const DRAFT_PREFIX = 'deck.draft.';

/** A session's unsent composer text survives a reload (sessionStorage; a brand-new session has no id and is not kept). */
export function loadDraft(sessionId: string | null | undefined, store: Pick<Storage, 'getItem'> | null = sessionStorage): string {
  if (!sessionId) return '';
  try { return store?.getItem(DRAFT_PREFIX + sessionId) ?? ''; } catch { return ''; }
}

export function saveDraft(sessionId: string | null | undefined, text: string, store: Pick<Storage, 'setItem' | 'removeItem'> | null = sessionStorage): void {
  if (!sessionId) return;
  try { if (text) store?.setItem(DRAFT_PREFIX + sessionId, text); else store?.removeItem(DRAFT_PREFIX + sessionId); } catch { /* quota or disabled storage: the draft is just not kept */ }
}
