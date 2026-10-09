import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { CodexEngine, CodexEventMapper, MIN_CODEX_VERSION, codexArgs, resolveCodexBin, type ChildLike, type CodexTurnRequest } from './CodexEngine';
import type { EngineEvent } from './Engine';

// Observed 2026-09-30 (codex-cli 0.146.1), thread id redacted. Run 1: gpt-6-sol rejected (old CLI). Run 2: resume succeeded.
const RUN1 = [
  '{"type":"thread.started","thread_id":"01a0f2d3-0000-7c92-aeea-000000000001"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"`[features].codex_hooks` is deprecated. Use `[features].hooks` instead."}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"error","message":"Model metadata for `gpt-6-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'gpt-6-sol\' model is not supported when using Codex with a ChatGPT account.\\"}}"}',
  '{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'gpt-6-sol\' model is not supported when using Codex with a ChatGPT account.\\"}}"}}',
];
const RUN2 = [
  '{"type":"thread.started","thread_id":"01a0f2d3-0000-7c92-aeea-000000000001"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"`[features].codex_hooks` is deprecated."}}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":26711,"cached_input_tokens":11264,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
];

function mapAll(lines: string[], resume: string | null = null): EngineEvent[] {
  const m = new CodexEventMapper('gpt-6-sol', resume);
  return lines.flatMap((l) => m.map(JSON.parse(l)));
}

describe('codexArgs', () => {
  it('new thread: exec -C cwd, images before flags, sandbox/approval overrides, stdin prompt', () => {
    expect(codexArgs({ cwd: '/w', resumeThreadId: null, model: 'gpt-6-sol', sandbox: 'read-only', imagePaths: ['/a.png'] })).toEqual([
      'exec', '-C', '/w', '-i', '/a.png', '--json', '--skip-git-repo-check', '-m', 'gpt-6.1-sol',
      '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', '-',
    ]);
  });

  it('workspace-write: network on (sandbox_workspace_write.network_access=true) next to sandbox_mode, both forms; never danger-full-access', () => {
    for (const resumeThreadId of [null, 'tid']) {
      const a = codexArgs({ cwd: '/w', resumeThreadId, model: 'gpt-6-sol', sandbox: 'workspace-write' });
      const i = a.indexOf('sandbox_mode="workspace-write"');
      expect(i).toBeGreaterThan(0);
      expect(a).toContain('sandbox_workspace_write.network_access=true');
      expect(a).not.toContain('sandbox_workspace_write.network_access=false');
      expect(a.join(' ')).not.toContain('danger');
    }
    // read-only has no network setting to give (the table only applies to workspace-write).
    expect(codexArgs({ cwd: '/w', resumeThreadId: null, model: 'gpt-6-sol', sandbox: 'read-only' }).join(' ')).not.toContain('network_access');
  });

  it('effort: -c model_reasoning_effort="<level>" on both forms; absent = no override', () => {
    const fresh = codexArgs({ cwd: '/w', resumeThreadId: null, model: 'gpt-6-sol', sandbox: 'read-only', effort: 'xhigh' });
    expect(fresh.slice(-3)).toEqual(['-c', 'model_reasoning_effort="xhigh"', '-']);
    const resumed = codexArgs({ cwd: '/w', resumeThreadId: 'tid', model: 'gpt-6-astra', sandbox: 'read-only', effort: 'low' });
    expect(resumed).toContain('model_reasoning_effort="low"');
    expect(codexArgs({ cwd: '/w', resumeThreadId: null, model: 'gpt-6-sol', sandbox: 'read-only' }).join(' ')).not.toContain('model_reasoning_effort');
  });

  it('resume: exec resume <id>, no -C, same overrides', () => {
    const a = codexArgs({ cwd: '/w', resumeThreadId: 'tid', model: 'gpt-6-astra', sandbox: 'workspace-write' });
    expect(a.slice(0, 3)).toEqual(['exec', 'resume', 'tid']);
    expect(a).not.toContain('-C');
    expect(a).toContain('sandbox_mode="workspace-write"');
    expect(a.at(-1)).toBe('-');
    expect(a.join(' ')).not.toContain('danger');
  });
});

