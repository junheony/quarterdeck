// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MessageView } from './MessageView';
import { setFeatures } from '../features';
import { isAbortError, isFailedTurn, isStoppedTurn } from './TurnBadge';

const mk = (inputTokens: number, outputTokens: number, cacheReadTokens = 0) =>
  ({ account: 'b', model: 'opus', reason: '가장 여유', modelNote: null, usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens: 0 } }) as never;

const turn = (badge: never, extra: { text?: string; error?: string | null; streaming?: boolean; interrupted?: true } = {}) =>
  ({ kind: 'assistant' as const, turnId: 't', text: extra.text ?? '', toolCalls: [], badge, streaming: extra.streaming ?? false, error: extra.error ?? null, notes: [], attempts: [], ...(extra.interrupted ? { interrupted: true as const } : {}) });

/** Abort-looking texts that are real failures (not a stop the user asked for). */
const REAL_FAILURES = ['API Error: Request was aborted.', 'The operation was aborted due to timeout', 'MCP error -32800: Request cancelled', 'Claude Code process exited with code 1\nstderr: AbortError: This operation was aborted', '서버가 다시 시작되어 중단됨'];

describe('isStoppedTurn', () => {
  it('zero input and zero output tokens is a stopped turn', () => {
    expect(isStoppedTurn({ badge: mk(0, 0) })).toBe(true);
    expect(isStoppedTurn({ badge: mk(0, 0, 5000), text: 'x' })).toBe(true);
  });
  it('the server interrupt error (중단됨), an older server\'s "aborted by user", or a turn this client interrupted is stopped even with tokens', () => {
    expect(isStoppedTurn({ badge: mk(10, 5), error: '중단됨', text: 'partial' })).toBe(true);
    expect(isStoppedTurn({ badge: mk(10, 5), error: 'Claude Code process aborted by user', text: 'p' })).toBe(true);
    expect(isStoppedTurn({ badge: mk(10, 5), error: 'API Error: Request was aborted.', text: 'p', interrupted: true })).toBe(true);
  });
  it('a server that labels its own interrupts (features abortLabel): the SDK text is a real failure, 중단됨 still a stop', () => {
    setFeatures(['abortLabel']);
    try {
      expect(isAbortError('Claude Code process aborted by user')).toBe(false);
      expect(isAbortError('중단됨')).toBe(true);
      expect(isAbortError('Claude Code process aborted by user', true)).toBe(true);
    } finally { setFeatures(undefined); }
  });
  it('other abort/cancel texts are real failures: not stopped once there is output, and 실패 not 중단됨', () => {
    for (const error of REAL_FAILURES) {
      expect(isAbortError(error)).toBe(false);
      expect(isStoppedTurn({ badge: mk(10, 5), error, text: 'p' })).toBe(false);
      expect(isFailedTurn({ error })).toBe(true);
      expect(isFailedTurn({ error, interrupted: true })).toBe(false);
    }
  });
  it('an error with no output text and no output tokens is stopped; a normal turn is not', () => {
    expect(isStoppedTurn({ badge: mk(1200, 0), error: '한도 초과', text: '' })).toBe(true);
    expect(isStoppedTurn({ badge: mk(1200, 40), error: '한도 초과', text: 'half an answer' })).toBe(false);
    expect(isStoppedTurn({ badge: mk(1200, 340), text: 'ok' })).toBe(false);
  });
});

