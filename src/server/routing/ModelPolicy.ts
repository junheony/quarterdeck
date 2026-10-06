import { FABLE_MAX_PCT, type ClaudeModel } from '../../shared/models';

/**
 * Values for Options.model: exact versions, so the picker's "Opus 5.5" is what runs. Verified 2026-10-01 with the SDK's
 * supportedModels() (agent-sdk 0.3.285): alias opus → resolvedModel claude-opus-5-5, sonnet → claude-sonnet-5-5,
 * and the Fable row's value is claude-fable-5-1.
 */
export const MODEL_ARG: Record<ClaudeModel, string> = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' };

export { FABLE_MAX_PCT };

export function resolveModel(
  requested: ClaudeModel | undefined,
  sessionDefault: ClaudeModel,
  fableUsedPct: number | null,
  /** 'none' (an install that never saw usage-deck): an unknown Fable value is no reason to leave Fable. */
  usageSource: 'deck' | 'none' = 'deck',
): { model: ClaudeModel; downgraded: boolean; note: string | null } {
  const wanted = requested ?? sessionDefault;
  if (wanted !== 'fable') return { model: wanted, downgraded: false, note: null };
  if (fableUsedPct === null && usageSource === 'none') return { model: 'fable', downgraded: false, note: null };
  if (fableUsedPct === null) return { model: 'opus', downgraded: true, note: 'Fable 잔여량 불명 → Opus 로 대체' };
  if (fableUsedPct >= FABLE_MAX_PCT) return { model: 'opus', downgraded: true, note: `Fable ${fableUsedPct}% 이상 → Opus 로 대체` };
  return { model: 'fable', downgraded: false, note: null };
}
