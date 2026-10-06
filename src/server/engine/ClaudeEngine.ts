import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import { query, type HookInput, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AccountRegistry } from '../../shared/accounts';
import { IMAGE_TYPES, promptWithFiles, type Attachment } from '../attachments/AttachmentStore';
import { ZERO_USAGE, contextUsageOf, type ContextUsage, type TaskStatus, type TaskUpdate, type TaskUsage, type TurnPhase, type TurnUsage } from '../../shared/turn-types';
import { MODEL_ARG } from '../routing/ModelPolicy';
import { systemRow, textOfContent } from '../sessions/transcript';
import { parseQuestions, sessionUpdates, type BgTask, type Engine, type EngineEvent, type EngineResult, type LiveInput, type RateLimitSignal, type TurnRequest } from './Engine';
import { STDERR_MAX } from './redact';
import type { SlashCommandInfo } from './slashCommands';

export type PromptInput = string | AsyncIterable<SDKUserMessage>;
export type QueryFn = (params: { prompt: PromptInput; options?: Options }) => AsyncIterable<SDKMessage>;
export type ReadFile = (p: string) => Promise<Buffer>;

type UserBlock = Exclude<SDKUserMessage['message']['content'], string>[number];
type Base64Source = Extract<Extract<UserBlock, { type: 'image' }>['source'], { type: 'base64' }>;

function imageMediaType(t: string): Base64Source['media_type'] | null {
  return IMAGE_TYPES.has(t) ? (t as Base64Source['media_type']) : null;
}

/**
 * D7/D14: non-image attachments become path lines in the text; with at least one image the prompt is a
 * one-message stream (`SDKUserMessage` with a content array — the only way to pass image blocks,
 * sdk.d.ts:3233/6158). `session_id: ''` mirrors what the SDK writes for a string prompt.
 */
export async function buildPrompt(text: string, attachments: Attachment[], readFile: ReadFile = (p) => fs.readFile(p)): Promise<PromptInput> {
  const body = promptWithFiles(text, attachments);
  const images = attachments.filter((a) => a.isImage);
  if (!images.length) return body;
  const content: UserBlock[] = [{ type: 'text', text: body }];
  for (const img of images) {
    const media_type = imageMediaType(img.mediaType);
    if (!media_type) continue;
    content.push({ type: 'image', source: { type: 'base64', media_type, data: (await readFile(img.path)).toString('base64') } });
  }
  const message: SDKUserMessage = { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } };
  return (async function* () { yield message; })();
}

/** The prompt as one streamed user message (text + image blocks) — every turn runs in streaming-input mode. */
export async function toUserMessage(text: string, attachments: Attachment[], readFile: ReadFile = (p) => fs.readFile(p)): Promise<SDKUserMessage> {
  const prompt = await buildPrompt(text, attachments, readFile);
  if (typeof prompt === 'string') return { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: prompt } };
  for await (const m of prompt) return m;
  throw new Error('empty prompt');
}

/**
 * The process's stdin in streaming-input mode. Open = the CLI stays alive after a result
 * (sdk.d.ts SDKResultMessage: "In single-prompt (non-streaming-input) mode the process exits
 * after the turn" — which is what killed background Agent/Bash tasks).
 */
export class InputChannel implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  closed = false;

  push(m: SDKUserMessage): boolean {
    if (this.closed) return false;
    const w = this.waiter;
    if (w) { this.waiter = null; w({ value: m, done: false }); } else this.queue.push(m);
    return true;
  }

  close(): void {
    this.closed = true;
    const w = this.waiter;
    this.waiter = null;
    w?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.queue.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiter = resolve; });
      },
      return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

type Rec = Record<string, unknown>;

/**
 * Which background tasks are live. Prefers the CLI's level signal `background_tasks_changed`
 * (REPLACE semantics, sdk.d.ts SDKBackgroundTasksChangedMessage); falls back to pairing the
 * task_started / task_updated / task_notification bookends for CLIs that never send the level.
 * Ambient tasks (housekeeping, watchers) are not activity and are left out.
 */
