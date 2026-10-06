import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { geminiEnv } from '../../shared/accounts';
import type { EngineEvent, EngineResult } from './Engine';
import { GeminiEngine, GeminiEventMapper, geminiArgs, geminiLoggedIn, resolveGeminiBin, type GeminiTurnRequest } from './GeminiEngine';

const SID = '4f1c2b9e-1111-4222-8333-944455556666';

// gemini-cli 0.62 `-o stream-json` shapes (bundle source; see docs/gemini-spike.md).
const OK_RUN = [
  { type: 'init', timestamp: 't', session_id: SID, model: 'gemini-2.5-pro' },
  { type: 'message', timestamp: 't', role: 'user', content: 'hi' },
  { type: 'message', timestamp: 't', role: 'assistant', content: 'Hel', delta: true },
  { type: 'tool_use', timestamp: 't', tool_name: 'read_file', tool_id: 'read_file-1', parameters: { file_path: 'a.txt' } },
  { type: 'tool_result', timestamp: 't', tool_id: 'read_file-1', status: 'success', output: 'x' },
  { type: 'tool_use', timestamp: 't', tool_name: 'run_shell_command', tool_id: 'sh-2', parameters: { command: 'ls' } },
  { type: 'tool_result', timestamp: 't', tool_id: 'sh-2', status: 'error', error: { type: 'denied', message: 'Tool execution denied' } },
  { type: 'error', timestamp: 't', severity: 'warning', message: 'Loop detected' },
  { type: 'message', timestamp: 't', role: 'assistant', content: 'lo', delta: true },
  { type: 'result', timestamp: 't', status: 'success', stats: { total_tokens: 130, input_tokens: 100, output_tokens: 30, cached: 40, input: 60, duration_ms: 5, tool_calls: 2 } },
];
const QUOTA_RUN = [
  { type: 'init', timestamp: 't', session_id: SID, model: 'gemini-2.5-pro' },
  { type: 'result', timestamp: 't', status: 'error', error: { type: 'TerminalQuotaError', message: 'You have exhausted your daily quota on this model.' }, stats: {} },
];

const mapAll = (evs: unknown[], resume: string | null = null) => {
  const m = new GeminiEventMapper('pro', resume);
  return evs.flatMap((e) => m.map(e));
};

describe('geminiArgs', () => {
  it('stream-json, skip-trust, alias model, plan for read-only, seatbelt when asked, no prompt in argv', () => {
    expect(geminiArgs({ resumeSessionId: null, model: 'gemini-pro', sandbox: 'read-only' }, true)).toEqual(['-o', 'stream-json', '--skip-trust', '-m', 'pro', '--approval-mode', 'plan', '-s']);
  });
  it('workspace-write → auto_edit (never yolo); resume adds --resume <id>; no -s without seatbelt', () => {
    const a = geminiArgs({ resumeSessionId: SID, model: 'gemini-flash', sandbox: 'workspace-write' }, false);
    expect(a).toEqual(['-o', 'stream-json', '--skip-trust', '-m', 'flash', '--approval-mode', 'auto_edit', '--resume', SID]);
    expect(a.join(' ')).not.toMatch(/yolo|-y\b/);
  });
});

describe('GeminiEventMapper', () => {
  it('init, assistant deltas (user echo dropped), tool calls/results, warnings as notices, result with usage', () => {
    const ev = mapAll(OK_RUN);
    expect(ev[0]).toEqual({ kind: 'init', sessionId: SID, model: 'gemini-2.5-pro' });
    expect(ev.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text)).toEqual(['Hel', 'lo']);
    expect(ev.filter((e) => e.kind === 'tool_call')).toEqual([
      { kind: 'tool_call', toolUseId: 'read_file-1', name: 'read_file', input: { file_path: 'a.txt' } },
      { kind: 'tool_call', toolUseId: 'sh-2', name: 'run_shell_command', input: { command: 'ls' } },
    ]);
    expect(ev.filter((e) => e.kind === 'tool_result')).toEqual([
      { kind: 'tool_result', toolUseId: 'read_file-1', content: 'x', isError: false },
      { kind: 'tool_result', toolUseId: 'sh-2', content: 'Tool execution denied', isError: true },
    ]);
    expect(ev.find((e) => e.kind === 'notice')).toEqual({ kind: 'notice', message: 'Loop detected' });
    expect(ev.at(-1)).toMatchObject({ kind: 'result', ok: true, sessionId: SID, text: 'Hello', errorText: null, usage: { inputTokens: 60, outputTokens: 30, cacheReadTokens: 40, cacheCreationTokens: 0 } });
  });
  it('error result carries the CLI error message; no init → the resume id stays', () => {
    expect(mapAll(QUOTA_RUN).at(-1)).toMatchObject({ kind: 'result', ok: false, text: '', errorText: 'You have exhausted your daily quota on this model.' });
    const r = mapAll([{ type: 'error', severity: 'error', message: 'boom' }, { type: 'result', status: 'error', stats: {} }], SID).at(-1) as EngineResult;
    expect(r).toMatchObject({ ok: false, sessionId: SID, errorText: 'boom' });
  });
  it('ignores junk', () => {
    expect(mapAll([null, 'x', { type: 'init' }, { type: 'message', role: 'assistant' }, { type: 'later_event' }])).toEqual([]);
  });
});

