import { describe, expect, it } from 'vitest';
import { ClaudeEngine } from './ClaudeEngine';
import type { EngineEvent, LiveInput, TurnRequest } from './Engine';
import { fakeSdk, sdk } from './fakeSdk';
import { testRegistry } from '../../shared/accounts.testkit';

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return { account: 'c', cwd: '/w', resumeSessionId: null, model: 'opus', prompt: 'hi', signal: new AbortController().signal, onPermission: async () => 'once', ...over };
}

/** Pulls engine events one by one so the test can feed SDK messages between them. */
function reader(it: AsyncIterable<EngineEvent>) {
  const iter = it[Symbol.asyncIterator]();
  const seen: EngineEvent[] = [];
  return {
    seen,
    /** Next event (skipping nothing); `null` once the turn is over. */
    async next(): Promise<EngineEvent | null> {
      const r = await iter.next();
      if (r.done) return null;
      seen.push(r.value);
      return r.value;
    },
    /** Reads until an event of `kind` arrives; returns it. */
    async until<K extends EngineEvent['kind']>(kind: K): Promise<Extract<EngineEvent, { kind: K }>> {
      for (;;) {
        const e = await this.next();
        if (!e) throw new Error(`stream ended before ${kind}; saw ${seen.map((x) => x.kind).join(',')}`);
        if (e.kind === kind) return e as Extract<EngineEvent, { kind: K }>;
      }
    },
    async rest(): Promise<EngineEvent[]> {
      const out: EngineEvent[] = [];
      for (let e = await this.next(); e; e = await this.next()) out.push(e);
      return out;
    },
  };
}

const textOf = (m: { message: { content: unknown } }) => (typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content));

