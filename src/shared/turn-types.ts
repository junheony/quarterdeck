export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Claude: the main conversation's last API call of the turn — its prompt is the session's current context. */
  context?: ContextUsage;
  /** Claude: the model's context window as the SDK reports it (result.modelUsage[*].contextWindow). */
  contextWindow?: number;
};

/** One API call's prompt: input + cache read + cache write = what the model read this call. */
export type ContextUsage = { inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };

/** An API `usage` object → ContextUsage; null when it carries no prompt tokens (synthetic / error messages). */
export function contextUsageOf(u: unknown): ContextUsage | null {
  if (!u || typeof u !== 'object') return null;
  const r = u as Record<string, unknown>;
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  const c = { inputTokens: n('input_tokens'), cacheReadTokens: n('cache_read_input_tokens'), cacheCreationTokens: n('cache_creation_input_tokens') };
  return c.inputTokens + c.cacheReadTokens + c.cacheCreationTokens > 0 ? c : null;
}

export const ZERO_USAGE: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

/** UI buttons: 허용 1회 / 이 세션 동안 / 거부. */
export type PermissionDecision = 'once' | 'session' | 'deny';

/** One AskUserQuestion entry as the SDK's AskUserQuestionInput.questions[] spells it (previews dropped). */
export type Question = { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean };

/** question text → chosen label(s); multi-select answers are comma-separated (sdk-tools.d.ts AskUserQuestionOutput.answers). */
export type QuestionAnswers = Record<string, string>;

/** A Claude task's lifecycle state as the SDK reports it (task_started / task_progress / task_updated / task_notification). */
export type TaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** The SDK's running totals for a task (task_progress / task_notification `usage`). */
export type TaskUsage = { totalTokens: number; toolUses: number; durationMs: number };

/**
 * One change to a task (subagent, background Bash…), merged by the UI into its task map. `toolUseId` is the
 * Agent/Bash tool call that started it (the card it belongs to); null when the SDK did not say.
 */
export type TaskUpdate = {
  taskId: string;
  toolUseId: string | null;
  status?: TaskStatus;
  description?: string;
  /** Subagent type for Agent/Task subagents (e.g. general-purpose). */
  subagentType?: string;
  /** local_agent, local_bash, mcp_task… */
  taskType?: string;
  backgrounded?: boolean;
  usage?: TaskUsage;
  lastToolName?: string;
  /** One-line progress summary (when the SDK sends one). */
  summary?: string;
};

/** What the main conversation is streaming right now (drives the status row's verb). */
export type TurnPhase = 'thinking' | 'responding' | 'tool';

/** A live background task as the composer's pill lists it; `ageMs` = how long it has run when the message was sent. */
export type BgTaskInfo = { id: string; description: string; type: string; ageMs: number };
