import { describe, expect, it } from 'vitest';
import type { AccountUsage, UsageSnapshot } from '../../shared/usage-types';
import { chooseAutoModel, classifyPrompt } from './AutoModel';
import { testRegistry } from '../../shared/accounts.testkit';

const NOW = Date.parse('2026-10-01T03:00:00Z');

function acct(weekly: number, fable: number | null = 10): AccountUsage {
  return { status: 'ok', fetchedAt: new Date(NOW).toISOString(), fiveHour: { usedPct: 10, resetsAt: null }, weekly: { usedPct: weekly, resetsAt: null }, fable: fable === null ? null : { usedPct: fable, resetsAt: null } };
}

function usage(a: AccountUsage, b: AccountUsage = a, c: AccountUsage = a): UsageSnapshot {
  return { generatedAt: new Date(NOW).toISOString(), deckReachable: true, accounts: { a, b, c } };
}

const auto = (text: string, u: UsageSnapshot = usage(acct(30)), attachmentCount = 0) =>
  chooseAutoModel({ text, attachmentCount, usage: u, nowMs: NOW, cooldownUntilMs: {}, protectedAccount: null, accounts: testRegistry() });

describe('classifyPrompt', () => {
  it.each([
    ['이 함수 이름 뭐야?', 'sonnet'],
    ['README 오타 고쳐줘', 'sonnet'],
    ['what does useElapsed return?', 'sonnet'],
    ['rename fooBar to fooBaz in utils.ts', 'sonnet'],
    ['ls', 'sonnet'],
    ['세션 목록 보여줘', 'sonnet'],
  ])('easy: %s → %s', (text, model) => {
    expect(classifyPrompt(text).model).toBe(model);
  });

  it.each([
    ['로그인 페이지에 비밀번호 재설정 기능을 구현해줘', 'opus'],
    ['업로드할 때 500 에러가 나는 버그 고쳐줘', 'opus'],
    ['Implement pagination for the sessions endpoint and update the UI', 'opus'],
    ['fix the bug where the sidebar loses its scroll position', 'opus'],
    ['refactor TurnRunner so Codex and Claude share the result handling', 'opus'],
  ])('medium: %s → %s', (text, model) => {
    expect(classifyPrompt(text).model).toBe(model);
  });

  it.each([
    ['멀티 계정 라우팅 구조를 새로 설계해줘. 쿨다운, 세션 이전, 캐시 보존을 모두 고려해야 해', 'fable'],
    ['이 인증 흐름에 보안 취약점이 있는지 검토해줘', 'fable'],
    ['테스트가 간헐적으로 실패하는데 원인을 모르겠어', 'fable'],
    ['Design the architecture for a plugin system with sandboxed extensions', 'fable'],
    ['We have a race condition somewhere in the websocket reconnect path, no idea why', 'fable'],
    ['Do a security review of the attachment upload handler', 'fable'],
  ])('hard: %s → %s', (text, model) => {
    expect(classifyPrompt(text).model).toBe(model);
  });

  it('a short question that only mentions a hard topic stays a lookup', () => {
    expect(classifyPrompt('아키텍처 문서 어디 있어?').model).toBe('sonnet');
    expect(classifyPrompt('where is the architecture doc?').model).toBe('sonnet');
  });

  it('long prompts and many attachments are at least Opus', () => {
    expect(classifyPrompt('x '.repeat(1000)).model).toBe('opus');
    expect(classifyPrompt('이 스크린샷들 비교해서 정리', 3).model).toBe('opus');
    expect(classifyPrompt('이 스크린샷 봐줘', 1).model).toBe('sonnet');
  });

  it('a medium-length prompt without cues defaults to Opus', () => {
    expect(classifyPrompt('오늘 작업한 내용을 바탕으로 다음 단계에 해야 할 일을 차례대로 정리하고 각각 얼마나 걸릴지 추정해 줘. '.repeat(5)).model).toBe('opus');
  });
});

