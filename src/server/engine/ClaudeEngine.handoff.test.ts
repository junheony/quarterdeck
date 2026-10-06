import { describe, expect, it } from 'vitest';
import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeEngine, KEEP_PLANNING_MESSAGE, NO_TOOLS_MESSAGE, buildOptions } from './ClaudeEngine';
import type { EngineEvent, TurnRequest } from './Engine';
import { fakeSdk, sdk } from './fakeSdk';
import { testRegistry } from '../../shared/accounts.testkit';

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return { account: 'c', cwd: '/w', resumeSessionId: 's1', model: 'opus', prompt: 'note', signal: new AbortController().signal, onPermission: async () => 'once', ...over };
}
const deps = { home: '/h', accounts: testRegistry('/h'), baseEnv: {}, abortController: new AbortController(), onStderr: () => {} };
const ctx = { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r1' } as never;

async function runHook(o: Options): Promise<unknown> {
  const m = (o.hooks?.PreToolUse ?? []) as HookCallbackMatcher[];
  expect(m).toHaveLength(1);
  return m[0]!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu1', session_id: 's1', transcript_path: '', cwd: '/w' } as never, 'tu1', { signal: new AbortController().signal });
}

describe('buildOptions: handoff note turn (noTools)', () => {
  it('denies every tool call through a PreToolUse hook and canUseTool, without asking', async () => {
    const asked: string[] = [];
    const o = buildOptions(req({ noTools: true, onPermission: async (p) => { asked.push(p.toolName); return 'once'; }, autoApprove: () => true }), deps);
    expect(await runHook(o)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NO_TOOLS_MESSAGE } });
    expect(await o.canUseTool!('Bash', { command: 'ls' }, ctx)).toMatchObject({ behavior: 'deny', message: NO_TOOLS_MESSAGE });
    expect(await o.canUseTool!('AskUserQuestion', { questions: [] }, ctx)).toMatchObject({ behavior: 'deny' });
    expect(asked).toEqual([]);
  });

  it('wins over every permission mode: plan, acceptEdits and 모두 자동 승인 still get no tools', async () => {
    for (const mode of [undefined, 'acceptEdits', 'plan'] as const) {
      for (const auto of [true, false]) {
        const asked: string[] = [];
        const o = buildOptions(req({ noTools: true, permissionMode: mode, autoApprove: () => auto, onPermission: async (p) => { asked.push(p.toolName); return 'session'; } }), deps);
        expect(await runHook(o)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
        for (const t of ['Bash', 'Edit', 'ExitPlanMode']) expect(await o.canUseTool!(t, { plan: 'p' }, ctx)).toMatchObject({ behavior: 'deny', message: NO_TOOLS_MESSAGE });
        expect(asked).toEqual([]);
      }
    }
  });

  it('keeps the rest of the options (tools, model, resume) as a normal turn so the cached prefix still hits', () => {
    const { hooks, canUseTool: _a, abortController: _b, stderr: _c, ...withTools } = buildOptions(req({ noTools: true }), deps);
    const { hooks: normalHooks, canUseTool: _d, abortController: _e, stderr: _f, ...normal } = buildOptions(req(), deps);
    expect(hooks?.PreToolUse).toHaveLength(1);
    expect(normalHooks).not.toHaveProperty('PreToolUse');
    expect(Object.keys(normalHooks ?? {}).sort()).toEqual(['PermissionDenied', 'PostToolUse', 'PostToolUseFailure']);
    expect(withTools).toEqual(normal);
  });
});

