import { useState } from 'react';
import { todoCounts, type Todo, type TodoStatus } from '../todos';

const ICON: Record<TodoStatus, string> = { pending: '○', in_progress: '◐', completed: '✓' };
const STATUS_LABEL: Record<TodoStatus, string> = { pending: '대기', in_progress: '진행 중', completed: '완료' };

/** A checklist: one line per todo, icon by status (also the compact body of a TodoWrite tool call). */
export function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="todo-list">
      {todos.map((t) => (
        <li key={t.id} className={`todo ${t.status}`}>
          <span className="todo-icon" aria-label={STATUS_LABEL[t.status]}>{ICON[t.status]}</span>
          <span className="todo-text">{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
        </li>
      ))}
    </ul>
  );
}

/** ux-state: the pane's latest todo list, pinned above the composer (Claude Desktop style); click the head to fold. */
export function TodoPanel({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(true);
  const { done, total, current } = todoCounts(todos);
  if (total === 0) return null;
  return (
    <div className={`todo-panel ${open ? 'open' : ''}`} data-testid="todo-panel">
      <button type="button" className="todo-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="todo-title">할 일</span>
        <span className="todo-count">{done}/{total}</span>
        {!open && current && <span className="todo-current">{current.activeForm ?? current.content}</span>}
        <span className="spacer" />
        <span className="tool-caret" aria-hidden="true">›</span>
      </button>
      {open && <TodoList todos={todos} />}
    </div>
  );
}
