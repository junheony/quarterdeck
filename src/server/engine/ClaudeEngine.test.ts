import { describe, expect, it } from 'vitest';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeEngine, KEEP_PLANNING_MESSAGE, buildOptions, buildPrompt, mapSdkMessage } from './ClaudeEngine';
import { parseQuestions, sessionAllowLabel, sessionAllowOffered, type EngineEvent, type TurnRequest } from './Engine';
import { testRegistry } from '../../shared/accounts.testkit';

const M = (o: unknown) => o as SDKMessage;

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return { account: 'c', cwd: '/w', resumeSessionId: null, model: 'opus', prompt: 'hi', signal: new AbortController().signal, onPermission: async () => 'once', ...over };
}

describe('buildOptions', () => {
  it('selects the profile env, model alias, default permission mode, user+project+local settings, streaming', () => {
    const o = buildOptions(req({ account: 'b', model: 'fable', resumeSessionId: 'sid' }), { home: '/h', accounts: testRegistry('/h'), baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'k' }, abortController: new AbortController(), onStderr: () => {} });
    expect(o.cwd).toBe('/w');
    expect(o.env).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/h/.claude-b' });
    expect(o.model).toBe('claude-fable-5-1');
    expect(o).not.toHaveProperty('effort');
    expect(o.resume).toBe('sid');
    expect(o.permissionMode).toBe('default');
    expect(o.settingSources).toEqual(['user', 'project', 'local']);
    expect(o.includePartialMessages).toBe(true);
    const a = buildOptions(req({ account: 'a' }), { home: '/h', accounts: testRegistry('/h'), baseEnv: { CLAUDE_CONFIG_DIR: '/h/.claude-c' }, abortController: new AbortController(), onStderr: () => {} });
    expect(a.env).toEqual({});
    expect(a.resume).toBeUndefined();
  });

  it('maps permission decisions to PermissionResult', async () => {
    const seen: string[] = [];
    const mk = (d: 'once' | 'session' | 'deny') => buildOptions(req({ onPermission: async (p) => { seen.push(p.toolName + ':' + p.toolUseId); return d; } }), { home: '/h', accounts: testRegistry('/h'), baseEnv: {}, abortController: new AbortController(), onStderr: () => {} });
    const ctx = { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r1' } as never;
    expect(await mk('once').canUseTool!('Bash', { command: 'ls' }, ctx)).toEqual({ behavior: 'allow' });
    // No suggestions from the SDK → nothing scoped to remember: a plain one-time allow.
    expect(await mk('session').canUseTool!('Bash', {}, ctx)).toEqual({ behavior: 'allow' });
    expect(await mk('deny').canUseTool!('Write', {}, ctx)).toMatchObject({ behavior: 'deny' });
    expect(seen).toEqual(['Bash:tu1', 'Bash:tu1', 'Write:tu1']);
  });
});