export class BackgroundTracker {
  private level: Map<string, string> | null = null;
  private readonly edge = new Map<string, string>();
  private readonly known = new Map<string, string>();
  /** Type and first-seen time per task id (task_started or the level signal, whichever came first). */
  private readonly meta = new Map<string, { type: string; startedAtMs: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private see(id: string, type: unknown): void {
    const m = this.meta.get(id);
    if (!m) this.meta.set(id, { type: typeof type === 'string' ? type : '', startedAtMs: this.now() });
    else if (!m.type && typeof type === 'string') m.type = type;
  }

  /** Feeds one SDK message; true when it was a task message (the set may have changed). */
  apply(m: SDKMessage): boolean {
    if (m.type !== 'system') return false;
    const r = m as unknown as Rec;
    const id = typeof r.task_id === 'string' ? r.task_id : '';
    const desc = typeof r.description === 'string' ? r.description : '';
    const ambient = r.ambient === true || r.skip_transcript === true;
    switch (r.subtype) {
      case 'background_tasks_changed': {
        const tasks = Array.isArray(r.tasks) ? (r.tasks as Rec[]) : [];
        for (const t of tasks) if (t.ambient !== true) this.see(String(t.task_id ?? ''), t.task_type);
        this.level = new Map(tasks.filter((t) => t.ambient !== true).map((t) => [String(t.task_id ?? ''), String(t.description ?? '')]));
        return true;
      }
      case 'task_started':
        if (ambient) return true;
        this.see(id, r.task_type);
        this.known.set(id, desc);
        if (r.is_backgrounded === true) this.edge.set(id, desc);
        return true;
      case 'task_updated': {
        const patch = (r.patch ?? {}) as Rec;
        if (patch.is_backgrounded === true && this.known.has(id)) this.edge.set(id, this.known.get(id) ?? '');
        if (patch.status === 'completed' || patch.status === 'failed' || patch.status === 'killed') this.edge.delete(id);
        return true;
      }
      case 'task_notification':
        this.edge.delete(id);
        this.known.delete(id);
        return true;
      default:
        return false;
    }
  }

  tasks(): string[] {
    return [...(this.level ?? this.edge).values()];
  }

  /** The live tasks with id, type and start time, in the same order as `tasks()`. */
  detail(): BgTask[] {
    return [...(this.level ?? this.edge)].map(([id, description]) => {
      const m = this.meta.get(id);
      return { id, description, type: m?.type ?? '', startedAtMs: m?.startedAtMs ?? this.now() };
    });
  }
}

/**
 * Main-conversation output tokens of the current deck turn, for the status row: exact
 * `message_delta.usage.output_tokens` per finished API message plus a chars/4 estimate of the one
 * streaming now (text, thinking, tool input) and the CLI's thinking-token estimates. Emits at most
 * every `minGapMs` while streaming, and at once when the phase changes or a message ends. Messages
 * without a `message_start` first (older producers, test doubles) are not metered.
 */
export class ProgressMeter {
  private done = 0;
  private est = 0;
  private phase: TurnPhase | null = null;
  private metering = false;
  private lastEmit = 0;
  private lastValue = -1;

  constructor(private readonly now: () => number = Date.now, private readonly minGapMs = 400) {}

  /** A deck turn ended (result): the next one counts from zero. */
  reset(): void {
    this.done = 0; this.est = 0; this.phase = null; this.metering = false; this.lastValue = -1;
  }

  apply(m: SDKMessage): { outputTokens: number; phase: TurnPhase } | null {
    const r = m as unknown as Rec;
    if (m.type === 'system' && r.subtype === 'thinking_tokens' && typeof r.estimated_tokens_delta === 'number') {
      this.metering = true;
      this.est += r.estimated_tokens_delta;
      return this.emit(this.setPhase('thinking'));
    }
    if (m.type !== 'stream_event' || r.parent_tool_use_id !== null) return null;
    const ev = (r.event ?? {}) as Rec;
    switch (ev.type) {
      case 'message_start':
        this.metering = true;
        this.est = 0;
        return null;
      case 'content_block_start': {
        if (!this.metering) return null;
        const t = ((ev.content_block ?? {}) as Rec).type;
        const phase: TurnPhase = t === 'thinking' || t === 'redacted_thinking' ? 'thinking' : t === 'tool_use' || t === 'server_tool_use' ? 'tool' : 'responding';
        return this.emit(this.setPhase(phase));
      }
      case 'content_block_delta': {
        if (!this.metering) return null;
        const d = (ev.delta ?? {}) as Rec;
        const text = typeof d.text === 'string' ? d.text : typeof d.thinking === 'string' ? d.thinking : typeof d.partial_json === 'string' ? d.partial_json : '';
        this.est += text.length / 4;
        return this.emit(false);
      }
      case 'message_delta': {
        if (!this.metering) return null;
        const out = ((ev.usage ?? {}) as Rec).output_tokens;
        if (typeof out === 'number') { this.done += out; this.est = 0; }
        return this.emit(true);
      }
      default:
        return null;
    }
  }

  private setPhase(p: TurnPhase): boolean {
    if (this.phase === p) return false;
    this.phase = p;
    return true;
  }

  private emit(force: boolean): { outputTokens: number; phase: TurnPhase } | null {
    const value = this.done + Math.round(this.est);
    const t = this.now();
    if (!force && (t - this.lastEmit < this.minGapMs || value === this.lastValue)) return null;
    this.lastEmit = t;
    this.lastValue = value;
    return { outputTokens: value, phase: this.phase ?? 'responding' };
  }
}

function taskUsageOf(u: unknown): TaskUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const r = u as Rec;
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  return { totalTokens: n('total_tokens'), toolUses: n('tool_uses'), durationMs: n('duration_ms') };
}

const PATCH_STATUS: Record<string, TaskStatus> = { pending: 'running', running: 'running', paused: 'running', completed: 'completed', failed: 'failed', killed: 'stopped' };

