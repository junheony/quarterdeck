import type { ChatItem, ToolCallItem } from './state';

/** ux-state: Claude's todo list as the pane shows it (TodoWrite, or the newer TaskCreate/TaskUpdate tools). */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type Todo = { id: string; content: string; activeForm: string | null; status: TodoStatus };

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x : null);
const status = (x: unknown): TodoStatus | null => (STATUSES.includes(x as TodoStatus) ? (x as TodoStatus) : null);

/** TodoWrite's `todos` array, validated; null when the input is not a todo list at all. */
export function todosOf(input: unknown): Todo[] | null {
  const raw = obj(input).todos;
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((t, i): Todo[] => {
    const o = obj(t);
    const content = str(o.content);
    return content ? [{ id: str(o.id) ?? String(i + 1), content, activeForm: str(o.activeForm), status: status(o.status) ?? 'pending' }] : [];
  });
}

/** The id TaskCreate assigned: its JSON output `{task:{id}}`, or "Task #3 …" text; else null. */
function createdId(result: string | null): string | null {
  if (!result) return null;
  try {
    const id = obj(obj(JSON.parse(result) as unknown).task).id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  } catch { /* plain text */ }
  return /#\s*(\d+)/.exec(result)?.[1] ?? null;
}

/** Applies one tool call to the list (unchanged for any other tool). */
export function applyTodoCall(list: Todo[] | null, call: ToolCallItem): Todo[] | null {
  if (call.isError) return list;
  const i = obj(call.input);
  switch (call.name) {
    case 'TodoWrite': return todosOf(call.input) ?? list;
    case 'TaskCreate': {
      const content = str(i.subject) ?? str(i.description);
      if (!content) return list;
      const cur = list ?? [];
      const id = createdId(call.result) ?? String(cur.length + 1);
      return [...cur.filter((t) => t.id !== id), { id, content, activeForm: str(i.activeForm), status: 'pending' }];
    }
    case 'TaskUpdate': {
      const id = typeof i.taskId === 'number' ? String(i.taskId) : str(i.taskId);
      if (!id || !list) return list;
      if (i.status === 'deleted') return list.filter((t) => t.id !== id);
      return list.map((t) => (t.id === id ? { ...t, status: status(i.status) ?? t.status, content: str(i.subject) ?? t.content, activeForm: str(i.activeForm) ?? t.activeForm } : t));
    }
    default: return list;
  }
}

/** The latest todo list in a pane's items (null = Claude never made one here). */
export function latestTodos(items: ChatItem[]): Todo[] | null {
  let list: Todo[] | null = null;
  for (const it of items) if (it.kind === 'assistant') for (const c of it.toolCalls) list = applyTodoCall(list, c);
  return list;
}

export function todoCounts(list: Todo[]): { done: number; total: number; current: Todo | null } {
  return { done: list.filter((t) => t.status === 'completed').length, total: list.length, current: list.find((t) => t.status === 'in_progress') ?? null };
}
