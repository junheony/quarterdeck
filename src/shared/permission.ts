/**
 * Per-session permission modes (Claude Code / Desktop's Shift+Tab modes). `bypassPermissions` is deck's name for
 * 모두 자동 승인: it is never handed to the SDK as such — canUseTool allows each call (audited), so settings deny rules,
 * hooks and the handoff turn's tool block still apply.
 */
export const PERM_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
export type PermMode = (typeof PERM_MODES)[number];

export const PERM_MODE_LABEL: Record<PermMode, string> = {
  default: '매번 묻기',
  acceptEdits: '편집 자동 승인',
  plan: '계획 모드',
  bypassPermissions: '모두 자동 승인',
};

export const PERM_MODE_HINT: Record<PermMode, string> = {
  default: '도구 호출마다 권한 카드로 묻습니다',
  acceptEdits: '파일 편집은 묻지 않고 허용, 그 밖의 도구는 묻습니다',
  plan: '읽기만 하며 계획을 세웁니다. 계획이 나오면 승인 카드로 진행 여부를 묻습니다',
  bypassPermissions: '모든 도구 호출을 묻지 않고 허용합니다(감사 로그에 기록). 설정의 거부 규칙은 그대로 적용됩니다',
};

export function isPermMode(x: unknown): x is PermMode {
  return typeof x === 'string' && (PERM_MODES as readonly string[]).includes(x);
}

/** Shift+Tab: the next mode in PERM_MODES order, wrapping around. */
export function nextPermMode(m: PermMode): PermMode {
  return PERM_MODES[(PERM_MODES.indexOf(m) + 1) % PERM_MODES.length]!;
}

/** The SDK `Options.permissionMode` for a deck mode (bypass runs as 'default' + canUseTool auto-allow). */
export function sdkPermMode(m: PermMode): 'default' | 'acceptEdits' | 'plan' {
  return m === 'bypassPermissions' ? 'default' : m;
}

/** The old global 자동 승인 switch → the default mode for new sessions. */
export function permModeFromAutoApprove(autoApprove: boolean): PermMode {
  return autoApprove ? 'bypassPermissions' : 'default';
}