/** task_started / task_progress / task_updated → one TaskUpdate (ambient housekeeping tasks are left out); null for anything else. */
function taskUpdateOf(r: Rec): TaskUpdate | null {
  if (r.ambient === true || r.skip_transcript === true) return null;
  const taskId = typeof r.task_id === 'string' ? r.task_id : '';
  if (!taskId) return null;
  const toolUseId = typeof r.tool_use_id === 'string' ? r.tool_use_id : null;
  const str = (k: string) => (typeof r[k] === 'string' && r[k] ? { [k]: r[k] as string } : {});
  switch (r.subtype) {
    case 'task_started':
      return {
        taskId, toolUseId, status: 'running',
        ...(typeof r.description === 'string' ? { description: r.description } : {}),
        ...(str('subagent_type').subagent_type ? { subagentType: r.subagent_type as string } : {}),
        ...(str('task_type').task_type ? { taskType: r.task_type as string } : {}),
        ...(typeof r.is_backgrounded === 'boolean' ? { backgrounded: r.is_backgrounded } : {}),
      };
    case 'task_progress': {
      const usage = taskUsageOf(r.usage);
      return {
        // Its `description` is the subagent's current activity ("Reading README.md"), not the task's: left out.
        taskId, toolUseId, status: 'running',
        ...(str('subagent_type').subagent_type ? { subagentType: r.subagent_type as string } : {}),
        ...(usage ? { usage } : {}),
        ...(str('last_tool_name').last_tool_name ? { lastToolName: r.last_tool_name as string } : {}),
        ...(str('summary').summary ? { summary: r.summary as string } : {}),
      };
    }
    case 'task_updated': {
      const patch = (r.patch ?? {}) as Rec;
      const status = typeof patch.status === 'string' ? PATCH_STATUS[patch.status] : undefined;
      const out: TaskUpdate = { taskId, toolUseId };
      if (status) out.status = status;
      if (typeof patch.description === 'string') out.description = patch.description;
      if (typeof patch.is_backgrounded === 'boolean') out.backgrounded = patch.is_backgrounded;
      return out.status || out.description !== undefined || out.backgrounded !== undefined ? out : null;
    }
    default:
      return null;
  }
}

/** A message that means the main conversation is producing output (subagent traffic and replays are not). */
function isActivity(m: SDKMessage): boolean {
  if (m.type === 'result') return true;
  if (m.type !== 'assistant' && m.type !== 'stream_event' && m.type !== 'user') return false;
  const r = m as unknown as Rec;
  return r.parent_tool_use_id === null && r.isReplay !== true;
}

/**
 * The result of a CLI-originated command the model never ran on: origin set and not 'human', no user_message_uuid(s),
 * num_turns 0. Success or error, it is the CLI's own turn, never an answer to anything deck wrote.
 */
function isInjectedNoopResult(m: SDKMessage): boolean {
  if (m.type !== 'result') return false;
  const r = m as unknown as Rec;
  const kind = r.origin && typeof r.origin === 'object' ? (r.origin as Rec).kind : undefined;
  const named = (Array.isArray(r.user_message_uuids) && r.user_message_uuids.length > 0) || typeof r.user_message_uuid === 'string';
  return typeof kind === 'string' && kind !== 'human' && !named && r.num_turns === 0;
}

/** Background waiting caps: total wait after the first result, and how long an emptied set may stay idle. */
export const BG_MAX_MS = 2 * 60 * 60_000;
export const BG_GRACE_MS = 60_000;

/** The handoff-note turn (TurnRequest.noTools): what a denied tool call tells the model. */
export const NO_TOOLS_MESSAGE = '인계 메모 작성 중에는 도구를 쓸 수 없습니다 — 지금까지의 대화만으로 메모를 써 주세요';

/** 계속 계획 on the plan card: what the denied ExitPlanMode call tells the model. */
export const KEEP_PLANNING_MESSAGE = '사용자가 계획을 승인하지 않았습니다 — 계획 모드를 유지하며 계획을 더 다듬어 주세요';

/** Where an audited call was decided without deck being asked: 'cli' = the CLI ran or refused it on its own (an allow rule, the mode, or a tool that needs no permission — the SDK does not say which), 'rule' = a deny rule (the SDK says so), 'deck' = deck's own hook. */
type AuditSource = 'cli' | 'rule' | 'deck';
export type ToolAudit = { handled: Set<string>; report: (e: { tool_name: string; tool_input: unknown; tool_use_id: string }, decision: 'allow' | 'deny', source: AuditSource) => Promise<void> };

/**
 * One process's tool-call audit: each call is reported once — whichever of the hooks, the stream's permission_denied
 * frame or the result's permission_denials sees it first — and never when canUseTool decided it (the caller audits those).
 */
export function toolAudit(req: TurnRequest): ToolAudit {
  const handled = new Set<string>();
  return {
    handled,
    report: async (e, decision, source) => {
      if (handled.has(e.tool_use_id)) return;
      handled.add(e.tool_use_id);
      try {
        await req.onToolAudit?.({ toolName: e.tool_name, input: e.tool_input, toolUseId: e.tool_use_id, decision, source });
      } catch {
        // best-effort, like every audit write: never fails the tool call
      }
    },
  };
}

/** The denials an SDK message reports: a `system/permission_denied` frame (input from the call's tool_use block), or a result's `permission_denials`. */
export function deniedCalls(m: SDKMessage, inputs: Map<string, unknown>): { tool_name: string; tool_input: unknown; tool_use_id: string; source: AuditSource }[] {
  const r = m as unknown as Rec;
  if (m.type === 'system' && r.subtype === 'permission_denied' && typeof r.tool_use_id === 'string' && typeof r.tool_name === 'string') {
    return [{ tool_name: r.tool_name, tool_use_id: r.tool_use_id, tool_input: inputs.get(r.tool_use_id) ?? null, source: r.decision_reason_type === 'rule' ? 'rule' : 'cli' }];
  }
  if (m.type === 'result' && Array.isArray(r.permission_denials)) {
    return (r.permission_denials as Rec[])
      .filter((d) => typeof d.tool_use_id === 'string' && typeof d.tool_name === 'string')
      .map((d) => ({ tool_name: d.tool_name as string, tool_use_id: d.tool_use_id as string, tool_input: d.tool_input ?? inputs.get(d.tool_use_id as string) ?? null, source: 'cli' as const }));
  }
  return [];
}