describe('TurnBadge stopped rendering', () => {
  afterEach(cleanup);

  it('a zero-token turn shows 중단됨 instead of 입력 0 · 출력 0, keeping account, model and reason', () => {
    const { container } = render(<MessageView item={turn(mk(0, 0))} />);
    const b = container.querySelector('.turn-badge')!;
    expect(b.classList.contains('stopped')).toBe(true);
    expect(b.querySelector('.tb-stopped')?.textContent).toBe('중단됨');
    expect(b.textContent).not.toContain('입력 0');
    for (const s of ['B', '가장 여유']) expect(b.textContent).toContain(s);
    expect(b.querySelector('.tb-stopped')?.getAttribute('title')).toContain('입력 0');
  });

  it('an interrupted turn does not repeat "오류: 중단됨" under the pill', () => {
    const { container } = render(<MessageView item={turn(mk(0, 0), { error: '중단됨' })} />);
    expect(container.querySelector('.error')).toBeNull();
    expect(container.querySelector('.tb-stopped')).not.toBeNull();
  });

  it('a turn stopped mid-way with the raw SDK abort text (an older server) shows no "오류:" line either — with or without output', () => {
    const raw = 'Claude Code process aborted by user\nError: aborted\n    at Query.readMessages (sdk.mjs:1)';
    for (const item of [turn(mk(0, 0), { error: raw }), turn(mk(120, 40), { error: raw, text: '반쯤 쓴 답' })]) {
      const { container } = render(<MessageView item={item} />);
      expect(container.querySelector('.error')).toBeNull();
      expect(container.querySelector('.tb-stopped')?.textContent).toBe('중단됨');
      cleanup();
    }
  });

  it('a turn that failed before any output (not an interrupt) says 실패, not 중단됨, and keeps its error line', () => {
    const msg = '이 GPT 스레드를 다른 프로그램이 쓰고 있어 deck 에서 이어갈 수 없습니다';
    const { container } = render(<MessageView item={turn(mk(0, 0), { error: msg })} />);
    expect(container.querySelector('.tb-stopped')?.textContent).toBe('실패');
    expect(container.querySelector('.error')?.textContent).toContain(msg);
    cleanup();
    expect(render(<MessageView item={turn(mk(0, 0), { error: '중단됨' })} />).container.querySelector('.tb-stopped')?.textContent).toBe('중단됨');
  });

  it('abort-looking real failures keep their "오류:" line and say 실패; the same text after this client\'s interrupt is hidden', () => {
    for (const error of REAL_FAILURES) {
      for (const item of [turn(mk(0, 0), { error }), turn(mk(120, 40), { error, text: '반쯤 쓴 답' })]) {
        const { container } = render(<MessageView item={item} />);
        expect(container.querySelector('.error')?.textContent).toContain(error.split('\n')[0]);
        if (item.text === '') expect(container.querySelector('.tb-stopped')?.textContent).toBe('실패');
        cleanup();
      }
      const { container } = render(<MessageView item={turn(mk(120, 40), { error, text: 'p', interrupted: true })} />);
      expect(container.querySelector('.error')).toBeNull();
      expect(container.querySelector('.tb-stopped')?.textContent).toBe('중단됨');
      cleanup();
    }
  });

  it('a real error keeps its error line; a normal turn shows token counts', () => {
    const e = render(<MessageView item={turn(mk(0, 0), { error: '엔진이 결과 없이 종료했습니다' })} />);
    expect(e.container.querySelector('.error')?.textContent).toContain('엔진이 결과 없이');
    cleanup();
    const { container } = render(<MessageView item={turn(mk(1200, 340), { text: 'ok' })} />);
    expect(container.querySelector('.tb-stopped')).toBeNull();
    expect(container.querySelector('.tb-tokens')?.textContent).toContain('입력 1.2k');
  });
});

describe('TurnBadge cache rewrite note', () => {
  afterEach(cleanup);
  it('marks 캐시 쓰기 with the cold-write reason as its tooltip', () => {
    const item = { ...turn(mk(1200, 340), { text: 'ok' }), cacheNote: '캐시 새로 씀 · 계정 전환' };
    const { container } = render(<MessageView item={item} />);
    expect(container.querySelector('.tb-cold')?.getAttribute('title')).toBe('캐시 새로 씀 · 계정 전환');
    cleanup();
    expect(render(<MessageView item={turn(mk(1200, 340), { text: 'ok' })} />).container.querySelector('.tb-cold')).toBeNull();
  });
});