describe('geminiEnv', () => {
  it('strips API keys, ADC/Vertex/base-URL and keychain overrides; pins GEMINI_CLI_HOME per account; forces OAuth', () => {
    const base = {
      PATH: '/bin', GEMINI_API_KEY: 'k1', GOOGLE_API_KEY: 'k2', GOOGLE_APPLICATION_CREDENTIALS: '/adc.json', GOOGLE_GENAI_USE_VERTEXAI: 'true',
      GOOGLE_GEMINI_BASE_URL: 'http://evil', GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'true', GEMINI_CLI_HOME: '/other', SEATBELT_PROFILE: 'permissive-open-yolo',
      ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GEMINI_SANDBOX: 'docker',
    };
    const env = geminiEnv('g2', base, '/h/.config/deck');
    expect(env).toEqual({ PATH: '/bin', GEMINI_CLI_HOME: '/h/.config/deck/gemini/g2', GOOGLE_GENAI_USE_GCA: 'true', SEATBELT_PROFILE: 'permissive-open' });
    expect(geminiEnv('g1', base, '/h/.config/deck').GEMINI_CLI_HOME).toBe('/h/.config/deck/gemini/g1');
    // DECK_CONFIG_DIR moves the Gemini accounts with the rest of deck's files.
    expect(geminiEnv('g1', base, '/elsewhere/deck').GEMINI_CLI_HOME).toBe('/elsewhere/deck/gemini/g1');
  });
});

describe('resolveGeminiBin / geminiLoggedIn', () => {
  it('DECK_GEMINI_BIN wins when executable; else PATH, then ~/.local/bin; null when none', () => {
    expect(resolveGeminiBin({ DECK_GEMINI_BIN: '/x/gemini', PATH: '/p' }, '/h', (p) => p === '/x/gemini')).toBe('/x/gemini');
    expect(resolveGeminiBin({ DECK_GEMINI_BIN: '/x/gemini', PATH: '/p' }, '/h', (p) => p === '/p/gemini')).toBeNull();
    expect(resolveGeminiBin({ PATH: '/a:/p' }, '/h', (p) => p === '/p/gemini')).toBe('/p/gemini');
    expect(resolveGeminiBin({ PATH: '/a' }, '/h', (p) => p === '/h/.local/bin/gemini')).toBe('/h/.local/bin/gemini');
    expect(resolveGeminiBin({ PATH: '/a' }, '/h', () => false)).toBeNull();
  });
  it('logged in = the OAuth file exists (existence check only)', () => {
    const asked: string[] = [];
    expect(geminiLoggedIn('g1', '/h/.config/deck', (p) => { asked.push(p); return true; })).toBe(true);
    expect(geminiLoggedIn('g2', '/h/.config/deck', () => false)).toBe(false);
    expect(asked).toEqual(['/h/.config/deck/gemini/g1/.gemini/oauth_creds.json']);
  });
});