export function buildOptions(
  req: TurnRequest,
  deps: { home: string; accounts: Pick<AccountRegistry, 'env'>; baseEnv: NodeJS.ProcessEnv; abortController: AbortController; onStderr: (s: string) => void; /** false: DECK_STEER=0 (no echo flag). */ steer?: boolean; /** Shared with the stream loop (denials it sees); a fresh one by default. */ audit?: ToolAudit },
): Options {
  // Audit: canUseTool is asked only about calls that need a decision; an allow rule, the mode (acceptEdits) or a tool
  // that needs no permission runs the rest without it. Those are reported from the after-hooks, denials also from the
  // stream (run): the PermissionDenied hook fires only for auto-mode classifier denials, which deck's modes never use.
  const audit = deps.audit ?? toolAudit(req);
  const after = (decision: 'allow' | 'deny') => async (input: HookInput) => {
    if (input.hook_event_name === 'PostToolUse' || input.hook_event_name === 'PostToolUseFailure' || input.hook_event_name === 'PermissionDenied') await audit.report(input, decision, 'cli');
    return { continue: true };
  };
  const noTools = async (input: HookInput) => {
    if (input.hook_event_name === 'PreToolUse') await audit.report(input, 'deny', 'deck');
    return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: NO_TOOLS_MESSAGE } };
  };
  return {
    cwd: req.cwd,
    env: deps.accounts.env(req.account, deps.baseEnv),
    model: MODEL_ARG[req.model],
    // sdk.d.ts Options.effort?: EffortLevel ('low' | 'medium' | 'high' | 'xhigh' | 'max'), "works with adaptive thinking".
    ...(req.effort ? { effort: req.effort } : {}),
    resume: req.resumeSessionId ?? undefined,
    ...(req.forkAt && req.resumeSessionId ? { forkSession: true, resumeSessionAt: req.forkAt } : {}),
    // ~/.claude/settings.json sets defaultMode "auto"; spec §6 wants ask-every-time — unless the session's mode
    // (picker, plan approval, or 이 세션's "allow all edits") says acceptEdits / plan. Never 'bypassPermissions'.
    permissionMode: req.permissionMode ?? 'default',
    // Spec §4.3: hooks, agents, CLAUDE.md from the profile + project.
    settingSources: ['user', 'project', 'local'],
    includePartialMessages: true,
    // Echo each user message as the CLI takes it off stdin (isReplay frames carrying our uuid): how a steer is seen
    // reaching the model — at the tool boundary it was folded in at, or at the start of its own turn. null = bare flag.
    ...(deps.steer !== false ? { extraArgs: { 'replay-user-messages': null } } : {}),
    abortController: deps.abortController,
    stderr: deps.onStderr,
    // Review I4: "이 세션" on an earlier turn stored the SDK's own scoped suggestions; they are
    // handed back through the flag-settings layer (`settings`, the --settings equivalent, whose
    // d.ts documents rule syntax such as 'Bash(*)'), so the CLI's own matcher applies them and
    // later turns don't prompt. The layer is session-only: the SDK serializes an object to the
    // `--settings <json>` argv and never writes it to a file (d.ts: applyFlagSettings "only touches
    // the session-scoped flag layer", unlike updateSettings). Chosen over `allowedTools` (documented as bare tool names) and
    // over auto-answering in canUseTool (would mean re-implementing the CLI's rule matching).
    ...(req.allowRules?.length ? { settings: { permissions: { allow: req.allowRules } } } : {}),
    ...(req.allowDirs?.length ? { additionalDirectories: req.allowDirs } : {}),
    hooks: {
      ...(req.noTools ? { PreToolUse: [{ hooks: [noTools] }] } : {}),
      PostToolUse: [{ hooks: [after('allow')] }],
      PostToolUseFailure: [{ hooks: [after('allow')] }],
      PermissionDenied: [{ hooks: [after('deny')] }],
    },
    canUseTool: async (toolName, input, ctx) => {
      audit.handled.add(ctx.toolUseID);
      if (req.noTools) return { behavior: 'deny', message: NO_TOOLS_MESSAGE, interrupt: false };
      // D8: AskUserQuestion is not a permission prompt. The answers travel back as updatedInput.answers
      // (sdk-tools.d.ts AskUserQuestionInput.answers: "User answers collected by the permission component").
      if (toolName === 'AskUserQuestion') {
        const questions = parseQuestions(input);
        if (!questions) {
          await req.onQuestionMalformed?.(input);
          return { behavior: 'deny', message: '질문 형식이 올바르지 않습니다', interrupt: false };
        }
        const answers = req.onQuestion ? await req.onQuestion({ toolUseId: ctx.toolUseID, questions, signal: ctx.signal }) : null;
        if (!answers) return { behavior: 'deny', message: '사용자가 답하지 않았습니다', interrupt: false };
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      }
      const pr = {
        toolName,
        input,
        toolUseId: ctx.toolUseID,
        signal: ctx.signal,
        ...(ctx.suggestions ? { suggestions: ctx.suggestions } : {}),
        suppressAlwaysAllowRule: ctx.suppressAlwaysAllowRule === true,
        ...(ctx.title !== undefined ? { title: ctx.title } : {}),
        ...(ctx.decisionReason !== undefined ? { decisionReason: ctx.decisionReason } : {}),
        ...(ctx.blockedPath !== undefined ? { blockedPath: ctx.blockedPath } : {}),
        ...(ctx.defaultToNo !== undefined ? { defaultToNo: ctx.defaultToNo } : {}),
      };
      if (req.autoApprove?.()) {
        await req.onAutoApproved?.(pr);
        return { behavior: 'allow' };
      }
      const decision = await req.onPermission(pr);
      // The plan card: approval also leaves plan mode, into the mode the user picked (Desktop: auto-accept edits vs manually approve).
      if (toolName === 'ExitPlanMode') {
        if (decision === 'deny') return { behavior: 'deny', message: KEEP_PLANNING_MESSAGE, interrupt: false };
        return { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: decision === 'session' ? 'acceptEdits' : 'default', destination: 'session' }] };
      }
      if (decision === 'deny') return { behavior: 'deny', message: '사용자가 거부했습니다', interrupt: false };
      // Only the SDK's own suggestions, sanitized to destination 'session' — never ctx.suggestions
      // verbatim (a localSettings rule would be written to disk) and never a rule of our own.
      if (decision === 'session') {
        const updates = sessionUpdates(pr);
        if (updates.length) return { behavior: 'allow', updatedPermissions: updates };
      }
      return { behavior: 'allow' };
    },
  };
}

