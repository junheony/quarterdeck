import { describe, expect, it } from 'vitest';
import { elsewhereNotice } from './elsewhereNotice';

describe('elsewhereNotice', () => {
  it('names the conversation, the other app, and how long ago', () => {
    const t = elsewhereNotice({ engine: 'claude', title: ' 버그 고치기 ', ageMs: 5 * 60_000 });
    expect(t.startsWith('「버그 고치기」 대화의 기록 파일이 5분 전에 deck 밖(Claude Desktop 또는 Claude CLI)에서 바뀌었어요.')).toBe(true);
    expect(t).toContain('한 곳에서만 이어 쓰세요');
    expect(t).toContain('두 갈래로 나뉩니다');
  });

  it('under a minute is 방금; no title says 이 대화; codex names the Codex app', () => {
    expect(elsewhereNotice({ engine: 'claude', title: null, ageMs: 59_000 })).toMatch(/^이 대화의 기록 파일이 방금 deck 밖/);
    expect(elsewhereNotice({ engine: 'claude', title: null, ageMs: 90_000 })).toContain('1분 전에');
    expect(elsewhereNotice({ engine: 'codex', title: '', ageMs: -5 })).toMatch(/^이 GPT 대화의 기록 파일이 방금 deck 밖\(Codex 앱 또는 Codex CLI\)/);
  });
});
