import { describe, expect, it } from 'vitest';
import { PERM_MODES, isPermMode, nextPermMode, permModeFromAutoApprove, sdkPermMode } from './permission';

describe('permission modes', () => {
  it('Shift+Tab cycles 매번 묻기 → 편집 자동 승인 → 계획 모드 → 모두 자동 승인 → 매번 묻기', () => {
    expect(PERM_MODES.map(nextPermMode)).toEqual(['acceptEdits', 'plan', 'bypassPermissions', 'default']);
  });

  it('maps to the SDK mode; 모두 자동 승인 is never handed over as bypassPermissions', () => {
    expect(sdkPermMode('default')).toBe('default');
    expect(sdkPermMode('acceptEdits')).toBe('acceptEdits');
    expect(sdkPermMode('plan')).toBe('plan');
    expect(sdkPermMode('bypassPermissions')).toBe('default');
  });

  it('migrates the old 자동 승인 switch and validates', () => {
    expect(permModeFromAutoApprove(true)).toBe('bypassPermissions');
    expect(permModeFromAutoApprove(false)).toBe('default');
    expect(isPermMode('plan')).toBe(true);
    expect(isPermMode('dontAsk')).toBe(false);
    expect(isPermMode(1)).toBe(false);
  });
});