function isoFromEpochSec(v: unknown): string | null {
  return typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null;
}

function windowOf(w: unknown): RateLimitSignal['fiveHour'] {
  if (!w || typeof w !== 'object') return null;
  const u = (w as Rec).utilization;
  if (typeof u !== 'number') return null;
  return { usedPct: Math.round(u * 100), resetsAt: isoFromEpochSec((w as Rec).resetsAt) };
}

function usageOf(u: unknown): TurnUsage {
  const r = (u ?? {}) as Rec;
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  return { inputTokens: n('input_tokens'), outputTokens: n('output_tokens'), cacheReadTokens: n('cache_read_input_tokens'), cacheCreationTokens: n('cache_creation_input_tokens') };
}

/** result.modelUsage → the largest reported contextWindow (the main model's; subagent models are never larger). */
function windowFromModelUsage(mu: unknown): { contextWindow?: number } {
  if (!mu || typeof mu !== 'object') return {};
  const ws = Object.values(mu as Rec).map((v) => (v && typeof v === 'object' ? (v as Rec).contextWindow : null)).filter((w): w is number => typeof w === 'number' && w > 0);
  return ws.length ? { contextWindow: Math.max(...ws) } : {};
}

/** Pure translation of one SDKMessage into zero or more EngineEvents. */
export function mapSdkMessage(m: SDKMessage): EngineEvent[] {
  switch (m.type) {
    case 'system': {
      if (m.subtype === 'init') return [{ kind: 'init', sessionId: m.session_id, model: m.model, ...(typeof m.cwd === 'string' ? { cwd: m.cwd } : {}) }];
      if (m.subtype === 'compact_boundary') return [{ kind: 'compact' }];
      if (m.subtype === 'task_notification') {
        const r = m as unknown as Rec;
        if (r.ambient === true || r.skip_transcript === true) return [{ kind: 'task_done', status: m.status, summary: typeof m.summary === 'string' ? m.summary : '' }];
        const usage = taskUsageOf(r.usage);
        return [{
          kind: 'task_done', status: m.status, summary: typeof m.summary === 'string' ? m.summary : '',
          ...(typeof r.task_id === 'string' ? { taskId: r.task_id } : {}),
          toolUseId: typeof r.tool_use_id === 'string' ? r.tool_use_id : null,
          ...(usage ? { usage } : {}),
        }];
      }
      const update = taskUpdateOf(m as unknown as Rec);
      return update ? [{ kind: 'task_update', ...update }] : [];
    }
    case 'stream_event': {
      if (m.parent_tool_use_id !== null) return [];
      const ev = m.event as unknown as Rec;
      if (ev.type === 'content_block_start') {
        const t = ((ev.content_block ?? {}) as Rec).type;
        if (t === 'redacted_thinking') return [{ kind: 'thinking', text: '', redacted: true }];
        return t === 'thinking' ? [{ kind: 'thinking', text: '' }] : [];
      }
      if (ev.type !== 'content_block_delta') return [];
      const delta = ev.delta as Rec | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') return [{ kind: 'delta', text: delta.text }];
      if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') return [{ kind: 'thinking', text: delta.thinking }];
      return [];
    }
    case 'assistant': {
      const blocks = ((m.message as unknown as Rec).content as Rec[] | undefined) ?? [];
      // A subagent's own tool calls ride with the Agent call that spawned it, never into the main transcript.
      if (m.parent_tool_use_id !== null) {
        const parentToolUseId = m.parent_tool_use_id;
        return blocks
          .filter((b) => b.type === 'tool_use')
          .map((b) => ({ kind: 'sub_tool_call' as const, parentToolUseId, toolUseId: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input }));
      }
      return blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ kind: 'tool_call' as const, toolUseId: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input }));
    }
    case 'user': {
      // --replay-user-messages echoes what we (or the CLI) already sent; a replayed tool_result must not show twice.
      if ((m as unknown as Rec).isReplay === true) return [];
      const content = (m.message as unknown as Rec).content;
      // A message the harness injected (hook feedback, peer message, task notification…; isSynthetic / isMeta / origin):
      // a system row in the turn, never a user message — or nothing, if it is context for the model only.
      const sys = m.parent_tool_use_id === null && !(Array.isArray(content) && content.some((b) => (b as Rec)?.type === 'tool_result')) ? systemRow(m as unknown as Rec, textOfContent(content)) : null;
      if (sys) return sys === 'hide' ? [] : [{ kind: 'system', ...sys }];
      if (!Array.isArray(content)) return [];
      if (m.parent_tool_use_id !== null) {
        const parentToolUseId = m.parent_tool_use_id;
        return (content as Rec[])
          .filter((b) => b.type === 'tool_result')
          .map((b) => ({ kind: 'sub_tool_result' as const, parentToolUseId, toolUseId: String(b.tool_use_id ?? ''), isError: b.is_error === true }));
      }
      return (content as Rec[])
        .filter((b) => b.type === 'tool_result')
        .map((b) => ({
          kind: 'tool_result' as const,
          toolUseId: String(b.tool_use_id ?? ''),
          content: typeof b.content === 'string' ? b.content : textOfContent(b.content) || JSON.stringify(b.content ?? ''),
          isError: b.is_error === true,
        }));
    }
    case 'rate_limit_event': {
      const info = m.rate_limit_info as unknown as Rec;
      const uw = (info.unifiedWindows ?? {}) as Rec;
      return [{ kind: 'rate_limit', info: { status: info.status as RateLimitSignal['status'], fiveHour: windowOf(uw.five_hour), weekly: windowOf(uw.seven_day) } }];
    }
    case 'result': {
      const ok = m.subtype === 'success' && !m.is_error;
      let errorText: string | null = null;
      if (!ok) errorText = m.subtype === 'success' ? m.result : [m.subtype, ...(m.errors ?? [])].join(': ');
      const result: EngineResult = {
        kind: 'result',
        sessionId: m.session_id,
        ok,
        text: ok ? m.result : '',
        usage: { ...usageOf(m.usage), ...windowFromModelUsage(m.modelUsage) },
        errorText,
        stderr: null,
        errorKind: null,
        terminalReason: m.terminal_reason ?? null,
      };
      return [result];
    }
    default:
      return [];
  }
}