describe('buildOptions: model version and effort', () => {
  const deps = { home: '/h', accounts: testRegistry('/h'), baseEnv: {}, abortController: new AbortController(), onStderr: () => {} };
  it('passes the exact model id and the per-turn effort as Options.effort', () => {
    const o = buildOptions(req({ model: 'opus', effort: 'xhigh' }), deps);
    expect(o.model).toBe('claude-opus-5-5');
    expect(o.effort).toBe('xhigh');
    expect(buildOptions(req({ model: 'sonnet', effort: 'low' }), deps)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' });
  });

  it('asks the CLI to echo consumed user messages (steer confirmation) unless steering is switched off', () => {
    expect(buildOptions(req(), deps).extraArgs).toEqual({ 'replay-user-messages': null });
    expect(buildOptions(req(), { ...deps, steer: false }).extraArgs).toBeUndefined();
  });
});

describe('buildOptions: allow for this session (review I4)', () => {
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git status' }], behavior: 'allow', destination: 'session' }];
  const deps = { home: '/h', accounts: testRegistry('/h'), baseEnv: {}, abortController: new AbortController(), onStderr: () => {} };

  it('returns the SDK suggestions as updatedPermissions and relays the prompt details', async () => {
    const seen: unknown[] = [];
    const o = buildOptions(req({ onPermission: async (p) => { seen.push(p); return 'session'; } }), deps);
    const ctx = { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r1', suggestions, title: 'Claude wants to run git status', decisionReason: 'not allowlisted', blockedPath: '/etc', defaultToNo: true } as never;
    expect(await o.canUseTool!('Bash', { command: 'git status' }, ctx)).toEqual({ behavior: 'allow', updatedPermissions: suggestions });
    expect(seen[0]).toMatchObject({ toolName: 'Bash', suggestions, title: 'Claude wants to run git status', decisionReason: 'not allowlisted', blockedPath: '/etc', defaultToNo: true, suppressAlwaysAllowRule: false });
  });

  it('suppressAlwaysAllowRule turns 이 세션 into a one-time allow', async () => {
    const o = buildOptions(req({ onPermission: async () => 'session' }), deps);
    const ctx = { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r1', suggestions, suppressAlwaysAllowRule: true } as never;
    expect(await o.canUseTool!('Bash', { command: 'git status' }, ctx)).toEqual({ behavior: 'allow' });
  });

  it('pre-allows the session\'s stored rules and directories through the flag-settings layer', () => {
    const o = buildOptions(req({ allowRules: ['Bash(git status)'], allowDirs: ['/data'] }), deps);
    expect(o.settings).toEqual({ permissions: { allow: ['Bash(git status)'] } });
    expect(o.additionalDirectories).toEqual(['/data']);
    const none = buildOptions(req(), deps);
    expect(none.settings).toBeUndefined();
    expect(none.additionalDirectories).toBeUndefined();
  });
});

// Shapes captured from the real CLI (account b, deck's own buildOptions) — not fabricated.
const REAL_WRITE_SUGGESTIONS = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
const REAL_BASH_SUGGESTIONS = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch s3.txt' }], behavior: 'allow', destination: 'localSettings' },
  { type: 'addDirectories', directories: ['/w/sub'], destination: 'session' },
  { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
];

describe('buildOptions: 이 세션 never persists outside the session', () => {
  const deps = { home: '/h', accounts: testRegistry('/h'), baseEnv: {}, abortController: new AbortController(), onStderr: () => {} };
  const answer = async (suggestions: unknown[], extra: Record<string, unknown> = {}) => {
    const o = buildOptions(req({ onPermission: async () => 'session' }), deps);
    const ctx = { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r1', suggestions, ...extra } as never;
    return (await o.canUseTool!('Bash', { command: 'touch s3.txt' }, ctx)) as { behavior: string; updatedPermissions?: Array<{ destination: string }> };
  };

  it('real Bash suggestions: every destination is rewritten to session (localSettings is never returned)', async () => {
    const r = await answer(REAL_BASH_SUGGESTIONS);
    expect(r.updatedPermissions).toEqual([
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch s3.txt' }], behavior: 'allow', destination: 'session' },
      { type: 'addDirectories', directories: ['/w/sub'], destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ]);
    expect(r.updatedPermissions!.every((u) => u.destination === 'session')).toBe(true);
  });

  it('real Write suggestion: setMode acceptEdits is returned with destination session', async () => {
    expect(await answer(REAL_WRITE_SUGGESTIONS)).toEqual({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
  });

  it('unknown kinds, deny/ask rules, removals and bypassPermissions are dropped', async () => {
    const r = await answer([
      { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
      { type: 'setMode', mode: 'dontAsk', destination: 'session' },
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'userSettings' },
      { type: 'replaceRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
      { type: 'removeDirectories', directories: ['/x'], destination: 'session' },
      { type: 'somethingNew', destination: 'projectSettings' },
      { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '/w/**' }], behavior: 'allow', destination: 'projectSettings' },
    ]);
    expect(r.updatedPermissions).toEqual([{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '/w/**' }], behavior: 'allow', destination: 'session' }]);
  });

  it('nothing persistable: a plain one-time allow, no updatedPermissions', async () => {
    expect(await answer([{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }])).toEqual({ behavior: 'allow' });
    expect(await answer(REAL_BASH_SUGGESTIONS, { suppressAlwaysAllowRule: true })).toEqual({ behavior: 'allow' });
  });

  it('once never returns updatedPermissions', async () => {
    const o = buildOptions(req({ onPermission: async () => 'once' }), deps);
    const ctx = { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r1', suggestions: REAL_BASH_SUGGESTIONS } as never;
    expect(await o.canUseTool!('Bash', {}, ctx)).toEqual({ behavior: 'allow' });
  });

  it('a session that accepted edits runs later turns in acceptEdits', () => {
    expect(buildOptions(req({ permissionMode: 'acceptEdits' }), deps).permissionMode).toBe('acceptEdits');
    expect(buildOptions(req(), deps).permissionMode).toBe('default');
  });
});

describe('sessionAllowOffered / sessionAllowLabel', () => {
  it('offered only when something is persistable; the label says what', () => {
    const s = (suggestions: unknown[], suppress = false) => ({ suggestions: suggestions as never, suppressAlwaysAllowRule: suppress });
    expect(sessionAllowLabel(s(REAL_WRITE_SUGGESTIONS))).toBe('이 세션 동안 파일 편집 허용');
    expect(sessionAllowLabel(s(REAL_BASH_SUGGESTIONS))).toBe('이 세션 동안 `Bash(touch s3.txt)`, `/w/sub` 폴더 접근, 파일 편집 허용');
    expect(sessionAllowLabel(s([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' }]))).toBe('이 세션 동안 `Bash(ls)` 허용');
    expect(sessionAllowOffered(s(REAL_WRITE_SUGGESTIONS))).toBe(true);
    expect(sessionAllowOffered(s([{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }, { type: 'somethingNew' }]))).toBe(false);
    expect(sessionAllowLabel(s([{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }]))).toBeNull();
    expect(sessionAllowOffered(s([]))).toBe(false);
    expect(sessionAllowOffered(s(REAL_BASH_SUGGESTIONS, true))).toBe(false);
    expect(sessionAllowLabel(s(REAL_BASH_SUGGESTIONS, true))).toBeNull();
  });
});

describe('mapSdkMessage', () => {
  it('a background task notification → task_done (drives a push)', () => {
    expect(mapSdkMessage(M({ type: 'system', subtype: 'task_notification', task_id: 'k', status: 'completed', output_file: '/tmp/o', summary: 'npm test 끝' }))).toEqual([{ kind: 'task_done', status: 'completed', summary: 'npm test 끝', taskId: 'k', toolUseId: null }]);
  });

  it('a replayed user message (--replay-user-messages) maps to nothing, even when it carries a tool_result', () => {
    const tr = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }] };
    expect(mapSdkMessage(M({ type: 'user', parent_tool_use_id: null, isReplay: true, message: tr }))).toEqual([]);
    expect(mapSdkMessage(M({ type: 'user', parent_tool_use_id: 'agent', isReplay: true, message: tr }))).toEqual([]);
    expect(mapSdkMessage(M({ type: 'user', parent_tool_use_id: null, message: tr }))).toEqual([{ kind: 'tool_result', toolUseId: 'u1', content: 'ok', isError: false }]);
  });

  it('a synthetic / meta top-level user message → a system event (hook, peer, task); context-only ones and replays → nothing', () => {
    const msg = { role: 'user', content: 'Stop hook feedback:\n[verify] 테스트 실패' };
    const stop = [{ kind: 'system', source: 'Stop', label: 'Stop 훅이 이어서 진행시킴', text: 'Stop hook feedback:\n[verify] 테스트 실패' }];
    expect(mapSdkMessage(M({ type: 'user', parent_tool_use_id: null, isSynthetic: true, message: msg }))).toEqual(stop);
    expect(mapSdkMessage(M({ type: 'user', parent_tool_use_id: null, isMeta: true, message: msg }))).toEqual(stop);
    // Unflagged text is not harness-injected; a subagent copy and a replay never show.
    expect(mapSdkMessage(M({ type: 'user', parent_tool_use_id: null, message: msg }))).toEqual([]);
    expect(mapSdkMessage(M({ type: 'user', parent_tool_use_id: 'agent', isSynthetic: true, message: msg }))).toEqual([]);
    expect(mapSdkMessage(M({ type: 'user', parent_tool_use_id: null, isSynthetic: true, isReplay: true, message: msg }))).toEqual([]);
    expect(mapSdkMessage(M({ type: 'user', parent_tool_use_id: null, isSynthetic: true, origin: { kind: 'peer', from: 'a1' }, message: { role: 'user', content: 'Another Claude session sent a message: hi' } }))).toMatchObject([{ kind: 'system', source: 'peer', label: '다른 세션의 메시지' }]);
    expect(mapSdkMessage(M({ type: 'user', parent_tool_use_id: null, origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification><status>failed</status><summary>빌드</summary></task-notification>' } }))).toEqual([{ kind: 'system', source: 'task', label: '백그라운드 작업 실패', text: '빌드' }]);
    expect(mapSdkMessage(M({ type: 'user', parent_tool_use_id: null, isSynthetic: true, message: { role: 'user', content: 'Base directory for this skill: /x' } }))).toEqual([]);
  });

  it('init, text deltas (top-level only), tool calls, tool results, rate limit, compact, result', () => {
    expect(mapSdkMessage(M({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5', cwd: '/private/var/w' }))).toEqual([{ kind: 'init', sessionId: 's', model: 'claude-opus-5-5', cwd: '/private/var/w' }]);
    expect(mapSdkMessage(M({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } }))).toEqual([{ kind: 'delta', text: 'ok' }]);
    expect(mapSdkMessage(M({ type: 'stream_event', parent_tool_use_id: 'agent', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } } }))).toEqual([]);
    expect(mapSdkMessage(M({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } }))).toEqual([]);
    expect(mapSdkMessage(M({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } }))).toEqual([{ kind: 'tool_call', toolUseId: 'tu1', name: 'Bash', input: { command: 'ls' } }]);
    expect(mapSdkMessage(M({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'a.txt' }], is_error: false }] } }))).toEqual([{ kind: 'tool_result', toolUseId: 'tu1', content: 'a.txt', isError: false }]);
    expect(mapSdkMessage(M({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', unifiedWindows: { five_hour: { utilization: 0.13, resetsAt: 1790773200 }, seven_day: { utilization: 0.9, resetsAt: 1790931600 } } } }))).toEqual([
      { kind: 'rate_limit', info: { status: 'allowed_warning', fiveHour: { usedPct: 13, resetsAt: '2026-09-30T13:00:00.000Z' }, weekly: { usedPct: 90, resetsAt: '2026-10-02T09:00:00.000Z' } } },
    ]);
    expect(mapSdkMessage(M({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }))).toEqual([{ kind: 'rate_limit', info: { status: 'rejected', fiveHour: null, weekly: null } }]);
    expect(mapSdkMessage(M({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 1 } }))).toEqual([{ kind: 'compact' }]);
    expect(mapSdkMessage(M({ type: 'system', subtype: 'status', status: 'requesting' }))).toEqual([]);
  });

  it('result: success, API error inside success, and error subtype', () => {
    const usage = { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 10, cache_creation_input_tokens: 20 };
    expect(mapSdkMessage(M({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage, session_id: 's', terminal_reason: 'completed' }))).toEqual([
      { kind: 'result', sessionId: 's', ok: true, text: 'ok', usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 10, cacheCreationTokens: 20 }, errorText: null, stderr: null, errorKind: null, terminalReason: 'completed' },
    ]);
    expect(mapSdkMessage(M({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401', usage, session_id: 's' }))).toMatchObject([{ kind: 'result', ok: false, text: '', errorText: 'Failed to authenticate. API Error: 401' }]);
    expect(mapSdkMessage(M({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many'], usage, session_id: 's' }))).toMatchObject([{ kind: 'result', ok: false, errorText: 'error_max_turns: too many' }]);
  });
});

describe('ClaudeEngine.runTurn', () => {
  it('streams mapped events, attaches the assistant error kind to the result, and passes options to queryFn', async () => {
    let captured: { prompt: AsyncIterable<SDKUserMessage>; options?: Record<string, unknown> } | null = null;
    const queryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Record<string, unknown> }) => {
      captured = params;
      return (async function* () {
        yield M({ type: 'system', subtype: 'init', session_id: 's9', model: 'claude-opus-5-5' });
        yield M({ type: 'assistant', parent_tool_use_id: null, error: 'rate_limit', message: { content: [] } });
        yield M({ type: 'result', subtype: 'success', is_error: true, result: 'limit hit', usage: {}, session_id: 's9' });
      })();
    };
    const eng = new ClaudeEngine({ queryFn: queryFn as never, home: '/h', accounts: testRegistry('/h'), baseEnv: { PATH: '/bin' } });
    const events: EngineEvent[] = [];
    for await (const e of eng.runTurn(req({ prompt: 'p', account: 'a' }))) events.push(e);
    expect(events[0]).toEqual({ kind: 'init', sessionId: 's9', model: 'claude-opus-5-5' });
    expect(events[1]).toMatchObject({ kind: 'result', ok: false, errorKind: 'rate_limit', errorText: 'limit hit', usage: { inputTokens: 0 } });
    // Streaming-input mode always (background work needs the process to outlive the result).
    expect(((await first(captured!.prompt)) as SDKUserMessage).message.content).toBe('p');
    expect(captured!.options?.env).toEqual({ PATH: '/bin' });
  });

  it('keeps CLI stderr out of errorText (classifier input) and caps it at ~2 KB', async () => {
    const queryFn = (p: { options?: { stderr?: (s: string) => void } }) => (async function* () {
      p.options?.stderr?.('x'.repeat(5000) + ' API Error: 429 rate limit');
      yield M({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', cwd: '/w' });
      throw new Error('Claude Code process exited with code 1');
    })();
    const eng = new ClaudeEngine({ queryFn: queryFn as never, home: '/h', accounts: testRegistry('/h'), baseEnv: {} });
    const events: EngineEvent[] = [];
    for await (const e of eng.runTurn(req())) events.push(e);
    const r = events.at(-1) as Extract<EngineEvent, { kind: 'result' }>;
    expect(r.errorText).toBe('Claude Code process exited with code 1');
    expect(r.stderr?.length).toBeLessThanOrEqual(2048);
    expect(r.stderr).toContain('429');
  });

  it('does not call query() when the turn was aborted before it started', async () => {
    let called = false;
    const queryFn = () => { called = true; return (async function* () { /* nothing */ })(); };
    const ac = new AbortController();
    ac.abort();
    const eng = new ClaudeEngine({ queryFn: queryFn as never, home: '/h', accounts: testRegistry('/h'), baseEnv: {} });
    const events: EngineEvent[] = [];
    for await (const e of eng.runTurn(req({ signal: ac.signal }))) events.push(e);
    expect(called).toBe(false);
    expect(events).toMatchObject([{ kind: 'result', ok: false, terminalReason: 'aborted' }]);
  });

  it('turns a thrown error without a result into a failed result', async () => {
    const queryFn = () => (async function* () { yield M({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }); throw new Error('process exited'); })();
    const eng = new ClaudeEngine({ queryFn: queryFn as never, home: '/h', accounts: testRegistry('/h'), baseEnv: {} });
    const events: EngineEvent[] = [];
    for await (const e of eng.runTurn(req())) events.push(e);
    expect(events.at(-1)).toMatchObject({ kind: 'result', ok: false, sessionId: 's1', errorText: expect.stringContaining('process exited') });
  });
});

const img = { id: 'i1', name: 'a.png', mediaType: 'image/png', size: 3, path: '/att/i1-a.png', isImage: true, createdAtMs: 0 };
const doc = { id: 'd1', name: 'n.md', mediaType: 'application/octet-stream', size: 1, path: '/att/d1-n.md', isImage: false, createdAtMs: 0 };

describe('ClaudeEngine.runTurn — context size', () => {
  it('the result carries the main conversation\'s last call prompt as context (subagent calls ignored) and the SDK context window', async () => {
    const u = (input: number, read: number, write: number) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 5 });
    const queryFn = () => (async function* () {
      yield M({ type: 'assistant', parent_tool_use_id: null, message: { content: [], usage: u(1, 100, 50) } });
      yield M({ type: 'assistant', parent_tool_use_id: null, message: { content: [], usage: u(2, 150, 10) } });
      yield M({ type: 'assistant', parent_tool_use_id: 'agent', message: { content: [], usage: u(9, 9000, 9000) } });
      yield M({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', usage: u(3, 250, 60), modelUsage: { 'claude-opus-5-5': { contextWindow: 1_000_000 }, 'claude-haiku-4-5': { contextWindow: 200_000 } } });
    })();
    const eng = new ClaudeEngine({ queryFn: queryFn as never, home: '/h', accounts: testRegistry('/h'), baseEnv: {} });
    const events: EngineEvent[] = [];
    for await (const e of eng.runTurn(req())) events.push(e);
    const res = events.find((e) => e.kind === 'result');
    expect(res).toMatchObject({ usage: { inputTokens: 3, cacheReadTokens: 250, cacheCreationTokens: 60, context: { inputTokens: 2, cacheReadTokens: 150, cacheCreationTokens: 10 }, contextWindow: 1_000_000 } });
  });
});

async function first(p: string | AsyncIterable<SDKUserMessage>): Promise<SDKUserMessage | string> {
  if (typeof p === 'string') return p;
  for await (const m of p) return m;
  throw new Error('empty');
}

describe('buildPrompt (D7, D14)', () => {
  it('text only / files only stay a string with path lines; images become one user message with base64 blocks', async () => {
    const readFile = async (p: string) => Buffer.from(`bytes-of-${p}`);
    expect(await buildPrompt('hi', [], readFile)).toBe('hi');
    expect(await buildPrompt('hi', [doc], readFile)).toBe('hi\n\n첨부 파일: /att/d1-n.md');
    const m = await first(await buildPrompt('what is this?', [img, doc], readFile));
    expect(m).toEqual({
      type: 'user', session_id: '', parent_tool_use_id: null,
      message: { role: 'user', content: [
        { type: 'text', text: 'what is this?\n\n첨부 파일: /att/d1-n.md' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('bytes-of-/att/i1-a.png').toString('base64') } },
      ] },
    });
  });
});

describe('ClaudeEngine with attachments', () => {
  it('passes the streamed prompt to query and stops reading after the result', async () => {
    const seen: unknown[] = [];
    let pulled = 0;
    const queryFn = async function* (p: { prompt: string | AsyncIterable<SDKUserMessage> }) {
      seen.push(await first(p.prompt));
      yield M({ type: 'system', subtype: 'init', session_id: 's', model: 'm' });
      yield M({ type: 'result', subtype: 'success', is_error: false, result: 'a red pixel', session_id: 's', usage: {} });
      pulled++; // reached only if the engine keeps pulling after the result
      yield M({ type: 'system', subtype: 'init', session_id: 's', model: 'm' });
    };
    const engine = new ClaudeEngine({ queryFn, home: '/h', accounts: testRegistry('/h'), baseEnv: {}, readFile: async () => Buffer.from('png') });
    const out: EngineEvent[] = [];
    for await (const e of engine.runTurn(req({ prompt: 'what?', attachments: [img] }))) out.push(e);
    expect((seen[0] as SDKUserMessage).message.content).toHaveLength(2);
    expect(out.at(-1)).toMatchObject({ kind: 'result', ok: true, text: 'a red pixel' });
    expect(pulled).toBe(0);
  });

  it('without images the streamed message carries the plain text with path lines', async () => {
    const seen: unknown[] = [];
    const queryFn = async function* (p: { prompt: string | AsyncIterable<SDKUserMessage> }) {
      seen.push(((await first(p.prompt)) as SDKUserMessage).message.content);
      yield M({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', usage: {} });
    };
    const engine = new ClaudeEngine({ queryFn, home: '/h', accounts: testRegistry('/h'), baseEnv: {}, readFile: async () => { throw new Error('must not read'); } });
    for await (const _ of engine.runTurn(req({ prompt: 'x', attachments: [doc] }))) void _;
    expect(seen).toEqual(['x\n\n첨부 파일: /att/d1-n.md']);
  });

  it('a failed image read ends the turn as a failed result, not a throw', async () => {
    let called = false;
    const queryFn = async function* () { called = true; yield M({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', usage: {} }); };
    const engine = new ClaudeEngine({ queryFn, home: '/h', accounts: testRegistry('/h'), baseEnv: {}, readFile: async () => { throw new Error('ENOENT: gone'); } });
    const out: EngineEvent[] = [];
    for await (const e of engine.runTurn(req({ attachments: [img] }))) out.push(e);
    expect(called).toBe(false);
    expect(out).toEqual([expect.objectContaining({ kind: 'result', ok: false, errorText: expect.stringContaining('ENOENT') })]);
  });
});

const QUESTIONS = [{ question: 'Which color?', header: 'Color', options: [{ label: 'red', description: 'warm' }, { label: 'blue', description: 'cool', preview: 'x' }], multiSelect: false }];

describe('AskUserQuestion (D8)', () => {
  it('parseQuestions validates the SDK shape and drops previews; garbage → null', () => {
    expect(parseQuestions({ questions: QUESTIONS })).toEqual([{ question: 'Which color?', header: 'Color', options: [{ label: 'red', description: 'warm' }, { label: 'blue', description: 'cool' }], multiSelect: false }]);
    expect(parseQuestions({ questions: [] })).toBeNull();
    expect(parseQuestions({ questions: [{ question: 'q', options: [{ label: 'a' }] }] })).toBeNull();
    expect(parseQuestions('nope')).toBeNull();
  });

  it('parseQuestions rejects duplicate question texts and texts over 2000 chars (answers are keyed by text)', () => {
    const q = (question: string) => ({ question, header: 'H', options: [{ label: 'a' }, { label: 'b' }] });
    expect(parseQuestions({ questions: [q('Same?'), q('Same?')] })).toBeNull();
    expect(parseQuestions({ questions: [q('x'.repeat(2001))] })).toBeNull();
    expect(parseQuestions({ questions: [q('x'.repeat(2000)), q('Other?')] })).toHaveLength(2);
  });

  it('a malformed AskUserQuestion is denied without asking and reported through onQuestionMalformed (for the audit)', async () => {
    const asked: unknown[] = [];
    const malformed: unknown[] = [];
    const deps = { home: '/h', accounts: testRegistry('/h'), baseEnv: {}, abortController: new AbortController(), onStderr: () => {} };
    const ctx = { signal: new AbortController().signal, toolUseID: 'tu9', requestId: 'r9' } as never;
    const dup = { questions: [QUESTIONS[0], QUESTIONS[0]] };
    const o = buildOptions(req({ onQuestion: async (q) => { asked.push(q); return { x: 'y' }; }, onQuestionMalformed: async (input) => { malformed.push(input); } }), deps);
    expect(await o.canUseTool!('AskUserQuestion', dup, ctx)).toMatchObject({ behavior: 'deny' });
    expect(asked).toHaveLength(0);
    expect(malformed).toEqual([dup]);
  });

  it('canUseTool routes AskUserQuestion to onQuestion and returns the answers as updatedInput; no answer → deny', async () => {
    const asked: unknown[] = [];
    const deps = { home: '/h', accounts: testRegistry('/h'), baseEnv: {}, abortController: new AbortController(), onStderr: () => {} };
    const ctx = { signal: new AbortController().signal, toolUseID: 'tu9', requestId: 'r9' } as never;
    const o = buildOptions(req({ onQuestion: async (q) => { asked.push(q); return { 'Which color?': 'blue' }; } }), deps);
    expect(await o.canUseTool!('AskUserQuestion', { questions: QUESTIONS }, ctx)).toEqual({ behavior: 'allow', updatedInput: { questions: QUESTIONS, answers: { 'Which color?': 'blue' } } });
    expect(asked[0]).toMatchObject({ toolUseId: 'tu9', questions: [{ question: 'Which color?' }] });
    const none = buildOptions(req({ onQuestion: async () => null }), deps);
    expect(await none.canUseTool!('AskUserQuestion', { questions: QUESTIONS }, ctx)).toMatchObject({ behavior: 'deny' });
    const noHandler = buildOptions(req({}), deps);
    expect(await noHandler.canUseTool!('AskUserQuestion', { questions: QUESTIONS }, ctx)).toMatchObject({ behavior: 'deny' });
    // never confused with a permission prompt
    expect(await noHandler.canUseTool!('Bash', { command: 'ls' }, ctx)).toEqual({ behavior: 'allow' });
  });
});

describe('자동 승인 (autoApprove)', () => {
  const deps = { home: '/h', accounts: testRegistry('/h'), baseEnv: {}, abortController: new AbortController(), onStderr: () => {} };
  const ctx = { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r1' } as never;

  it('on: every tool is allowed at once without asking, each reported for the audit; AskUserQuestion still asks', async () => {
    const asked: string[] = [];
    const audited: string[] = [];
    const questions: unknown[] = [];
    const o = buildOptions(req({
      autoApprove: () => true,
      onPermission: async (p) => { asked.push(p.toolName); return 'deny'; },
      onAutoApproved: async (p) => { audited.push(`${p.toolName}:${p.toolUseId}`); },
      onQuestion: async (q) => { questions.push(q); return { 'Which color?': 'red' }; },
    }), deps);
    for (const t of ['Bash', 'Edit', 'Write', 'Read']) expect(await o.canUseTool!(t, { command: 'git -C /x log' }, ctx)).toEqual({ behavior: 'allow' });
    expect(asked).toEqual([]);
    expect(audited).toEqual(['Bash:tu1', 'Edit:tu1', 'Write:tu1', 'Read:tu1']);
    expect(await o.canUseTool!('AskUserQuestion', { questions: QUESTIONS }, ctx)).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which color?': 'red' } } });
    expect(questions).toHaveLength(1);
  });

  it('off (or toggled off mid-turn): back to the per-call card', async () => {
    let on = true;
    const asked: string[] = [];
    const o = buildOptions(req({ autoApprove: () => on, onPermission: async (p) => { asked.push(p.toolName); return 'deny'; } }), deps);
    expect(await o.canUseTool!('Bash', {}, ctx)).toEqual({ behavior: 'allow' });
    on = false;
    expect(await o.canUseTool!('Bash', {}, ctx)).toMatchObject({ behavior: 'deny' });
    expect(asked).toEqual(['Bash']);
  });
});

describe('permission modes and the plan card (ExitPlanMode)', () => {
  const deps = { home: '/h', accounts: testRegistry('/h'), baseEnv: {}, abortController: new AbortController(), onStderr: () => {} };
  const ctx = { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r1' } as never;

  it('passes the session mode to the SDK (absent = default)', () => {
    expect(buildOptions(req({}), deps).permissionMode).toBe('default');
    expect(buildOptions(req({ permissionMode: 'plan' }), deps).permissionMode).toBe('plan');
    expect(buildOptions(req({ permissionMode: 'acceptEdits' }), deps).permissionMode).toBe('acceptEdits');
  });

  it('승인 · 편집 자동 승인 → allow + acceptEdits, 승인 · 수동 → allow + default, 계속 계획 → deny (no interrupt)', async () => {
    let decision: 'session' | 'once' | 'deny' = 'session';
    const asked: string[] = [];
    const o = buildOptions(req({ permissionMode: 'plan', autoApprove: () => false, onPermission: async (p) => { asked.push(p.toolName); return decision; } }), deps);
    expect(await o.canUseTool!('ExitPlanMode', { plan: '1. a' }, ctx)).toEqual({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
    decision = 'once';
    expect(await o.canUseTool!('ExitPlanMode', { plan: '1. a' }, ctx)).toEqual({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] });
    decision = 'deny';
    expect(await o.canUseTool!('ExitPlanMode', { plan: '1. a' }, ctx)).toEqual({ behavior: 'deny', message: KEEP_PLANNING_MESSAGE, interrupt: false });
    expect(asked).toEqual(['ExitPlanMode', 'ExitPlanMode', 'ExitPlanMode']);
  });
});
