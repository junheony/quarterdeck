import { describe, expect, it } from 'vitest';
import { StubEngine, okResult } from './StubEngine';

describe('StubEngine', () => {
  it('yields the scripted events and records calls', async () => {
    const eng = new StubEngine(async (req, call) => [
      { kind: 'init', sessionId: 's1', model: 'claude-opus-5-5' },
      { kind: 'delta', text: `hi ${req.account} ${call}` },
      okResult('s1', 'hi'),
    ]);
    const req = { account: 'b' as const, cwd: '/w', resumeSessionId: null, model: 'opus' as const, prompt: 'x', signal: new AbortController().signal, onPermission: async () => 'once' as const };
    const events = [];
    for await (const e of eng.runTurn(req)) events.push(e);
    expect(events[1]).toEqual({ kind: 'delta', text: 'hi b 0' });
    expect(events[2]).toMatchObject({ kind: 'result', ok: true, sessionId: 's1', text: 'hi' });
    expect(eng.calls).toHaveLength(1);
    expect(eng.calls[0]?.account).toBe('b');
  });
});