/** The composer's `/` menu source: what system/init (`slash_commands`) or `commands_changed` reported. */
export type CommandsListener = (sessionId: string | null, cwd: string, commands: (string | SlashCommandInfo)[], terminal: string[]) => void;

/** system/init or system/commands_changed → onCommands; anything else is ignored. */
export function noteCommands(m: SDKMessage, fallbackCwd: string, onCommands: CommandsListener): void {
  if (m.type !== 'system') return;
  const r = m as unknown as Rec;
  const sessionId = typeof r.session_id === 'string' ? r.session_id : null;
  const cwd = typeof r.cwd === 'string' && r.cwd ? r.cwd : fallbackCwd;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  if (r.subtype === 'init' && Array.isArray(r.slash_commands)) onCommands(sessionId, cwd, strings(r.slash_commands), strings(r.terminal_slash_commands));
  else if (r.subtype === 'commands_changed' && Array.isArray(r.commands)) {
    const list = (r.commands as unknown[]).filter((c): c is SlashCommandInfo => !!c && typeof c === 'object' && typeof (c as Rec).name === 'string');
    onCommands(sessionId, cwd, list, []);
  }
}

export class ClaudeEngine implements Engine {
  private readonly queryFn: QueryFn;
  private readonly home: string;
  private readonly accounts: Pick<AccountRegistry, 'env'>;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly readFile: ReadFile;
  private readonly bgMaxMs: number;
  private readonly bgGraceMs: number;
  private readonly onCommands: CommandsListener | null;
  /** Kill switch (DECK_STEER=0 → false): no `onLive().steer`, no echo flag; follow-ups and per-uuid bookkeeping stay. */
  private readonly steer: boolean;

  constructor(opts: { queryFn?: QueryFn; home?: string; accounts: Pick<AccountRegistry, 'env'>; baseEnv?: NodeJS.ProcessEnv; readFile?: ReadFile; bgMaxMs?: number; bgGraceMs?: number; onCommands?: CommandsListener; steer?: boolean }) {
    this.queryFn = opts.queryFn ?? ((p) => query(p));
    this.home = opts.home ?? os.homedir();
    this.accounts = opts.accounts;
    this.baseEnv = opts.baseEnv ?? process.env;
    this.readFile = opts.readFile ?? ((p) => fs.readFile(p));
    this.bgMaxMs = opts.bgMaxMs ?? BG_MAX_MS;
    this.bgGraceMs = opts.bgGraceMs ?? BG_GRACE_MS;
    this.onCommands = opts.onCommands ?? null;
    this.steer = opts.steer ?? true;
  }