/**
 * A fake `gemini` binary (node script): records argv, cwd, stdin and the env keys it got to `$FAKE_LOG`, then replays
 * `$FAKE_SCRIPT` (a JSON file: { lines, exitCode, hang }).
 */
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const script = JSON.parse(fs.readFileSync(process.env.FAKE_SCRIPT, 'utf8'));
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin, env: process.env }));
  if (script.stderr) process.stderr.write(script.stderr);
  // stderr first, then a beat, so the engine has the tail before the result line (separate pipes).
  setTimeout(() => {
    for (const l of script.lines) process.stdout.write(JSON.stringify(l) + '\\n');
    if (script.hang) setInterval(() => {}, 1000); else process.exitCode = script.exitCode || 0;
  }, script.stderr ? 100 : 0);
});
`;

describe('GeminiEngine with a fake gemini binary', () => {
  let dir: string;
  let bin: string;
  const req = (over: Partial<GeminiTurnRequest> = {}): GeminiTurnRequest => ({ account: 'g1', cwd: dir, resumeSessionId: null, model: 'gemini-pro', sandbox: 'read-only', prompt: '안녕\n/둘째 줄', signal: new AbortController().signal, ...over });
  const script = (s: { lines: unknown[]; exitCode?: number; hang?: boolean; stderr?: string }) => fs.writeFile(path.join(dir, 'script.json'), JSON.stringify(s));
  const engine = (extra: NodeJS.ProcessEnv = {}) => new GeminiEngine(bin, '/home/test/.config/deck', { seatbelt: false, baseEnv: { PATH: process.env.PATH, FAKE_SCRIPT: path.join(dir, 'script.json'), FAKE_LOG: path.join(dir, 'log.json'), ...extra } });
  const collect = async (it: AsyncIterable<EngineEvent>) => { const out: EngineEvent[] = []; for await (const e of it) out.push(e); return out; };
  const log = async () => JSON.parse(await fs.readFile(path.join(dir, 'log.json'), 'utf8')) as { argv: string[]; cwd: string; stdin: string; env: Record<string, string> };

  beforeAll(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-gemini-')));
    bin = path.join(dir, 'gemini');
    await fs.writeFile(bin, FAKE, { mode: 0o755 });
  });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('streams a turn: prompt on stdin only, account home + OAuth env, API keys gone', async () => {
    await script({ lines: OK_RUN });
    const ev = await collect(engine({ GEMINI_API_KEY: 'secret', GOOGLE_API_KEY: 'secret2' }).runTurn(req()));
    expect(ev[0]).toMatchObject({ kind: 'init', sessionId: SID });
    expect(ev.at(-1)).toMatchObject({ kind: 'result', ok: true, text: 'Hello' });
    const l = await log();
    expect(l.stdin).toBe('안녕\n/둘째 줄');
    expect(l.argv).toEqual(['-o', 'stream-json', '--skip-trust', '-m', 'pro', '--approval-mode', 'plan']);
    expect(l.argv.join(' ')).not.toContain('안녕');
    expect(l.cwd).toBe(dir);
    expect(l.env.GEMINI_CLI_HOME).toBe('/home/test/.config/deck/gemini/g1');
    expect(l.env.GOOGLE_GENAI_USE_GCA).toBe('true');
    expect(l.env.GEMINI_API_KEY).toBeUndefined();
    expect(l.env.GOOGLE_API_KEY).toBeUndefined();
  });

  it('resume passes --resume <id> on the account it is pinned to', async () => {
    await script({ lines: OK_RUN });
    await collect(engine().runTurn(req({ account: 'g2', resumeSessionId: SID, sandbox: 'workspace-write' })));
    const l = await log();
    expect(l.argv.slice(-4)).toEqual(['--approval-mode', 'auto_edit', '--resume', SID]);
    expect(l.env.GEMINI_CLI_HOME).toBe('/home/test/.config/deck/gemini/g2');
  });

  it('a flag-shaped resume id never reaches the binary', async () => {
    await fs.rm(path.join(dir, 'log.json'), { force: true });
    const ev = await collect(engine().runTurn(req({ resumeSessionId: '--yolo' })));
    expect(ev).toEqual([expect.objectContaining({ kind: 'result', ok: false, errorText: '잘못된 세션 ID 형식' })]);
    await expect(fs.access(path.join(dir, 'log.json'))).rejects.toThrow();
  });

  it('error result keeps the CLI message and the stderr tail; exit without result → exit code', async () => {
    await script({ lines: QUOTA_RUN, exitCode: 1, stderr: 'quota!' });
    const r = (await collect(engine().runTurn(req()))).at(-1) as EngineResult;
    expect(r).toMatchObject({ ok: false, errorText: 'You have exhausted your daily quota on this model.', stderr: 'quota!', sessionId: SID });
    await script({ lines: [], exitCode: 41 });
    expect((await collect(engine().runTurn(req()))).at(-1)).toMatchObject({ ok: false, errorText: 'gemini 종료 코드 41' });
  });

  it('abort kills a hanging child and reports 중단됨', async () => {
    await script({ lines: [OK_RUN[0]], hang: true });
    const ac = new AbortController();
    const it = engine().runTurn(req({ signal: ac.signal }));
    const out: EngineEvent[] = [];
    for await (const e of it) { out.push(e); if (e.kind === 'init') ac.abort(); }
    expect(out.at(-1)).toMatchObject({ kind: 'result', ok: false, errorText: '중단됨', terminalReason: 'aborted' });
  });

  it('a missing binary is a failed result, not a crash', async () => {
    const e = new GeminiEngine(path.join(dir, 'nope'), '/home/test/.config/deck', { seatbelt: false, baseEnv: {} });
    expect((await collect(e.runTurn(req()))).at(-1)).toMatchObject({ ok: false, errorText: expect.stringContaining('gemini 실행 실패') });
  });
});