describe('CodexEventMapper', () => {
  it('run 1: init from thread.started, non-config-noise warnings as notices, turn.failed → failed result with the API error', () => {
    const ev = mapAll(RUN1);
    expect(ev[0]).toEqual({ kind: 'init', sessionId: '01a0f2d3-0000-7c92-aeea-000000000001', model: 'gpt-6-sol' });
    // item_0 ("is deprecated") is config noise (PF16) → logged, not emitted; item_1 (model metadata) is a real notice.
    const notices = ev.filter((e) => e.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'notice', message: expect.stringContaining('Model metadata') });
    const r = ev.at(-1);
    expect(r).toMatchObject({ kind: 'result', ok: false, sessionId: '01a0f2d3-0000-7c92-aeea-000000000001' });
    expect(r && r.kind === 'result' ? r.errorText : '').toContain("The 'gpt-6-sol' model is not supported");
  });

  it('PF16: config-noise warnings (deprecated / unrecognized configuration setting) are logged, not emitted as notices', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ev = mapAll([
        '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"`[features].codex_hooks` is deprecated. Use `[features].hooks` instead."}}',
        '{"type":"item.completed","item":{"id":"item_1","type":"error","message":"unrecognized configuration setting `foo.bar`"}}',
        '{"type":"item.completed","item":{"id":"item_2","type":"error","message":"Model metadata for `gpt-6-sol` not found."}}',
      ]);
      expect(ev).toEqual([{ kind: 'notice', message: 'Model metadata for `gpt-6-sol` not found.' }]);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('run 2: agent_message → delta, turn.completed → ok result with usage split like Anthropic usage', () => {
    const ev = mapAll(RUN2, '01a0f2d3-0000-7c92-aeea-000000000001');
    expect(ev.find((e) => e.kind === 'delta')).toEqual({ kind: 'delta', text: 'ok' });
    expect(ev.at(-1)).toEqual({
      kind: 'result', sessionId: '01a0f2d3-0000-7c92-aeea-000000000001', ok: true, text: 'ok',
      usage: { inputTokens: 15447, outputTokens: 5, cacheReadTokens: 11264, cacheCreationTokens: 0 },
      errorText: null, stderr: null, errorKind: null, terminalReason: 'completed',
    });
  });

  it('command_execution: started → tool_call once, completed → tool_result with exit code; two messages join with a blank line', () => {
    const ev = mapAll([
      '{"type":"item.started","item":{"id":"item_3","type":"command_execution","command":"ls -la","status":"in_progress"}}',
      '{"type":"item.updated","item":{"id":"item_3","type":"command_execution","command":"ls -la","status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"ls -la","aggregated_output":"a.txt\\n","exit_code":1,"status":"failed"}}',
      '{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"id":"item_5","type":"agent_message","text":"second"}}',
      '{"type":"item.completed","item":{"id":"item_6","type":"reasoning","text":"hidden"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"cache_write_input_tokens":2,"output_tokens":3}}',
    ]);
    expect(ev.filter((e) => e.kind === 'tool_call')).toEqual([{ kind: 'tool_call', toolUseId: 'item_3', name: 'Bash', input: { command: 'ls -la' } }]);
    expect(ev.find((e) => e.kind === 'tool_result')).toEqual({ kind: 'tool_result', toolUseId: 'item_3', content: 'a.txt\n', isError: true });
    expect(ev.filter((e) => e.kind === 'delta').map((e) => (e.kind === 'delta' ? e.text : ''))).toEqual(['first', '\n\nsecond']);
    expect(ev.at(-1)).toMatchObject({ kind: 'result', ok: true, text: 'first\n\nsecond', usage: { inputTokens: 10, cacheCreationTokens: 2 } });
  });

  it('top-level error without turn.failed is kept for the synthesized failure', () => {
    const m = new CodexEventMapper('gpt-6-sol', null);
    m.map({ type: 'error', message: 'boom' });
    expect(m.sawResult).toBe(false);
    expect(m.result(false, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, null).errorText).toBe('boom');
  });
});

function fakeChild(lines: string[], exitCode = 0, stderr = ''): { child: ChildLike; stdin: () => string; killed: string[] } {
  const em = new EventEmitter();
  const stdout = Readable.from(lines.map((l) => l + '\n'));
  let input = '';
  const stdin = new Writable({ write(chunk, _enc, cb) { input += String(chunk); cb(); } });
  const killed: string[] = [];
  stdout.on('end', () => setTimeout(() => em.emit('exit', exitCode, null), 0));
  const child = {
    stdout, stderr: Readable.from(stderr ? [stderr] : []), stdin,
    once: (ev: 'exit' | 'error', cb: (...args: unknown[]) => void) => em.once(ev, cb),
    kill: (sig?: NodeJS.Signals | number) => { killed.push(String(sig)); return true; },
  } as unknown as ChildLike;
  return { child, stdin: () => input, killed };
}