describe('buildOptions: one audit line per tool call', () => {
  type Audit = Parameters<NonNullable<TurnRequest['onToolAudit']>>[0];
  const fire = (o: Options, ev: 'PostToolUse' | 'PostToolUseFailure' | 'PermissionDenied', id: string) =>
    ((o.hooks?.[ev] ?? []) as HookCallbackMatcher[])[0]!.hooks[0]!({ hook_event_name: ev, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: id, session_id: 's1', transcript_path: '', cwd: '/w' } as never, id, { signal: new AbortController().signal });

  it('reports a call the CLI ran without asking (no canUseTool) once as cli, skips calls canUseTool already decided, and reports denials', async () => {
    const got: Audit[] = [];
    const o = buildOptions(req({ onToolAudit: async (e) => { got.push(e); } }), deps);
    expect(await fire(o, 'PostToolUse', 'r1')).toEqual({ continue: true });
    await o.canUseTool!('Bash', { command: 'ls' }, { ...(ctx as object), toolUseID: 'c1' } as never);
    await fire(o, 'PostToolUse', 'c1');
    await fire(o, 'PostToolUseFailure', 'r2');
    await fire(o, 'PermissionDenied', 'r3');
    await fire(o, 'PostToolUse', 'r1');
    expect(got.map((e) => [e.toolUseId, e.decision, e.source])).toEqual([['r1', 'allow', 'cli'], ['r2', 'allow', 'cli'], ['r3', 'deny', 'cli']]);
  });

  it('a handoff note turn reports its own refusal as deck, and a failing audit sink never breaks the turn', async () => {
    const got: Audit[] = [];
    const o = buildOptions(req({ noTools: true, onToolAudit: async (e) => { got.push(e); throw new Error('disk full'); } }), deps);
    expect(await runHook(o)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(got.map((e) => [e.toolName, e.decision, e.source])).toEqual([['Bash', 'deny', 'deck']]);
  });
});

describe('ClaudeEngine: denials from the stream are audited (deck\'s modes never fire the PermissionDenied hook)', () => {
  type Audit = Parameters<NonNullable<TurnRequest['onToolAudit']>>[0];
  const call = (id: string, input: unknown) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Bash', input }] }, session_id: 's1' });

  it('a permission_denied frame and result.permission_denials: one line per call, rule vs cli, never one canUseTool decided', async () => {
    const f = fakeSdk();
    const queryFn = ((p: Parameters<typeof f.queryFn>[0]) => {
      // A call deck itself asked the user about (and audits itself): canUseTool marks it before it runs.
      void p.options!.canUseTool!('Bash', { command: 'rm' }, { ...(ctx as object), toolUseID: 'c1' } as never);
      return f.queryFn(p);
    }) as typeof f.queryFn;
    f.push(
      sdk.init('s1'),
      call('d1', { command: 'curl x' }),
      { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'd1', decision_reason_type: 'rule', message: 'denied', uuid: 'u1', session_id: 's1' },
      call('d2', { command: 'sudo ls' }),
      { ...sdk.result('done', 's1'), permission_denials: [
        { tool_name: 'Bash', tool_use_id: 'd1', tool_input: { command: 'curl x' } },
        { tool_name: 'Bash', tool_use_id: 'd2', tool_input: { command: 'sudo ls' } },
        { tool_name: 'Bash', tool_use_id: 'c1', tool_input: { command: 'rm' } },
      ] },
    );
    f.end();
    const got: Audit[] = [];
    for await (const _ of new ClaudeEngine({ accounts: testRegistry(), queryFn, readFile: async () => Buffer.from('') }).runTurn(req({ onToolAudit: async (e) => { got.push(e); } }))) { /* drain */ }
    expect(got).toEqual([
      { toolName: 'Bash', input: { command: 'curl x' }, toolUseId: 'd1', decision: 'deny', source: 'rule' },
      { toolName: 'Bash', input: { command: 'sudo ls' }, toolUseId: 'd2', decision: 'deny', source: 'cli' },
    ]);
  });
});

describe('ClaudeEngine: handoff note turn through the SDK (fake)', () => {
  it('hands the no-tools hook to query() and streams the note like any turn', async () => {
    const f = fakeSdk();
    let seen: Options | undefined;
    const queryFn = ((p: Parameters<typeof f.queryFn>[0]) => { seen = p.options; return f.queryFn(p); }) as typeof f.queryFn;
    f.push(sdk.init('s1'), sdk.delta('## 목표'), sdk.result('## 목표', 's1'));
    f.end();
    const evs: EngineEvent[] = [];
    for await (const e of new ClaudeEngine({ accounts: testRegistry(), queryFn, readFile: async () => Buffer.from('') }).runTurn(req({ noTools: true }))) evs.push(e);
    expect(evs.map((e) => e.kind)).toEqual(['init', 'delta', 'result']);
    expect(seen?.resume).toBe('s1');
    expect(await runHook(seen!)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
});
