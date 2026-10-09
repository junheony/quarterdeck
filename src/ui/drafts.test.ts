// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDraft, DRAFT_TTL_MS, loadDraft, newChatDraftKey, saveDraft } from './drafts';

describe('drafts', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.useRealTimers());

  it('lives in localStorage, so a fresh storage view (process killed by iOS) still reads it', () => {
    saveDraft('s1', '초안');
    // A new view over the same origin's storage: what the page sees after the PWA process is relaunched.
    const fresh = { getItem: (k: string) => localStorage.getItem(k), removeItem: (k: string) => localStorage.removeItem(k) };
    expect(loadDraft('s1', fresh)).toBe('초안');
    expect(sessionStorage.length).toBe(0);
  });

  it('expires after DRAFT_TTL_MS and removes the stale entry on read', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    saveDraft('s1', '오래된 초안');
    vi.setSystemTime(1_000_000 + DRAFT_TTL_MS - 1);
    expect(loadDraft('s1')).toBe('오래된 초안');
    vi.setSystemTime(1_000_000 + DRAFT_TTL_MS + 1);
    expect(loadDraft('s1')).toBe('');
    expect(localStorage.length).toBe(0);
  });

  it('saving refreshes the timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    saveDraft('s1', 'a');
    vi.setSystemTime(DRAFT_TTL_MS - 10);
    saveDraft('s1', 'ab');
    vi.setSystemTime(DRAFT_TTL_MS + 10);
    expect(loadDraft('s1')).toBe('ab');
  });

  it('clearDraft and an empty save drop it; no key is never kept; junk reads as empty', () => {
    saveDraft('s1', 'x');
    clearDraft('s1');
    expect(loadDraft('s1')).toBe('');
    saveDraft('s1', 'x');
    saveDraft('s1', '');
    expect(localStorage.length).toBe(0);
    saveDraft(null, 'x');
    expect(loadDraft(null)).toBe('');
    expect(localStorage.length).toBe(0);
    localStorage.setItem('deck.draft.bad', 'not json');
    expect(loadDraft('bad')).toBe('');
  });

  it('the new-chat composer has its own key per pane', () => {
    expect(newChatDraftKey('p0')).toBe('new:p0');
    saveDraft(newChatDraftKey('p0'), '새 대화');
    expect(loadDraft('new:p0')).toBe('새 대화');
    expect(loadDraft('new:p1')).toBe('');
  });

  it('broken storage never throws', () => {
    const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('x'); } };
    expect(loadDraft('s1', broken)).toBe('');
    expect(() => saveDraft('s1', 'x', broken)).not.toThrow();
    expect(() => clearDraft('s1', broken)).not.toThrow();
  });
});
