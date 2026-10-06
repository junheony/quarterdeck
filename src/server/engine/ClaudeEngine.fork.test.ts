import { describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeEngine, buildOptions } from './ClaudeEngine';
import type { EngineEvent, TurnRequest } from './Engine';
import { fakeSdk, sdk } from './fakeSdk';
import { testRegistry } from '../../shared/accounts.testkit';

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return { account: 'c', cwd: '/w', resumeSessionId: 'parent', model: 'opus', prompt: '고친 질문', signal: new AbortController().signal, onPermission: async () => 'once', ...over };
}
const deps = { home: '/h', accounts: testRegistry('/h'), baseEnv: {}, abortController: new AbortController(), onStderr: () => {} };

describe('메시지 편집 갈래: fork options', () => {
  it('forkAt resumes the parent as a fork cut at that entry', () => {
    const o = buildOptions(req({ forkAt: 'a1' }), deps);
    expect(o).toMatchObject({ resume: 'parent', forkSession: true, resumeSessionAt: 'a1' });
  });

  it('a plain resume does not fork', () => {
    const o = buildOptions(req(), deps);
    expect(o.forkSession).toBeUndefined();
    expect(o.resumeSessionAt).toBeUndefined();
  });

  it('the fork reports the id the CLI gives it, never the parent’s', async () => {
    const f = fakeSdk();
    let seen: Options | undefined;
    const queryFn = ((p: Parameters<typeof f.queryFn>[0]) => { seen = p.options; return f.queryFn(p); }) as typeof f.queryFn;
    f.push(sdk.init('child'), sdk.delta('답'), sdk.result('답', 'child'));
    f.end();
    const evs: EngineEvent[] = [];
    for await (const e of new ClaudeEngine({ accounts: testRegistry(), queryFn, readFile: async () => Buffer.from('') }).runTurn(req({ forkAt: 'a1' }))) evs.push(e);
    expect(seen).toMatchObject({ resume: 'parent', forkSession: true, resumeSessionAt: 'a1' });
    expect(evs.find((e) => e.kind === 'init')).toMatchObject({ sessionId: 'child' });
    expect(evs.find((e) => e.kind === 'result')).toMatchObject({ sessionId: 'child', ok: true });
  });
});
