import { describe, expect, it } from 'vitest';
import { roleSummary } from './roles';

const call = (name: string, input: unknown) => ({ toolUseId: 'x', name, input, result: null, isError: false });

describe('roleSummary (D9)', () => {
  it('lists Agent/Task calls with subagent type and model, and Bash offload invocations with model / cross', () => {
    const roles = roleSummary([
      call('Agent', { subagent_type: 'explore', model: 'sonnet', description: 'find auth', prompt: '…' }),
      call('Task', { description: 'review', prompt: '…' }),
      call('Bash', { command: 'offload -m fable "review the design"' }),
      call('Bash', { command: '/Users/alice/bin/offload cross "decide"' }),
      call('Bash', { command: 'offload status' }),
      call('Bash', { command: 'git status && offload -m opus x' }),
      call('Read', { file_path: '/x' }),
    ]);
    expect(roles).toEqual([
      { kind: 'agent', type: 'explore', model: 'sonnet', description: 'find auth' },
      { kind: 'agent', type: 'general', model: null, description: 'review' },
      { kind: 'offload', model: 'fable', cross: false, command: 'offload -m fable "review the design"' },
      { kind: 'offload', model: null, cross: true, command: '/Users/alice/bin/offload cross "decide"' },
    ]);
  });
});