  /**
   * One deck turn = one CLI process in streaming-input mode. The input stays open after a result
   * while background tasks are live: when one settles, the CLI injects its task notification and
   * runs another turn by itself (yielded as `continue` + that turn's events + its result), and
   * `onLive().send` can add user messages. The input closes — and the process ends — after a result
   * with no live background task and no unanswered message, after an emptied set stays idle for
   * `bgGraceMs`, after `bgMaxMs`, or on abort.
   */
  async *runTurn(req: TurnRequest): AsyncIterable<EngineEvent> {
    // Review M2: an interrupt that landed before the turn started must not spawn the CLI at all.
    if (req.signal.aborted) {
      yield { kind: 'result', sessionId: req.forkAt ? null : req.resumeSessionId, ok: false, text: '', usage: ZERO_USAGE, errorText: '중단됨', stderr: null, errorKind: null, terminalReason: 'aborted' };
      return;
    }
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    req.signal.addEventListener('abort', onAbort, { once: true });
    let stderrTail = '';
    // A fork gets its own id from init; the parent's id must never be reported as the turn's session.
    let sessionId: string | null = req.forkAt ? null : req.resumeSessionId;
    let errorKind: string | null = null;
    let sawResult = false;
    /** Prompt tokens of the main conversation's latest API call (the turn's result carries it as the context size). */
    let lastCtx: ContextUsage | null = null;
    const input = new InputChannel();
    const bg = new BackgroundTracker();
    const meter = new ProgressMeter();
    let shownTasks: string[] = [];
    let shownSig = '[]';
    /** The SDK handle (Query) once the process is spawned: per-task stop when it has stopTask. */
    type Handle = { stopTask?: (id: string) => Promise<void>; setPermissionMode?: (m: 'default' | 'acceptEdits' | 'plan') => Promise<void> };
    let handle: Handle | null = null;
    /** uuids of the messages written (initial prompt, follow-ups, steers) not yet answered by a result, oldest first. */
    const unanswered: string[] = [];
    /** Steers written but not yet seen reaching the model: our uuid → the caller's id. */
    const steers = new Map<string, string>();
    /** Steers seen reaching the model since the last result (fallback attribution for a result without uuids). */
    let echoed: string[] = [];
    /** This CLI names what each result answered (user_message_uuids): a result without them then answers nothing (a background continuation). */
    let namesAnswers = false;
    const answer = (ids: Iterable<string>) => { for (const id of ids) { const i = unanswered.indexOf(id); if (i >= 0) unanswered.splice(i, 1); } };
    /** Between a result and the next main-thread output: new output there is a background continuation. */
    let idle = false;
    let capTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let ended: 'cap' | 'grace' | null = null;
    const finish = (why: 'cap' | 'grace') => { if (input.closed) return; ended = why; input.close(); abortController.abort(); };
    const clearGrace = () => { if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; } };
    const armGrace = () => {
      clearGrace();
      if (!idle || unanswered.length > 0 || bg.tasks().length > 0) return;
      graceTimer = setTimeout(() => finish('grace'), this.bgGraceMs);
      graceTimer.unref?.();
    };
    const audit = toolAudit(req);
    // Tool inputs by call id (for a permission_denied frame, which carries none); emptied at each result.
    const toolInputs = new Map<string, unknown>();
    const options = buildOptions(req, { home: this.home, accounts: this.accounts, baseEnv: this.baseEnv, abortController, steer: this.steer, audit, onStderr: (s) => { stderrTail = (stderrTail + s).slice(-STDERR_MAX); } });
    const write = async (f: { text: string; attachments: Attachment[] }, steerId: string | null): Promise<boolean> => {
      if (input.closed) return false;
      // Counted before the first await: the loop decides whether to close right after a result,
      // and a message sent from that result's handler must already keep the input open.
      const uuid = randomUUID();
      unanswered.push(uuid);
      if (steerId !== null) steers.set(uuid, steerId);
      idle = false;
      clearGrace();
      const undo = () => { answer([uuid]); steers.delete(uuid); idle = unanswered.length === 0; armGrace(); };
      let m: SDKUserMessage;
      try {
        m = await toUserMessage(f.text, f.attachments, this.readFile);
      } catch (err) {
        undo();
        throw err;
      }
      // 'next' (the CLI's default) is what folds a mid-turn message in at the next tool boundary; 'now' would abort the turn.
      if (!input.push({ ...m, uuid, ...(steerId !== null ? { priority: 'next' as const } : {}) })) { undo(); return false; }
      return true;
    };
    const live: LiveInput = {
      send: (f) => write(f, null),
      steer: (f, id) => write(f, id),
      stopTask: async (taskId) => {
        if (input.closed || typeof handle?.stopTask !== 'function') return false;
        await handle.stopTask(taskId);
        return true;
      },
      setPermissionMode: async (mode) => {
        if (input.closed || typeof handle?.setPermissionMode !== 'function') return false;
        await handle.setPermissionMode(mode);
        return true;
      },
    };
    try {
      const first = randomUUID();
      unanswered.push(first);
      input.push({ ...(await toUserMessage(req.prompt, req.attachments ?? [], this.readFile)), uuid: first });
      const stream = this.queryFn({ prompt: input, options });
      handle = stream as Handle;
      if (typeof handle.stopTask !== 'function') delete live.stopTask;
      if (typeof handle.setPermissionMode !== 'function') delete live.setPermissionMode;
      // Switched off, or a handoff note (no tools: no boundary to fold at): the caller queues for after the turn.
      if (!this.steer || req.noTools) delete live.steer;
      req.onLive?.(live);
      for await (const m of stream) {
        // The CLI's own non-querying turn (a notification queued shouldQuery:false — e.g. the orphaned-agent notice it
        // injects on resume) still writes a result: no uuids, no model turn, origin not ours. It answers nothing we wrote
        // and is no turn of ours — counting it closed the input before our prompt ran. With nothing of ours unanswered
        // (idle after our result: e.g. an agent hand-back) it can steal no answer, so it goes through as a normal result —
        // closing the continuation segment its notification opened and running the close check.
        // A failed one (setup error) is the CLI's, not our prompt's: logged, never shown as our turn's failure.
        if (isInjectedNoopResult(m) && unanswered.length > 0) {
          const r = m as unknown as Rec;
          if (r.subtype !== 'success' || r.is_error === true) console.warn(`deck: CLI-injected turn failed (not ours): ${[r.subtype, ...(Array.isArray(r.errors) ? r.errors : [])].join(': ')}`);
          continue;
        }
        if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'tool_use') toolInputs.set(b.id, b.input);
        for (const d of deniedCalls(m, toolInputs)) await audit.report(d, 'deny', d.source);
        if (m.type === 'result') toolInputs.clear();
        if (bg.apply(m)) {
          const tasks = bg.tasks();
          const detail = bg.detail();
          const sig = JSON.stringify(detail.map((t) => [t.id, t.description, t.type]));
          if (sig !== shownSig) { shownSig = sig; shownTasks = tasks; yield { kind: 'background', tasks, detail }; }
          armGrace();
        }
        if (idle && isActivity(m)) { idle = false; clearGrace(); yield { kind: 'continue', cause: 'background' }; }
        const prog = meter.apply(m);
        if (prog) yield { kind: 'progress', ...prog };
        if (m.type === 'assistant' && m.parent_tool_use_id === null) lastCtx = contextUsageOf((m.message as unknown as Rec).usage) ?? lastCtx;
        if (m.type === 'assistant' && typeof (m as unknown as Rec).error === 'string') errorKind = (m as unknown as Rec).error as string;
        if (this.onCommands) noteCommands(m, req.cwd, this.onCommands);
        if (m.type === 'user' && (m as unknown as Rec).isReplay === true && typeof m.uuid === 'string') {
          const id = steers.get(m.uuid);
          if (id !== undefined) { steers.delete(m.uuid); echoed.push(m.uuid); yield { kind: 'steer_delivered', id }; }
        }
        let gotResult = false;
        for (const ev of mapSdkMessage(m)) {
          if (ev.kind === 'init') sessionId = ev.sessionId;
          if (ev.kind === 'result') {
            sawResult = true;
            gotResult = true;
            const r = m as unknown as Rec;
            const ids = Array.isArray(r.user_message_uuids) ? (r.user_message_uuids as unknown[]).filter((x): x is string => typeof x === 'string')
              : typeof r.user_message_uuid === 'string' ? [r.user_message_uuid] : null;
            if (ids) namesAnswers = true;
            if (ids && ids.length && ids.some((u) => unanswered.includes(u))) {
              // A steer the result names but whose echo never came still reached the model: report it before the result.
              for (const u of ids) {
                const id = steers.get(u);
                if (id !== undefined) { steers.delete(u); yield { kind: 'steer_delivered', id }; }
              }
              answer(ids);
            } else if (ids && ids.length) {
              // Names none of ours: attribute as if unnamed rather than leave the input open until bgMaxMs.
              console.warn('deck: result answers no message written to this process', { session: sessionId, ids, unanswered: unanswered.length });
              answer([...unanswered.slice(0, 1), ...echoed]);
            } else if (!namesAnswers || !ev.ok) {
              // No uuids from an older CLI, or a delivery failure / error result: the oldest message, plus any steer folded into this turn.
              answer([...unanswered.slice(0, 1), ...echoed]);
            }
            // else: a CLI that names its answers named none — a background continuation, answering nothing we wrote.
            echoed = [];
            yield { ...ev, ...(lastCtx ? { usage: { ...ev.usage, context: lastCtx } } : {}), errorKind: ev.errorKind ?? errorKind, stderr: ev.ok ? null : stderrTail || null };
            errorKind = null;
            lastCtx = null;
            meter.reset();
          } else {
            yield ev;
          }
        }
        if (!gotResult) continue;
        // Decided after the consumer handled the result (it may have sent a queued follow-up meanwhile).
        if (unanswered.length === 0 && bg.tasks().length === 0) break;
        idle = unanswered.length === 0;
        if (!capTimer) { capTimer = setTimeout(() => finish('cap'), this.bgMaxMs); capTimer.unref?.(); }
        armGrace();
      }
    } catch (err) {
      // The SDK throws after yielding an error result; only synthesize one if none was seen.
      if (!sawResult) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { kind: 'result', sessionId, ok: false, text: '', usage: ZERO_USAGE, errorText: msg, stderr: stderrTail || null, errorKind, terminalReason: null };
      }
    } finally {
      input.close();
      if (capTimer) clearTimeout(capTimer);
      clearGrace();
      req.signal.removeEventListener('abort', onAbort);
    }
    if (ended === 'cap') yield { kind: 'notice', message: `백그라운드 작업이 ${Math.round(this.bgMaxMs / 60_000)}분 안에 끝나지 않아 프로세스를 종료했습니다` };
    if (shownTasks.length) yield { kind: 'background', tasks: [], detail: [] };
  }
}
