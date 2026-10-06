export type ClaudeModel = 'sonnet' | 'opus' | 'fable';

/** Spec §4.2: Haiku and Luna are never used. */
export const CLAUDE_MODELS: readonly ClaudeModel[] = ['sonnet', 'opus', 'fable'];

/**
 * A new Claude session nobody picked a model for runs on Fable. Fable used ≥ FABLE_MAX_PCT (or unknown) on the account the
 * turn lands on → that turn runs on Opus (ModelPolicy.resolveModel); no Fable-eligible account at all → routed as Opus.
 */
export const DEFAULT_MODEL: ClaudeModel = 'fable';

/**
 * The stored default for a Claude session deck did not start (Claude Desktop / a terminal) when deck first records it.
 * Fable, like a new session (the user's call, 2026-10-06): Opus here kept every imported session's picker on Opus.
 * The first Fable turn of a session that last ran on Opus re-reads its context once (the prompt cache is per model).
 */
export const IMPORTED_DEFAULT_MODEL: ClaudeModel = DEFAULT_MODEL;

/**
 * D1: GPT models are Sol (default) and Astra. The deck id 'gpt-6-sol' is persisted (localStorage, session settings,
 * protocol enum) so it stays; the CLI gets CODEX_CLI_MODEL's slug (Sol = gpt-6.1-sol, codex-cli 0.159.2 models_cache).
 * Sol needs codex-cli >= 0.159 (0.146 was rejected with HTTP 400 "not supported when using Codex with a ChatGPT account").
 * Never luna, terra, gpt-5.x.
 */
export type CodexModel = 'gpt-6-sol' | 'gpt-6-astra';
export const CODEX_MODELS: readonly CodexModel[] = ['gpt-6-sol', 'gpt-6-astra'];
export const DEFAULT_CODEX_MODEL: CodexModel = 'gpt-6-sol';
/** The `-m` value codex gets for each deck id. */
export const CODEX_CLI_MODEL: Record<CodexModel, string> = { 'gpt-6-sol': 'gpt-6.1-sol', 'gpt-6-astra': 'gpt-6-astra' };

/**
 * Gemini (explicit engine only, never chosen by 자동). gemini-cli 0.62 has no Gemini 4.0 id; deck sends the CLI's
 * aliases (`-m pro` / `-m flash`) so the server-side model config picks the current one (docs/gemini-spike.md).
 */
export type GeminiModel = 'gemini-pro' | 'gemini-flash';
export const GEMINI_MODELS: readonly GeminiModel[] = ['gemini-pro', 'gemini-flash'];
export const DEFAULT_GEMINI_MODEL: GeminiModel = 'gemini-pro';
/** The `-m` value gemini-cli gets for each deck id. */
export const GEMINI_CLI_ALIAS: Record<GeminiModel, string> = { 'gemini-pro': 'pro', 'gemini-flash': 'flash' };

export type AnyModel = ClaudeModel | CodexModel | GeminiModel;