function req(over: Partial<CodexTurnRequest> = {}): CodexTurnRequest {
  return { cwd: '/w', resumeThreadId: null, model: 'gpt-6-sol', sandbox: 'read-only', prompt: 'Reply with exactly: ok', signal: new AbortController().signal, ...over };
}

async function drain(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> { const out: EngineEvent[] = []; for await (const e of it) out.push(e); return out; }

describe('CodexEngine', () => {
  it('spawns the binary with codexArgs and a token-free env, writes the prompt to stdin, yields mapped events', async () => {
    const calls: { bin: string; args: string[]; cwd: string; env: Record<string, string | undefined> }[] = [];
    const fake = fakeChild(RUN2);
    const engine = new CodexEngine('/opt/codex', { baseEnv: { PATH: '/bin', OPENAI_API_KEY: 'k', CODEX_HOME: '/h/.codex' }, spawnFn: (bin, args, o) => { calls.push({ bin, args, cwd: o.cwd, env: o.env }); return fake.child; } });
    const ev = await drain(engine.runTurn(req()));
    expect(calls[0]).toMatchObject({ bin: '/opt/codex', cwd: '/w', env: { PATH: '/bin', CODEX_HOME: '/h/.codex' } });
    expect(calls[0]?.env.OPENAI_API_KEY).toBeUndefined();
    expect(calls[0]?.args).toEqual(codexArgs(req()));
    expect(fake.stdin()).toBe('Reply with exactly: ok');
    expect(ev.at(-1)).toMatchObject({ kind: 'result', ok: true, text: 'ok' });
  });

  it('a non-zero exit without a turn result becomes a failed result carrying the stderr tail', async () => {
    const fake = fakeChild(['{"type":"thread.started","thread_id":"t"}'], 2, 'ERROR something broke');
    const engine = new CodexEngine('/opt/codex', { baseEnv: {}, spawnFn: () => fake.child });
    const ev = await drain(engine.runTurn(req()));
    expect(ev.at(-1)).toMatchObject({ kind: 'result', ok: false, sessionId: 't', errorText: 'codex 종료 코드 2', stderr: 'ERROR something broke' });
  });

  it('a spawn error (ENOENT) becomes a failed result carrying the error message, not an unknown exit code', async () => {
    const em = new EventEmitter();
    const stdout = Readable.from([]);
    stdout.on('end', () => setTimeout(() => em.emit('error', Object.assign(new Error('spawn /opt/codex ENOENT'), { code: 'ENOENT' })), 0));
    const child = {
      stdout, stderr: Readable.from([]), stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
      once: (ev: 'exit' | 'error', cb: (...args: unknown[]) => void) => em.once(ev, cb),
      kill: () => true,
    } as unknown as ChildLike;
    const engine = new CodexEngine('/opt/codex', { baseEnv: {}, spawnFn: () => child });
    const ev = await drain(engine.runTurn(req()));
    expect(ev.at(-1)).toMatchObject({ kind: 'result', ok: false, errorText: 'codex 실행 실패: spawn /opt/codex ENOENT' });
  });

  it('abort kills the child and ends with 중단됨; an already-aborted signal never spawns', async () => {
    const ac = new AbortController();
    const fake = fakeChild(['{"type":"thread.started","thread_id":"t"}', '{"type":"turn.started"}'], null as unknown as number);
    let spawned = 0;
    const engine = new CodexEngine('/opt/codex', { baseEnv: {}, spawnFn: () => { spawned++; ac.abort(); return fake.child; } });
    const ev = await drain(engine.runTurn(req({ signal: ac.signal })));
    expect(fake.killed[0]).toBe('SIGTERM');
    expect(ev.at(-1)).toMatchObject({ kind: 'result', ok: false, errorText: '중단됨', terminalReason: 'aborted' });
    const pre = new AbortController(); pre.abort();
    const ev2 = await drain(engine.runTurn(req({ signal: pre.signal })));
    expect(spawned).toBe(1);
    expect(ev2).toEqual([expect.objectContaining({ kind: 'result', ok: false, errorText: '중단됨' })]);
  });

  it('review finding 2: a flag-shaped resumeThreadId is rejected before spawning (no argv injection)', async () => {
    let spawned = 0;
    const engine = new CodexEngine('/opt/codex', { baseEnv: {}, spawnFn: () => { spawned++; return fakeChild([]).child; } });
    const ev = await drain(engine.runTurn(req({ resumeThreadId: '--dangerously-bypass-approvals-and-sandbox' })));
    expect(spawned).toBe(0);
    expect(ev).toEqual([expect.objectContaining({ kind: 'result', ok: false, errorText: expect.stringContaining('세션 ID') })]);
  });

  it('review finding 2: a well-formed UUID resumeThreadId still spawns normally', async () => {
    const fake = fakeChild(RUN2);
    const engine = new CodexEngine('/opt/codex', { baseEnv: {}, spawnFn: () => fake.child });
    const ev = await drain(engine.runTurn(req({ resumeThreadId: '01a0f2d3-0000-7c92-aeea-000000000001' })));
    expect(ev.at(-1)).toMatchObject({ kind: 'result', ok: true, sessionId: '01a0f2d3-0000-7c92-aeea-000000000001' });
  });

  it('review finding 3: stopping iteration early (consumer break/throw) still kills the still-running child', async () => {
    const fake = fakeChild(['{"type":"thread.started","thread_id":"t"}', '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"hi"}}']);
    const engine = new CodexEngine('/opt/codex', { baseEnv: {}, spawnFn: () => fake.child });
    for await (const _ev of engine.runTurn(req())) {
      break; // abandon iteration before the child's own exit event fires
    }
    expect(fake.killed).toContain('SIGTERM');
  });

  it('thread writer lock: "already has an active writer" (thread open in the ChatGPT desktop app) → Korean message + errorKind, no raw stderr dump', async () => {
    // Observed with codex-cli 0.159.2: resume of a thread the ChatGPT.app `codex app-server` holds a writer lock on.
    const tid = '01900000-0000-7000-8000-000000000001';
    const stderr = `2026-01-01T00:00:00.000000Z ERROR codex_core::session::session: failed to initialize thread persistence: thread-store conflict: thread ${tid} already has an active writer\nError: thread/resume: thread/resume failed: thread ${tid} already has an active writer (code -32600)\n`;
    const fake = fakeChild([], 1, stderr);
    const engine = new CodexEngine('/opt/codex', { baseEnv: {}, spawnFn: () => fake.child });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ev = await drain(engine.runTurn(req({ resumeThreadId: tid })));
      const r = ev.at(-1);
      expect(r).toMatchObject({ kind: 'result', ok: false, sessionId: tid, errorKind: 'thread_locked', stderr: null, terminalReason: null });
      const text = r && r.kind === 'result' ? r.errorText ?? '' : '';
      expect(text).toContain('ChatGPT 데스크톱 앱');
      expect(text).not.toContain('codex 종료 코드');
      expect(text).not.toContain('중단');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('thread writer lock: stderr that arrives after the child "exit" event is still classified (exit → stderr chunk → end)', async () => {
    const tid = '01900000-0000-7000-8000-000000000001';
    const em = new EventEmitter();
    const stderr = new PassThrough();
    const stdout = new PassThrough();
    const child = {
      stdout, stderr, stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
      once: (ev: 'exit' | 'error', cb: (...args: unknown[]) => void) => em.once(ev, cb),
      kill: () => true,
    } as unknown as ChildLike;
    const engine = new CodexEngine('/opt/codex', { baseEnv: {}, spawnFn: () => child });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      setTimeout(() => {
        stdout.end();
        em.emit('exit', 1, null);
        setTimeout(() => { stderr.write(`Error: thread ${tid} already has an active writer (code -32600)\n`); stderr.end(); }, 20);
      }, 0);
      const ev = await drain(engine.runTurn(req({ resumeThreadId: tid })));
      const r = ev.at(-1);
      expect(r).toMatchObject({ kind: 'result', ok: false, errorKind: 'thread_locked' });
      expect(r && r.kind === 'result' ? r.errorText ?? '' : '').toContain('ChatGPT 데스크톱 앱');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('early-stop cleanup is bounded: a child that survives SIGKILL is logged, not waited on forever', async () => {
    const em = new EventEmitter();
    const killed: string[] = [];
    let sent = false;
    const child = {
      pid: 4242,
      stdout: new Readable({ read() { if (!sent) { sent = true; this.push('{"type":"thread.started","thread_id":"t"}\n'); } } }),
      stderr: Readable.from([]), stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
      once: (ev: 'exit' | 'error', cb: (...args: unknown[]) => void) => em.once(ev, cb),
      kill: (sig?: NodeJS.Signals | number) => { killed.push(String(sig)); return true; },
    } as unknown as ChildLike;
    const engine = new CodexEngine('/opt/codex', { baseEnv: {}, spawnFn: () => child, killGraceMs: 20 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const t0 = Date.now();
      for await (const _ev of engine.runTurn(req())) {
        break;
      }
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(killed).toEqual(['SIGTERM', 'SIGKILL']);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('codex pid 4242 did not exit after SIGKILL'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('stopping iteration early waits for the child to exit, escalating SIGTERM → SIGKILL, so the next turn cannot race its thread lock', async () => {
    const em = new EventEmitter();
    const killed: string[] = [];
    let sent = false;
    const child = {
      // A child that keeps running (stdout never ends) and ignores SIGTERM; only SIGKILL ends it.
      stdout: new Readable({ read() { if (!sent) { sent = true; this.push('{"type":"thread.started","thread_id":"t"}\n'); } } }),
      stderr: Readable.from([]), stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
      once: (ev: 'exit' | 'error', cb: (...args: unknown[]) => void) => em.once(ev, cb),
      kill: (sig?: NodeJS.Signals | number) => { killed.push(String(sig)); if (sig === 'SIGKILL') setTimeout(() => em.emit('exit', null), 0); return true; },
    } as unknown as ChildLike;
    const engine = new CodexEngine('/opt/codex', { baseEnv: {}, spawnFn: () => child, killGraceMs: 20 });
    for await (const _ev of engine.runTurn(req())) {
      break;
    }
    // The generator's return() only resolved after the child really exited.
    expect(killed).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('resolveCodexBin (D11 + PF14 version gate)', () => {
  it('DECK_CODEX_BIN wins when executable, then PATH, then ~/.local/bin, then the newest nvm node (version gate satisfied by all)', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-codex-home-'));
    const mk = async (p: string) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, '#!/bin/sh\n', { mode: 0o755 }); };
    const old = path.join(home, '.nvm/versions/node/v22.1.0/bin/codex');
    const newer = path.join(home, '.nvm/versions/node/v24.14.1/bin/codex');
    await mk(old); await mk(newer);
    const okVersion = () => 'codex-cli 0.159.2';
    expect(resolveCodexBin({ PATH: '/nonexistent' }, home, undefined, okVersion)).toBe(newer);
    const local = path.join(home, '.local/bin/codex'); await mk(local);
    expect(resolveCodexBin({ PATH: '/nonexistent' }, home, undefined, okVersion)).toBe(local);
    const onPath = path.join(home, 'bin/codex'); await mk(onPath);
    expect(resolveCodexBin({ PATH: `/nonexistent:${path.join(home, 'bin')}` }, home, undefined, okVersion)).toBe(onPath);
    expect(resolveCodexBin({ PATH: '', DECK_CODEX_BIN: old }, home, undefined, okVersion)).toBe(old);
    expect(resolveCodexBin({ PATH: '', DECK_CODEX_BIN: '/nope' }, home, undefined, okVersion)).toBeNull();
    expect(resolveCodexBin({ PATH: '' }, path.join(home, 'empty'), undefined, okVersion)).toBeNull();
    await fs.rm(home, { recursive: true, force: true });
  });

  it('PF14: an old-version PATH entry is skipped in favor of ~/.local/bin', () => {
    const pathCodex = '/usr/local/bin/codex';
    const localCodex = '/home/x/.local/bin/codex';
    const existsFn = (p: string) => p === pathCodex || p === localCodex;
    const versionFn = (bin: string) => (bin === pathCodex ? 'codex-cli 0.146.1' : 'codex-cli 0.159.2');
    expect(resolveCodexBin({ PATH: '/usr/local/bin' }, '/home/x', existsFn, versionFn)).toBe(localCodex);
  });

  it('PF14: DECK_CODEX_BIN override is honored even when its version is old', () => {
    const existsFn = (p: string) => p === '/old/codex';
    const versionFn = () => 'codex-cli 0.100.0';
    expect(resolveCodexBin({ PATH: '', DECK_CODEX_BIN: '/old/codex' }, '/home/x', existsFn, versionFn)).toBe('/old/codex');
  });

  it('PF14: returns null when nothing meets MIN_CODEX_VERSION', () => {
    const existsFn = (p: string) => p === '/usr/local/bin/codex';
    const versionFn = () => 'codex-cli 0.146.1';
    expect(resolveCodexBin({ PATH: '/usr/local/bin' }, '/home/x', existsFn, versionFn)).toBeNull();
  });

  it('PF14: MIN_CODEX_VERSION is 0.159.0', () => {
    expect(MIN_CODEX_VERSION).toBe('0.159.0');
  });
});
