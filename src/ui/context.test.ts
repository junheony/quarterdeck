import { describe, expect, it } from 'vitest';
import { contextWindowOf } from '../shared/models';
import { contextUsageOf } from '../shared/turn-types';
import { COLD_HINT, LONG_HINT, WARM_MS, cacheHitPct, coldWriteNote, contextHint, contextLabel, contextPct, contextTokens, fmtTokens, isCacheCold, isLongContext, latestContext, type ContextInfo } from './context';

const ctx = (inputTokens: number, cacheReadTokens: number, cacheCreationTokens: number, over: Partial<ContextInfo> = {}): ContextInfo =>
  ({ usage: { inputTokens, cacheReadTokens, cacheCreationTokens }, window: 1_000_000, at: 0, model: 'opus', account: 'b', ...over });

describe('context size', () => {
  it('is input + cache read + cache write of one call', () => {
    expect(contextTokens({ inputTokens: 2_000, cacheReadTokens: 300_000, cacheCreationTokens: 10_000 })).toBe(312_000);
  });
  it('contextUsageOf reads an API usage object; empty/synthetic usage is null', () => {
    expect(contextUsageOf({ input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 9 })).toEqual({ inputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 20 });
    expect(contextUsageOf({ input_tokens: 0, output_tokens: 0 })).toBeNull();
    expect(contextUsageOf(undefined)).toBeNull();
  });
  it('cache hit % is the cached share of the context', () => {
    expect(cacheHitPct({ inputTokens: 2_000, cacheReadTokens: 300_000, cacheCreationTokens: 10_000 })).toBe(96);
    expect(cacheHitPct({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBeNull();
  });
  it('fill % is capped at 100', () => {
    expect(contextPct(312_000, 1_000_000)).toBe(31);
    expect(contextPct(250_000, 200_000)).toBe(100);
  });
  it('formats tokens and the tooltip', () => {
    expect([fmtTokens(850), fmtTokens(12_400), fmtTokens(312_000), fmtTokens(1_000_000), fmtTokens(1_200_000)]).toEqual(['850', '12k', '312k', '1M', '1.2M']);
    expect(contextLabel(ctx(2_000, 300_000, 10_000))).toBe('컨텍스트 312k / 1M · 캐시 적중 96%');
  });
  it('window: 1M for current Claude models and [1m], 200k for Haiku, old models and unknowns', () => {
    for (const m of ['opus', 'sonnet', 'fable', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-sonnet-4-5[1m]']) expect(contextWindowOf(m)).toBe(1_000_000);
    for (const m of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'gpt-6-sol', null, '<synthetic>']) expect(contextWindowOf(m)).toBe(200_000);
  });
  it('latestContext takes the last item that carries one', () => {
    const a = ctx(1, 2, 3);
    const b = ctx(4, 5, 6);
    expect(latestContext([{ kind: 'assistant', ctx: a }, { kind: 'user' }, { kind: 'assistant', ctx: b }, { kind: 'assistant' }])).toBe(b);
    expect(latestContext([{ kind: 'user' }])).toBeNull();
  });
});

describe('hints', () => {
  it('long: ≥ 60% of the window or ≥ 300k tokens', () => {
    expect(isLongContext(120_000, 200_000)).toBe(true);
    expect(isLongContext(119_000, 200_000)).toBe(false);
    expect(isLongContext(300_000, 1_000_000)).toBe(true);
    expect(isLongContext(299_000, 1_000_000)).toBe(false);
  });
  it('idle: cache counts as cold after 55 minutes; unknown time is never cold', () => {
    expect(isCacheCold(0, WARM_MS)).toBe(false);
    expect(isCacheCold(0, WARM_MS + 1)).toBe(true);
    expect(isCacheCold(null, 1e13)).toBe(false);
  });
  it('one hint line: cache expiry wins over the long-session hint', () => {
    expect(contextHint(null, 0)).toBeNull();
    expect(contextHint(ctx(0, 100_000, 0, { at: 0 }), 60_000)).toBeNull();
    expect(contextHint(ctx(0, 400_000, 0, { at: 0 }), 60_000)).toBe(LONG_HINT);
    expect(contextHint(ctx(0, 400_000, 0, { at: 0 }), WARM_MS + 1)).toBe(COLD_HINT);
  });
});

describe('coldWriteNote', () => {
  const u = (cacheReadTokens: number, cacheCreationTokens: number) => ({ inputTokens: 3, outputTokens: 100, cacheReadTokens, cacheCreationTokens });
  const cur = { account: 'b' as const, model: 'opus', reason: 'B 유지 · 캐시 따뜻함(3분 전)', startedAt: 10 * 60_000 };
  it('a warm turn (reads the cache) or a small write gets no note', () => {
    expect(coldWriteNote(u(200_000, 5_000), ctx(0, 1, 0), cur)).toBeNull();
    expect(coldWriteNote(u(0, 4_000), ctx(0, 1, 0), cur)).toBeNull();
  });
  it('names the likely reason', () => {
    expect(coldWriteNote(u(0, 200_000), ctx(0, 1, 0, { account: 'c' }), cur)).toBe('캐시 새로 씀 · 계정 전환');
    expect(coldWriteNote(u(0, 200_000), ctx(0, 1, 0, { account: null }), { ...cur, reason: '5h 한도 → C 전환' })).toBe('캐시 새로 씀 · 계정 전환');
    expect(coldWriteNote(u(0, 200_000), ctx(0, 1, 0, { model: 'claude-sonnet-5-5' }), cur)).toBe('캐시 새로 씀 · 모델 전환');
    expect(coldWriteNote(u(0, 200_000), ctx(0, 1, 0, { model: 'claude-opus-5-5', at: 0 }), { ...cur, startedAt: 61 * 60_000 })).toBe('캐시 새로 씀 · 1시간 넘게 쉼');
    expect(coldWriteNote(u(0, 200_000), null, cur)).toBe('캐시 새로 씀 · 첫 턴');
    expect(coldWriteNote(u(0, 200_000), ctx(0, 1, 0), cur)).toBe('캐시 새로 씀');
  });
});
