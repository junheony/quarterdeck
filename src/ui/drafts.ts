const DRAFT_PREFIX = 'deck.draft.';

/**
 * How long an unsent composer draft is kept. Drafts live in localStorage (iOS kills a backgrounded PWA and its
 * sessionStorage with it), so without a TTL a draft of a session never reopened would sit there forever.
 */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Stored = { text: string; at: number };

// Resolved per call: touching `localStorage` can throw (disabled storage, sandboxed frame) or be absent (node).
function local(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** The new-chat composer of a pane (one NewChat per empty pane); it has no session id yet. */
export function newChatDraftKey(paneId: string): string {
  return `new:${paneId}`;
}

/** A composer's unsent text survives a reload or a killed PWA process; expired or unreadable entries read as empty. */
export function loadDraft(key: string | null | undefined, store: Pick<Storage, 'getItem' | 'removeItem'> | null = local()): string {
  if (!key) return '';
  try {
    const raw = store?.getItem(DRAFT_PREFIX + key);
    if (!raw) return '';
    const d = JSON.parse(raw) as Partial<Stored>;
    if (typeof d?.text !== 'string' || typeof d.at !== 'number') return '';
    if (Date.now() - d.at > DRAFT_TTL_MS) { store?.removeItem(DRAFT_PREFIX + key); return ''; }
    return d.text;
  } catch { return ''; }
}

/** Saves with a fresh timestamp; empty text drops the entry. A brand-new session without a key is not kept. */
export function saveDraft(key: string | null | undefined, text: string, store: Pick<Storage, 'setItem' | 'removeItem'> | null = local()): void {
  if (!key) return;
  if (!text) { clearDraft(key, store); return; }
  try { store?.setItem(DRAFT_PREFIX + key, JSON.stringify({ text, at: Date.now() } satisfies Stored)); } catch { /* quota or disabled storage: the draft is just not kept */ }
}

export function clearDraft(key: string | null | undefined, store: Pick<Storage, 'removeItem'> | null = local()): void {
  if (!key) return;
  try { store?.removeItem(DRAFT_PREFIX + key); } catch { /* disabled storage: nothing was kept either */ }
}