export const MODEL_LABEL: Record<AnyModel, string> = { sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable', 'gpt-6-sol': 'GPT Sol', 'gpt-6-astra': 'GPT Astra', 'gemini-pro': 'Gemini Pro', 'gemini-flash': 'Gemini Flash' };

/**
 * Picker rows: exact versions. Claude names/ids from the SDK's `supportedModels()` (agent-sdk 0.3.285, account B,
 * 2026-10-01): opus → claude-opus-5-5 "Opus 5.5", sonnet → claude-sonnet-5-5 "Sonnet 5.5", claude-fable-5-1
 * "Fable 5.1". GPT names from codex-cli 0.159.2's ~/.codex/models_cache.json (display_name).
 */
export const MODEL_INFO: Record<AnyModel, { name: string; description: string }> = {
  opus: { name: 'Opus 5.5', description: '복잡한 작업과 일상 작업 모두에 · Fable 여유가 없을 때 대신 실행' },
  sonnet: { name: 'Sonnet 5.5', description: '간단한 작업에 가장 효율적' },
  fable: { name: 'Fable 5.1', description: '기본 모델 · 가장 뛰어난 추론 · Fable 주간 80% 넘으면 Opus 로' },
  'gpt-6-sol': { name: 'GPT-6.1-Sol', description: '코딩과 일상 작업의 주력 모델' },
  'gpt-6-astra': { name: 'GPT-6-Astra', description: '가장 까다로운 작업용 최상위 모델' },
  'gemini-pro': { name: 'Gemini Pro', description: 'gemini-cli 의 pro 별칭 · 서버가 현재 Pro 모델로 연결' },
  'gemini-flash': { name: 'Gemini Flash', description: 'gemini-cli 의 flash 별칭 · 빠르고 가벼운 작업용' },
};

/**
 * Reasoning effort, sent per turn. Claude: SDK `Options.effort` (sdk.d.ts `EffortLevel`
 * = 'low'|'medium'|'high'|'xhigh'|'max'). GPT: `codex exec -c model_reasoning_effort="…"` (models_cache
 * supported_reasoning_levels low…max, ultra). deck offers the four levels every listed model supports;
 * 'max'/'ultra' are left out on purpose.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh'];
export const EFFORT_LABEL: Record<Effort, string> = { low: '낮음', medium: '중간', high: '높음', xhigh: '엑스트라' };
/** Per model: every Claude/GPT model reports all four (supportedEffortLevels / supported_reasoning_levels); gemini-cli has no effort flag. */
export const MODEL_EFFORTS: Record<AnyModel, readonly Effort[]> = { opus: EFFORTS, sonnet: EFFORTS, fable: EFFORTS, 'gpt-6-sol': EFFORTS, 'gpt-6-astra': EFFORTS, 'gemini-pro': [], 'gemini-flash': [] };
/** gemini: never sent (no CLI flag); present so per-engine effort maps stay total. */
export const DEFAULT_EFFORT: Record<EngineKind, Effort> = { claude: 'high', codex: 'medium', gemini: 'medium' };

/**
 * 자동 (picker value 'auto'): the server picks the Claude model for the first turn of a new session from the prompt
 * (routing/AutoModel); later turns keep that model. Never a mid-session switch (prompt cache).
 */
export type ModelChoice = AnyModel | 'auto';
export const AUTO_MODEL_INFO = { name: '자동', description: '첫 턴 내용으로 Sonnet · Opus · Fable 중 선택' } as const;
/** Effort 자동 uses when the user did not set one explicitly. */
export const AUTO_EFFORT: Record<ClaudeModel, Effort> = { sonnet: 'medium', opus: 'high', fable: 'high' };

export function isEffort(x: unknown): x is Effort {
  return x === 'low' || x === 'medium' || x === 'high' || x === 'xhigh';
}

/** The effort to send with `model`: the requested one if the model supports it, else null (engine default). */
export function effortFor(model: AnyModel, effort: Effort | undefined): Effort | null {
  return effort !== undefined && MODEL_EFFORTS[model].includes(effort) ? effort : null;
}

export function isClaudeModel(x: unknown): x is ClaudeModel {
  return x === 'sonnet' || x === 'opus' || x === 'fable';
}

export function isCodexModel(x: unknown): x is CodexModel {
  return x === 'gpt-6-sol' || x === 'gpt-6-astra';
}

export function isGeminiModel(x: unknown): x is GeminiModel {
  return x === 'gemini-pro' || x === 'gemini-flash';
}

/** Fable (7d) usage at or above this is not Fable-eligible (routing) and downgrades to Opus (model policy). */
export const FABLE_MAX_PCT = 80;

/** Spec §4.3: the engine is fixed per session; 'auto' is resolved once when the session is created (Claude or GPT, never Gemini). */
export type EngineKind = 'claude' | 'codex' | 'gemini';
export type EngineChoice = EngineKind | 'auto';

/** D2: codex exec cannot relay approvals, so the sandbox is the guard. Never danger-full-access. */
export type CodexSandbox = 'read-only' | 'workspace-write';
export const CODEX_SANDBOXES: readonly CodexSandbox[] = ['read-only', 'workspace-write'];
export const DEFAULT_SANDBOX: CodexSandbox = 'read-only';
/** 자동 승인 on: new GPT sessions default to workspace-write (network stays off, approval never). */
export function defaultSandbox(autoApprove: boolean): CodexSandbox {
  return autoApprove ? 'workspace-write' : DEFAULT_SANDBOX;
}
export const SANDBOX_LABEL: Record<CodexSandbox, string> = { 'read-only': '읽기 전용', 'workspace-write': '작업폴더 쓰기(네트워크 차단)' };
/** Gemini: read-only = `--approval-mode plan`; workspace-write = `auto_edit` (edits run, shell is denied headless). Network stays open. */
export const GEMINI_SANDBOX_LABEL: Record<CodexSandbox, string> = { 'read-only': '읽기 전용', 'workspace-write': '파일 편집 허용(셸 거부)' };

export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Context window for a deck id or wire model id (claude-opus-5-5, opus[1m]…), for when the SDK did not report one
 * (a reopened session). claude-api skill (2026-09-25): Opus 5.5, Sonnet 5.5, Fable 5.1 = 1M; Haiku 4.5 and
 * pre-4.6 Opus/Sonnet = 200k. Anything else (GPT, Gemini, unknown) = 200k.
 */
export function contextWindowOf(model: string | null | undefined): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  if (/\[1m\]/i.test(model)) return 1_000_000;
  if (/haiku|claude-3|(opus|sonnet)-4-[0-5](?!\d)/i.test(model)) return DEFAULT_CONTEXT_WINDOW;
  if (/opus|sonnet|fable|mythos/i.test(model)) return 1_000_000;
  return DEFAULT_CONTEXT_WINDOW;
}