describe('chooseAutoModel', () => {
  it('reason reads "자동 → <model> · <why>" with the auto effort', () => {
    expect(auto('이 함수 이름 뭐야?')).toEqual({ model: 'sonnet', effort: 'medium', reason: '자동 → Sonnet 5.5 · 짧은 조회' });
    expect(auto('버그 고쳐줘')).toEqual({ model: 'opus', effort: 'high', reason: '자동 → Opus 5.5 · 구현·버그' });
    expect(auto('보안 취약점 검토해줘')).toMatchObject({ model: 'fable', effort: 'high' });
  });

  it('Fable 80% subcap: no Fable-eligible account → Opus', () => {
    const r = auto('보안 취약점 검토해줘', usage(acct(30, 85)));
    expect(r.model).toBe('opus');
    expect(r.reason).toContain('Fable 80%↑ → Opus');
    // One eligible account is enough.
    expect(auto('보안 취약점 검토해줘', usage(acct(30, 85), acct(30, 20))).model).toBe('fable');
  });

  it('steps one tier down when even the best account is at the weekly switch line', () => {
    const high = usage(acct(90));
    expect(auto('버그 고쳐줘', high)).toMatchObject({ model: 'sonnet', effort: 'medium' });
    expect(auto('버그 고쳐줘', high).reason).toContain('주간 90%');
    expect(auto('보안 취약점 검토해줘', high).model).toBe('opus');
    expect(auto('이 함수 이름 뭐야?', high).model).toBe('sonnet');
    // One roomy account keeps the tier.
    expect(auto('버그 고쳐줘', usage(acct(90), acct(40))).model).toBe('opus');
  });

  it('unknown usage never steps down (Fable falls back to Opus, the router decides the rest)', () => {
    const down: AccountUsage = { status: 'down', fetchedAt: null, fiveHour: null, weekly: null, fable: null };
    expect(auto('버그 고쳐줘', usage(down)).model).toBe('opus');
    expect(auto('보안 취약점 검토해줘', usage(down)).model).toBe('opus');
  });
});

describe("chooseAutoModel — usage-deck 을 본 적 없는 설치 (usageSource: 'none')", () => {
  const down: AccountUsage = { status: 'down', fetchedAt: null, fiveHour: null, weekly: null, fable: null };
  const lax = (u: UsageSnapshot): UsageSnapshot => ({ ...u, usageSource: 'none' });

  it('unknown usage keeps Fable, and the reason says the usage is unknown', () => {
    const r = auto('보안 취약점 검토해줘', lax(usage(down)));
    expect(r).toMatchObject({ model: 'fable', effort: 'high' });
    expect(r.reason).toContain('Fable 잔여량 모름');
    expect(r.reason).not.toContain('Opus');
    // Known 5h/weekly from a turn, no Fable row: still Fable.
    expect(auto('보안 취약점 검토해줘', lax(usage(acct(30, null)))).model).toBe('fable');
    expect(auto('버그 고쳐줘', lax(usage(down))).model).toBe('opus');
  });

  it('a known Fable ≥ 80% everywhere still falls back to Opus', () => {
    const r = auto('보안 취약점 검토해줘', lax(usage(acct(30, 85))));
    expect(r.model).toBe('opus');
    expect(r.reason).toContain('Fable 80%↑ → Opus');
  });

  it('every account cooling down: still Fable — a cooldown is no reason to change the model', () => {
    const cooldownUntilMs = { a: NOW + 60_000, b: NOW + 60_000, c: NOW + 60_000 };
    const r = chooseAutoModel({ text: '보안 취약점 검토해줘', attachmentCount: 0, usage: lax(usage(down)), nowMs: NOW, cooldownUntilMs, protectedAccount: null, accounts: testRegistry() });
    expect(r.model).toBe('fable');
    expect(r.reason).not.toContain('Opus');
    // With usage-deck the same input is an Opus turn, as before.
    expect(chooseAutoModel({ text: '보안 취약점 검토해줘', attachmentCount: 0, usage: usage(down), nowMs: NOW, cooldownUntilMs, protectedAccount: null, accounts: testRegistry() }).model).toBe('opus');
  });

  it("with usage-deck: unknown Fable → Opus, and the reason says it is unknown (not '80%↑')", () => {
    const r = auto('보안 취약점 검토해줘', usage(down));
    expect(r.model).toBe('opus');
    expect(r.reason).toContain('Fable 잔여량 모름(usage-deck 값 없음) → Opus');
    expect(r.reason).not.toContain('80%↑');
  });
});

describe('chooseAutoModel — 쓸 계정이 없는데 Fable 값은 알려진 경우', () => {
  /** Every account at 5h 96% with Fable known at 10%: no candidate, and nothing about Fable is unknown. */
  const full: AccountUsage = { ...acct(30, 10), fiveHour: { usedPct: 96, resetsAt: null } };

  it('with usage-deck: still Opus, and the reason says no account can take Fable — not an unknown Fable value', () => {
    const r = auto('보안 취약점 검토해줘', usage(full));
    expect(r.model).toBe('opus');
    expect(r.reason).toContain('Fable 로 쓸 수 있는 계정 없음 → Opus');
    expect(r.reason).not.toContain('모름');
    // One account without a Fable value: unknown is true again, and said.
    expect(auto('보안 취약점 검토해줘', usage(full, { ...full, fable: null })).reason).toContain('Fable 잔여량 모름(usage-deck 값 없음) → Opus');
  });

  it('without usage-deck: Fable stays, and no "Fable 잔여량 모름" note is added', () => {
    const r = auto('보안 취약점 검토해줘', { ...usage(full), usageSource: 'none' });
    expect(r.model).toBe('fable');
    expect(r.reason).toMatch(/^자동 → Fable [^·]* · 설계·보안·원인 불명$/);
  });
});
