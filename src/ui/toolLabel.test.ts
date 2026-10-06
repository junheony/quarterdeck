import { describe, expect, it } from 'vitest';
import { groupLabel, toolLabel } from './toolLabel';
import type { ToolCallItem } from './state';

const call = (name: string, input: unknown): ToolCallItem => ({ toolUseId: name, name, input, result: null, isError: false });

describe('toolLabel', () => {
  it('reads like Desktop: Bash description first, else the command; files by their base name', () => {
    expect(toolLabel(call('Bash', { command: 'npm test', description: 'Run tests' }))).toBe('Run tests');
    expect(toolLabel(call('Bash', { command: 'npm   test' }))).toBe('명령 실행 npm test');
    expect(toolLabel(call('Edit', { file_path: '/w/src/ui/Chat.tsx' }))).toBe('Chat.tsx 수정함');
    expect(toolLabel(call('Read', { file_path: '/w/a.md' }))).toBe('a.md 읽음');
    expect(toolLabel(call('Agent', { description: 'find usages', subagent_type: 'explore' }))).toBe('서브에이전트 · find usages');
    expect(toolLabel(call('mcp__srv__do_thing', {}))).toBe('srv · do_thing');
  });

  it('long inputs are clipped to one line', () => {
    expect(toolLabel(call('Bash', { command: 'x'.repeat(200) })).length).toBeLessThan(70);
  });
});

describe('groupLabel', () => {
  it('names a run by what it did', () => {
    expect(groupLabel([call('Bash', {}), call('Bash', {})])).toBe('실행된 명령 2개');
    expect(groupLabel([call('Read', {}), call('Read', {}), call('Read', {})])).toBe('읽은 파일 3개');
    expect(groupLabel([call('Edit', {}), call('Write', {})])).toBe('수정한 파일 2개');
    expect(groupLabel([call('Bash', {}), call('Read', {})])).toBe('도구 호출 2개');
  });
});
