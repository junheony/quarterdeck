import { describe, expect, it } from 'vitest';
import { deleteBlockedReason, menuStep } from './SessionMenu';

describe('menuStep (roving focus)', () => {
  it('moves and wraps with ↑/↓, jumps with Home/End', () => {
    expect(menuStep(0, 'ArrowDown', 3)).toBe(1);
    expect(menuStep(2, 'ArrowDown', 3)).toBe(0);
    expect(menuStep(0, 'ArrowUp', 3)).toBe(2);
    expect(menuStep(1, 'Home', 3)).toBe(0);
    expect(menuStep(1, 'End', 3)).toBe(2);
  });
  it('from no focused item: ↓ goes to the first, ↑ to the last', () => {
    expect(menuStep(-1, 'ArrowDown', 3)).toBe(0);
    expect(menuStep(-1, 'ArrowUp', 3)).toBe(2);
  });
  it('other keys and empty menus do not move', () => {
    expect(menuStep(0, 'Enter', 3)).toBeNull();
    expect(menuStep(0, 'a', 3)).toBeNull();
    expect(menuStep(-1, 'ArrowDown', 0)).toBeNull();
  });
});

describe('deleteBlockedReason', () => {
  it('only Claude transcripts can be deleted', () => {
    expect(deleteBlockedReason({ account: 'b' })).toBeNull();
    expect(deleteBlockedReason({ account: 'gpt', engine: 'codex', imported: true })).toBe('Codex 앱 기록은 deck에서 지울 수 없어요');
    expect(deleteBlockedReason({ account: 'gpt', engine: 'codex' })).toMatch(/GPT/);
    expect(deleteBlockedReason({ account: 'a', engine: 'gemini' })).toMatch(/Gemini/);
  });
});
