// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { claimReload, hasDraftText, hasOpenModal, isNewBuild, loadDraft, saveDraft, shouldAutoReload } from './autoReload';
import { initialState, newPane, type AppState } from './state';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
const safe = (patch: Partial<AppState> = {}) => ({ draftText: false, state: { ...initialState, ...patch } });

describe('shouldAutoReload', () => {
  it('reloads when nothing is at stake', () => expect(shouldAutoReload(safe())).toBe(true));
  it('not with draft text in a composer', () => expect(shouldAutoReload({ ...safe(), draftText: true })).toBe(false));
  it('not with pending attachments in any pane', () => {
    const p = { ...newPane('p0'), attachments: [{ id: 'a', name: 'x', isImage: false }] } as unknown as ReturnType<typeof newPane>;
    expect(shouldAutoReload(safe({ panes: [p] }))).toBe(false);
  });
  it('not while the focused pane runs a turn, but another pane running is fine', () => {
    const run = { ...newPane('p0'), activeTurnId: 't1' };
    expect(shouldAutoReload(safe({ panes: [run] }))).toBe(false);
    expect(shouldAutoReload(safe({ panes: [run, newPane('p1')], activePaneId: 'p1' }))).toBe(true);
  });
  it('not while a modal (palette, cheat sheet, confirm) is open', () => {
    expect(shouldAutoReload({ ...safe(), modalOpen: true })).toBe(false);
    const root = document.createElement('div');
    expect(hasOpenModal(root)).toBe(false);
    root.innerHTML = '<div role="dialog" aria-modal="true"></div>';
    expect(hasOpenModal(root)).toBe(true);
  });
  it('the new-chat start box counts as a draft', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="newchat"><textarea></textarea></div>';
    expect(hasDraftText(root)).toBe(false);
    root.querySelector('textarea')!.value = '안녕';
    expect(hasDraftText(root)).toBe(true);
  });
  it('not with an open permission or question card', () => {
    expect(shouldAutoReload(safe({ pending: [{ requestId: 'r' } as never] }))).toBe(false);
    expect(shouldAutoReload(safe({ questions: [{ requestId: 'q' } as never] }))).toBe(false);
  });
});

describe('isNewBuild', () => {
  it('needs a baseline and a different non-null id', () => {
    expect(isNewBuild('a', 'b')).toBe(true);
    expect(isNewBuild('a', 'a')).toBe(false);
    expect(isNewBuild('a', null)).toBe(false);
    expect(isNewBuild(null, 'b')).toBe(false);
    expect(isNewBuild(undefined, 'b')).toBe(false);
  });
});

describe('claimReload / drafts', () => {
  it('allows one reload per build id', () => {
    const s = mem();
    expect(claimReload('b1', s)).toBe(true);
    expect(claimReload('b1', s)).toBe(false);
    expect(claimReload('b2', s)).toBe(true);
  });
  it('keeps a session draft, drops it when emptied, ignores sessions without an id', () => {
    const s = mem();
    saveDraft('s1', '초안', s);
    expect(loadDraft('s1', s)).toBe('초안');
    saveDraft('s1', '', s);
    expect(loadDraft('s1', s)).toBe('');
    saveDraft(null, 'x', s);
    expect(loadDraft(null, s)).toBe('');
  });
});
