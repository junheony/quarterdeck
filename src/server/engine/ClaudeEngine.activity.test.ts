import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { BackgroundTracker, ClaudeEngine, ProgressMeter, mapSdkMessage } from './ClaudeEngine';
import type { EngineEvent, LiveInput, TurnRequest } from './Engine';
import { fakeSdk, sdk } from './fakeSdk';
import { testRegistry } from '../../shared/accounts.testkit';

const M = (o: unknown) => o as SDKMessage;

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return { account: 'c', cwd: '/w', resumeSessionId: null, model: 'opus', prompt: 'hi', signal: new AbortController().signal, onPermission: async () => 'once', ...over };
}

async function all(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('mapSdkMessage: subagent activity', () => {
  it("a subagent's tool calls and results ride with the parent Agent call, never as main transcript events", () => {
    expect(mapSdkMessage(M(sdk.subToolCall()))).toEqual([{ kind: 'sub_tool_call', parentToolUseId: 'toolu_ag', toolUseId: 'sub1', name: 'Bash', input: { command: 'ls' } }]);
    expect(mapSdkMessage(M(sdk.subToolResult('toolu_ag', 'sub1', true)))).toEqual([{ kind: 'sub_tool_result', parentToolUseId: 'toolu_ag', toolUseId: 'sub1', isError: true }]);
    // The subagent's own streamed text stays out.
    expect(mapSdkMessage(M({ type: 'stream_event', parent_tool_use_id: 'toolu_ag', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } }))).toEqual([]);
  });

  it('task_started / task_progress / task_updated → task_update; ambient tasks are left out', () => {
    expect(mapSdkMessage(M(sdk.agentStarted()))).toEqual([{ kind: 'task_update', taskId: 'a1', toolUseId: 'toolu_ag', status: 'running', description: 'count files', subagentType: 'general-purpose', taskType: 'local_agent' }]);
    expect(mapSdkMessage(M(sdk.agentProgress()))).toEqual([{ kind: 'task_update', taskId: 'a1', toolUseId: 'toolu_ag', status: 'running', usage: { totalTokens: 1200, toolUses: 2, durationMs: 3000 }, lastToolName: 'Bash' }]);
    expect(mapSdkMessage(M({ type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'killed' } }))).toEqual([{ kind: 'task_update', taskId: 'a1', toolUseId: null, status: 'stopped' }]);
    expect(mapSdkMessage(M({ ...sdk.agentStarted(), ambient: true }))).toEqual([]);
  });

  it('task_notification carries the task id, its Agent call and usage', () => {
    expect(mapSdkMessage(M({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'toolu_ag', status: 'completed', summary: '42 files', usage: { total_tokens: 9, tool_uses: 3, duration_ms: 4100 } }))).toEqual([
      { kind: 'task_done', status: 'completed', summary: '42 files', taskId: 'a1', toolUseId: 'toolu_ag', usage: { totalTokens: 9, toolUses: 3, durationMs: 4100 } },
    ]);
  });
});

describe('ProgressMeter', () => {
  it('counts output tokens of the main conversation: exact per finished message, estimated while streaming', () => {
    let t = 0;
    const m = new ProgressMeter(() => t, 400);
    expect(m.apply(M(sdk.delta('ignored before message_start')))).toBeNull();
    expect(m.apply(M(sdk.messageStart()))).toBeNull();
    expect(m.apply(M(sdk.blockStart('thinking')))).toEqual({ outputTokens: 0, phase: 'thinking' });
    t = 1000;
    expect(m.apply(M(sdk.blockStart('text')))).toEqual({ outputTokens: 0, phase: 'responding' });
    t = 2000;
    expect(m.apply(M(sdk.delta('x'.repeat(400))))).toEqual({ outputTokens: 100, phase: 'responding' });
    // Throttled: within minGap nothing is emitted.
    expect(m.apply(M(sdk.delta('x'.repeat(40))))).toBeNull();
    expect(m.apply(M(sdk.messageDelta(120)))).toEqual({ outputTokens: 120, phase: 'responding' });
    // A subagent's stream does not count.
    expect(m.apply(M({ type: 'stream_event', parent_tool_use_id: 'p', event: { type: 'message_delta', usage: { output_tokens: 999 } } }))).toBeNull();
    m.apply(M(sdk.messageStart()));
    expect(m.apply(M(sdk.blockStart('tool_use')))).toEqual({ outputTokens: 120, phase: 'tool' });
    m.reset();
    m.apply(M(sdk.messageStart()));
    expect(m.apply(M(sdk.blockStart('text')))).toEqual({ outputTokens: 0, phase: 'responding' });
  });
});

