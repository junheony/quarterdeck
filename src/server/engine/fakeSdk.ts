import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PromptInput } from './ClaudeEngine';

/**
 * Test double for the Agent SDK `query()` in streaming-input mode: the test feeds SDK messages
 * with `push` (the stream waits for more until `end`), records every user message the engine
 * writes to the input and whether the input was closed; abort makes the stream throw like the SDK.
 */
export function fakeSdk() {
  const inputs: SDKUserMessage[] = [];
  const queue: SDKMessage[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const state = { inputClosed: false, calls: 0 };
  /** Task ids passed to `Query.stopTask` (each answered with a stopped task_notification, like the SDK). */
  const stopped: string[] = [];
  const poke = () => { const w = wake; wake = null; w?.(); };
  const gen = async function* (p: { prompt: PromptInput; options?: Options }): AsyncGenerator<SDKMessage> {
    state.calls++;
    const prompt = p.prompt;
    if (typeof prompt !== 'string') {
      void (async () => {
        for await (const m of prompt) { inputs.push(m); poke(); }
        state.inputClosed = true;
        poke();
      })();
    }
    const signal = p.options?.abortController?.signal;
    for (;;) {
      if (signal?.aborted) throw new Error('Claude Code process aborted by user');
      const m = queue.shift();
      if (m) { yield m; continue; }
      if (ended) return;
      await new Promise<void>((resolve) => { wake = resolve; signal?.addEventListener('abort', () => resolve(), { once: true }); });
    }
  };
  const queryFn = (p: { prompt: PromptInput; options?: Options }) => Object.assign(gen(p), {
    stopTask: async (id: string) => {
      stopped.push(id);
      queue.push({ type: 'system', subtype: 'task_notification', task_id: id, status: 'stopped', output_file: '', summary: 'stopped', session_id: 's1' } as unknown as SDKMessage);
      poke();
    },
  });
  return {
    queryFn,
    inputs,
    state,
    stopped,
    push: (...ms: unknown[]) => { queue.push(...(ms as SDKMessage[])); poke(); },
    end: () => { ended = true; poke(); },
  };
}

/** SDK message builders (shapes from sdk.d.ts). */
export const sdk = {
  init: (sid = 's1') => ({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5' }),
  delta: (text: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }),
  result: (text: string, sid = 's1') => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, usage: { input_tokens: 1, output_tokens: 2 } }),
  bgLevel: (tasks: { id: string; desc: string; ambient?: boolean }[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: tasks.map((t) => ({ task_id: t.id, task_type: 'local_agent', description: t.desc, ...(t.ambient ? { ambient: true } : {}) })), session_id: 's1' }),
  taskStarted: (id: string, desc: string, backgrounded = true) => ({ type: 'system', subtype: 'task_started', task_id: id, description: desc, is_backgrounded: backgrounded, session_id: 's1' }),
  taskDone: (id: string) => ({ type: 'system', subtype: 'task_notification', task_id: id, status: 'completed', output_file: '/tmp/o', summary: 'done', session_id: 's1' }),
  /** The CLI's injected notification turn opener (origin task-notification). */
  notifyUser: () => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: '<task-notification>done</task-notification>' }, origin: { kind: 'task-notification' }, session_id: 's1' }),
  /** The result the CLI writes for a notification it queues without asking the model (shouldQuery:false — e.g. the orphaned-agent notice on resume): no uuids, no turns, zero usage. */
  notifyNoopResult: () => ({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0, session_id: 's1', usage: { input_tokens: 0, output_tokens: 0 }, origin: { kind: 'task-notification' } }),
  /** Main-conversation stream events (token meter / phase). */
  messageStart: () => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: {} } }),
  blockStart: (type: 'text' | 'thinking' | 'tool_use') => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type } } }),
  messageDelta: (outputTokens: number) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: {}, usage: { output_tokens: outputTokens } } }),
  /** An Agent tool call in the main conversation, its subagent's task messages, and the subagent's own tool use/result. */
  agentCall: (id = 'toolu_ag', desc = 'count files') => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { description: desc, subagent_type: 'general-purpose', prompt: 'count' } }] }, session_id: 's1' }),
  agentStarted: (taskId = 'a1', toolUseId = 'toolu_ag') => ({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, description: 'count files', subagent_type: 'general-purpose', task_type: 'local_agent', session_id: 's1' }),
  agentProgress: (taskId = 'a1', toolUseId = 'toolu_ag', tokens = 1200) => ({ type: 'system', subtype: 'task_progress', task_id: taskId, tool_use_id: toolUseId, description: 'count files', usage: { total_tokens: tokens, tool_uses: 2, duration_ms: 3000 }, last_tool_name: 'Bash', session_id: 's1' }),
  subToolCall: (parent = 'toolu_ag', id = 'sub1', name = 'Bash', input: unknown = { command: 'ls' }) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id, name, input }] }, session_id: 's1' }),
  subToolResult: (parent = 'toolu_ag', id = 'sub1', isError = false) => ({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'a\nb', is_error: isError }] }, session_id: 's1' }),
  subagentTool: () => ({ type: 'assistant', parent_tool_use_id: 'toolu_bg', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }] }, session_id: 's1' }),
};
