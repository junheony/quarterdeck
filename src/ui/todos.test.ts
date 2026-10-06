import { describe, expect, it } from 'vitest';
import type { ChatItem, ToolCallItem } from './state';
import { latestTodos, todoCounts, todosOf } from './todos';

const call = (name: string, input: unknown, result: string | null = null, isError = false): ToolCallItem => ({ toolUseId: Math.random().toString(36), name, input, result, isError });
const turn = (...toolCalls: ToolCallItem[]): ChatItem => ({ kind: 'assistant', turnId: null, text: '', toolCalls, badge: null, streaming: false, error: null, notes: [], attempts: [] });

describe('todos (ux-state)', () => {
  it('todosOf validates TodoWrite input', () => {
    expect(todosOf({ todos: [{ content: 'a', status: 'completed', activeForm: 'A-ing' }, { content: '', status: 'pending' }, { content: 'b', status: 'weird' }, 'junk'] })).toEqual([
      { id: '1', content: 'a', activeForm: 'A-ing', status: 'completed' },
      { id: '3', content: 'b', activeForm: null, status: 'pending' },
    ]);
    expect(todosOf({})).toBeNull();
    expect(todosOf(null)).toBeNull();
  });

  it('the latest TodoWrite wins; no todo tool = null; errored calls are ignored', () => {
    expect(latestTodos([turn(call('Bash', { command: 'ls' }))])).toBeNull();
    const items = [
      { kind: 'user', text: 'go' } as ChatItem,
      turn(call('TodoWrite', { todos: [{ content: 'a', status: 'in_progress', activeForm: 'doing a' }, { content: 'b', status: 'pending' }] })),
      turn(call('Read', { file_path: '/x' }), call('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress', activeForm: 'doing b' }] })),
      turn(call('TodoWrite', { todos: [] }, 'boom', true)),
    ];
    const list = latestTodos(items)!;
    expect(list.map((t) => [t.content, t.status])).toEqual([['a', 'completed'], ['b', 'in_progress']]);
    expect(todoCounts(list)).toEqual({ done: 1, total: 2, current: list[1] });
  });

  it('TaskCreate / TaskUpdate build and edit the list (ids from the result, else creation order)', () => {
    const items = [turn(
      call('TaskCreate', { subject: 'write tests', description: 'd', activeForm: 'writing tests' }, JSON.stringify({ task: { id: '7', subject: 'write tests' } })),
      call('TaskCreate', { subject: 'ship', description: 'd' }, 'Task #8 created successfully: ship'),
      call('TaskCreate', { subject: 'tidy', description: 'd' }, null),
      call('TaskUpdate', { taskId: '7', status: 'completed' }),
      call('TaskUpdate', { taskId: '8', status: 'in_progress', subject: 'ship it' }),
      call('TaskUpdate', { taskId: '3', status: 'deleted' }),
      call('TaskUpdate', { taskId: '99', status: 'completed' }),
    )];
    expect(latestTodos(items)).toEqual([
      { id: '7', content: 'write tests', activeForm: 'writing tests', status: 'completed' },
      { id: '8', content: 'ship it', activeForm: null, status: 'in_progress' },
    ]);
    expect(latestTodos([turn(call('TaskUpdate', { taskId: '1', status: 'completed' }))])).toBeNull();
  });
});