describe('BackgroundTracker detail', () => {
  it('keeps each live task id, type and first-seen time', () => {
    let t = 5000;
    const b = new BackgroundTracker(() => t);
    b.apply(M({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'k', task_type: 'local_bash', description: 'sleep 20' }] }));
    t = 9000;
    b.apply(M({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'k', task_type: 'local_bash', description: 'sleep 20' }, { task_id: 'g', task_type: 'local_agent', description: 'explore' }] }));
    expect(b.detail()).toEqual([
      { id: 'k', description: 'sleep 20', type: 'local_bash', startedAtMs: 5000 },
      { id: 'g', description: 'explore', type: 'local_agent', startedAtMs: 9000 },
    ]);
  });
});

describe('ClaudeEngine: activity events in a turn', () => {
  it('streams progress, subagent calls and task updates; background carries detail', async () => {
    const f = fakeSdk();
    f.push(
      sdk.init(), sdk.messageStart(), sdk.blockStart('tool_use'), sdk.agentCall(), sdk.messageDelta(30),
      sdk.agentStarted(), sdk.subToolCall(), sdk.subToolResult(), sdk.agentProgress(),
      { type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'toolu_ag', status: 'completed', summary: '42', session_id: 's1' },
      sdk.result('ok'),
    );
    const evs = await all(new ClaudeEngine({ accounts: testRegistry(), queryFn: f.queryFn, readFile: async () => Buffer.from('') }).runTurn(req()));
    expect(evs.map((e) => e.kind)).toEqual(['init', 'progress', 'tool_call', 'progress', 'task_update', 'sub_tool_call', 'sub_tool_result', 'task_update', 'task_done', 'result']);
    expect(evs[1]).toEqual({ kind: 'progress', outputTokens: 0, phase: 'tool' });
    expect(evs[3]).toEqual({ kind: 'progress', outputTokens: 30, phase: 'tool' });
  });

  it('LiveInput.stopTask stops one task through Query.stopTask', async () => {
    const f = fakeSdk();
    let live: LiveInput | null = null;
    f.push(sdk.init(), sdk.bgLevel([{ id: 'k', desc: 'sleep 20' }]), sdk.result('launched'));
    const it = new ClaudeEngine({ accounts: testRegistry(), queryFn: f.queryFn, readFile: async () => Buffer.from('') }).runTurn(req({ onLive: (l) => { live = l; } }))[Symbol.asyncIterator]();
    const seen: EngineEvent[] = [];
    while (!seen.some((e) => e.kind === 'result')) seen.push((await it.next()).value as EngineEvent);
    const bg = seen.find((e) => e.kind === 'background');
    expect(bg).toMatchObject({ kind: 'background', tasks: ['sleep 20'], detail: [{ id: 'k', description: 'sleep 20', type: 'local_agent' }] });
    expect(live!.stopTask).toBeTypeOf('function');
    expect(await live!.stopTask!('k')).toBe(true);
    expect(f.stopped).toEqual(['k']);
    expect((await it.next()).value).toMatchObject({ kind: 'task_done', status: 'stopped', taskId: 'k' });
    f.push(sdk.bgLevel([]));
    f.end();
    const rest: EngineEvent[] = [];
    for (let n = await it.next(); !n.done; n = await it.next()) rest.push(n.value);
    expect(rest.at(-1)).toMatchObject({ kind: 'background', tasks: [] });
  });
});