describe('ClaudeEngine: background tasks outlive the turn result', () => {
  it('without background tasks the input closes right after the result (one-shot as before)', async () => {
    const f = fakeSdk();
    f.push(sdk.init(), sdk.delta('ok'), sdk.result('ok'));
    const evs = await reader(new ClaudeEngine({ accounts: testRegistry(), queryFn: f.queryFn, readFile: async () => Buffer.from('') }).runTurn(req())).rest();
    expect(evs.map((e) => e.kind)).toEqual(['init', 'delta', 'result']);
    expect(f.inputs.map(textOf)).toEqual(['hi']);
    await new Promise((r) => setTimeout(r, 0));
    expect(f.state.inputClosed).toBe(true);
  });

  it('keeps the process open while a task is live and streams the continuation after it settles', async () => {
    const f = fakeSdk();
    const r = reader(new ClaudeEngine({ accounts: testRegistry(), queryFn: f.queryFn }).runTurn(req()));
    f.push(sdk.init(), sdk.bgLevel([{ id: 't1', desc: 'explore repo' }, { id: 'amb', desc: 'monitor', ambient: true }]), sdk.delta('started'), sdk.result('started'));
    expect(await r.until('background')).toMatchObject({ kind: 'background', tasks: ['explore repo'] });
    expect(await r.until('result')).toMatchObject({ ok: true, text: 'started' });
    await new Promise((res) => setTimeout(res, 5));
    expect(f.state.inputClosed).toBe(false);
    // Subagent progress while idle is not a continuation.
    f.push(sdk.subagentTool());
    // The task settles; the CLI injects its notification and runs another turn by itself.
    f.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('found it'), sdk.result('found it'));
    expect(await r.until('background')).toMatchObject({ kind: 'background', tasks: [] });
    const after: EngineEvent[] = [];
    for (let e = await r.next(); e && e.kind !== 'result'; e = await r.next()) after.push(e);
    // The CLI's task-notification user message is a system row (as in the transcript), not a user message.
    expect(after.map((e) => e.kind)).toEqual(['continue', 'system', 'delta']);
    expect(after[1]).toMatchObject({ kind: 'system', source: 'task' });
    expect(after[0]).toEqual({ kind: 'continue', cause: 'background' });
    expect(r.seen.at(-1)).toMatchObject({ kind: 'result', text: 'found it' });
    expect(await r.rest()).toEqual([]);
    await new Promise((res) => setTimeout(res, 0));
    expect(f.state.inputClosed).toBe(true);
    expect(r.seen.filter((e) => e.kind === 'continue')).toHaveLength(1);
  });

  it('a follow-up written through onLive is answered in the same process without a continue marker', async () => {
    const f = fakeSdk();
    let live: LiveInput | null = null;
    const r = reader(new ClaudeEngine({ accounts: testRegistry(), queryFn: f.queryFn, readFile: async () => Buffer.from('') }).runTurn(req({ onLive: (l) => { live = l; } })));
    f.push(sdk.init(), sdk.bgLevel([{ id: 't1', desc: 'build' }]), sdk.result('first'));
    await r.until('result');
    expect(await live!.send({ text: 'and also this', attachments: [] })).toBe(true);
    await new Promise((res) => setTimeout(res, 0));
    expect(f.inputs.map(textOf)).toEqual(['hi', 'and also this']);
    f.push(sdk.delta('answer'), sdk.result('answer'));
    expect(await r.until('result')).toMatchObject({ text: 'answer' });
    expect(r.seen.some((e) => e.kind === 'continue')).toBe(false);
    // Still a live task → still open; settling it ends the process after its continuation.
    f.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.result('done'));
    const rest = await r.rest();
    expect(rest.map((e) => e.kind)).toEqual(['background', 'continue', 'system', 'result']);
    await new Promise((res) => setTimeout(res, 0));
    expect(f.state.inputClosed).toBe(true);
    expect(await live!.send({ text: 'late', attachments: [] })).toBe(false);
  });

  it('ends after the grace window when the task set empties but no continuation comes', async () => {
    const f = fakeSdk();
    const r = reader(new ClaudeEngine({ accounts: testRegistry(), queryFn: f.queryFn, bgGraceMs: 20 }).runTurn(req()));
    f.push(sdk.init(), sdk.bgLevel([{ id: 't1', desc: 'x' }]), sdk.result('r'));
    await r.until('result');
    f.push(sdk.bgLevel([]));
    const rest = await r.rest();
    expect(rest).toMatchObject([{ kind: 'background', tasks: [] }]);
    expect(f.state.inputClosed).toBe(true);
  });

  it('caps the wait and says so', async () => {
    const f = fakeSdk();
    const r = reader(new ClaudeEngine({ accounts: testRegistry(), queryFn: f.queryFn, bgMaxMs: 20 }).runTurn(req()));
    f.push(sdk.init(), sdk.bgLevel([{ id: 't1', desc: 'forever' }]), sdk.result('r'));
    await r.until('result');
    const rest = await r.rest();
    expect(rest[0]).toMatchObject({ kind: 'notice', message: expect.stringContaining('백그라운드 작업이') });
    expect(rest.at(-1)).toMatchObject({ kind: 'background', tasks: [] });
    expect(rest.some((e) => e.kind === 'result')).toBe(false);
  });

  it('abort while waiting stops the process and clears the background status', async () => {
    const f = fakeSdk();
    const ac = new AbortController();
    const r = reader(new ClaudeEngine({ accounts: testRegistry(), queryFn: f.queryFn }).runTurn(req({ signal: ac.signal })));
    f.push(sdk.init(), sdk.bgLevel([{ id: 't1', desc: 'x' }]), sdk.result('r'));
    await r.until('result');
    ac.abort();
    const rest = await r.rest();
    expect(rest).toMatchObject([{ kind: 'background', tasks: [] }]);
    expect(f.state.inputClosed).toBe(true);
  });

  it('falls back to task_started / task_notification when no level signal is sent', async () => {
    const f = fakeSdk();
    const r = reader(new ClaudeEngine({ accounts: testRegistry(), queryFn: f.queryFn }).runTurn(req()));
    f.push(sdk.init(), sdk.taskStarted('t1', 'review'), sdk.taskStarted('t2', 'inline', false), sdk.result('r'));
    expect(await r.until('background')).toMatchObject({ kind: 'background', tasks: ['review'] });
    await r.until('result');
    f.push(sdk.taskDone('t1'), sdk.notifyUser(), sdk.delta('d'), sdk.result('d'));
    const rest = await r.rest();
    expect(rest.map((e) => e.kind)).toEqual(['background', 'task_done', 'continue', 'system', 'delta', 'result']);
  });
});
