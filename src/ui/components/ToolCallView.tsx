import { useContext } from 'react';
import { fileDiffsFor, relPath } from '../diff';
import { SidePanelContext } from '../sidePanel';
import type { ToolCallItem } from '../state';
import { groupLabel, toolLabel } from '../toolLabel';
import { applyTodoCall, todoCounts } from '../todos';
import { TodoList } from './TodoPanel';
import { DiffList } from './DiffView';
import { AgentCard } from './Activity';
import { CopyButton } from './CopyButton';

function pretty(v: unknown, max = 4000): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > max ? s.slice(0, max) + '\n…' : s;
}

/** What a tool card's copy button copies: the shell command itself when there is one, else the full (uncut) value. */
function copyable(v: unknown): string {
  if (v && typeof v === 'object' && typeof (v as { command?: unknown }).command === 'string') return (v as { command: string }).command;
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

function stateOf(call: ToolCallItem, live: boolean): { cls: string; text: string } {
  if (call.isError) return { cls: 'error', text: '오류' };
  if (call.result === null && live) return { cls: 'running', text: '실행 중…' };
  return { cls: '', text: '' };
}

/** A file-editing call (Edit / MultiEdit / Write / NotebookEdit, Codex file change) as diff cards; null for any other call. */
function DiffToolCall({ call, live, cwd }: { call: ToolCallItem; live: boolean; cwd?: string | null }) {
  const diffs = fileDiffsFor(call.name, call.input, call.result);
  if (!diffs) return null;
  const st = stateOf(call, live);
  return (
    <div className={`tool-call diff-call ${st.cls}`} data-testid="tool-call">
      <DiffList diffs={diffs} cwd={cwd} {...(st.text ? { state: st.text } : {})} />
      {call.isError && call.result && <pre className="tool-output">{pretty(call.result)}</pre>}
    </div>
  );
}

const isDiffCall = (c: ToolCallItem) => fileDiffsFor(c.name, c.input, c.result) !== null;
const isAgentCall = (c: ToolCallItem) => c.name === 'Agent' || c.name === 'Task';

/** The file a Read call looked at (a Read of a missing file still offers the panel; it shows the error). */
function readPath(call: ToolCallItem): string | null {
  const p = call.name === 'Read' && call.input && typeof call.input === 'object' ? (call.input as { file_path?: unknown }).file_path : null;
  return typeof p === 'string' && p ? p : null;
}

/** One tool call = one muted line; click to see its input and output. File edits render as diff cards. */
export function ToolCallView({ call, live = false, cwd }: { call: ToolCallItem; live?: boolean; cwd?: string | null }) {
  const open = useContext(SidePanelContext);
  const st = stateOf(call, live);
  if (isDiffCall(call)) return <DiffToolCall call={call} live={live} cwd={cwd} />;
  // ux-state: a TodoWrite shows its checklist, not raw JSON.
  const todos = call.name === 'TodoWrite' ? applyTodoCall(null, call) : null;
  const file = readPath(call);
  return (
    <details className={`tool-call ${st.cls}`} data-testid="tool-call">
      <summary title={call.name}>
        <span className="tool-label">{toolLabel(call)}</span>
        {todos && todos.length > 0 && <span className="tool-state todo-count">{todoCounts(todos).done}/{todos.length}</span>}
        {st.text && <span className="tool-state">{st.text}</span>}
        {open && file && (
          <button type="button" className="file-link tool-open" title={`${file} — 사이드 패널에서 열기`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); open({ kind: 'file', path: file }); }}>
            {relPath(file, cwd)}
          </button>
        )}
        <span className="tool-caret" aria-hidden="true">›</span>
      </summary>
      {todos ? (
        <div className="tool-detail todo-detail"><TodoList todos={todos} /></div>
      ) : (
        <div className="tool-detail">
          <div className="tool-pre"><pre className="tool-input">{pretty(call.input)}</pre><CopyButton icon text={() => copyable(call.input)} label={typeof (call.input as { command?: unknown } | null)?.command === 'string' ? '명령 복사' : '입력 복사'} /></div>
          {call.result !== null && <div className="tool-pre out"><pre className="tool-output">{pretty(call.result)}</pre><CopyButton icon text={() => copyable(call.result)} label="출력 복사" /></div>}
        </div>
      )}
    </details>
  );
}

/**
 * A turn's tool calls in order: file edits as their own diff cards and subagent calls as agent cards (Desktop style); each run of other calls
 * as one line alone, or one collapsed group line ("실행된 명령 5개 ›") for several.
 */
export function ToolCalls({ calls, live = false, cwd }: { calls: ToolCallItem[]; live?: boolean; cwd?: string | null }) {
  if (calls.length === 0) return null;
  // File edits and subagent (Agent/Task) calls stand alone; other calls group.
  const segments: { solo: boolean; calls: ToolCallItem[] }[] = [];
  for (const c of calls) {
    const solo = isAgentCall(c) || isDiffCall(c);
    const last = segments.at(-1);
    if (last && !solo && !last.solo) last.calls.push(c);
    else segments.push({ solo, calls: [c] });
  }
  if (segments.length > 1) return <>{segments.map((s) => <ToolCalls key={s.calls[0]!.toolUseId} calls={s.calls} live={live} cwd={cwd} />)}</>;
  if (isAgentCall(calls[0]!)) return <AgentCard call={calls[0]!} live={live} />;
  if (segments[0]!.solo) return <ToolCallView call={calls[0]!} live={live} cwd={cwd} />;
  if (calls.length === 1) return <ToolCallView call={calls[0]!} live={live} cwd={cwd} />;
  const running = live && calls.some((c) => c.result === null);
  const errors = calls.filter((c) => c.isError).length;
  return (
    <details className={`tool-group ${running ? 'running' : ''}`} data-testid="tool-group">
      <summary>
        <span className="tool-label">{groupLabel(calls)}</span>
        {running && <span className="tool-state">실행 중…</span>}
        {errors > 0 && <span className="tool-state error">오류 {errors}</span>}
        <span className="tool-caret" aria-hidden="true">›</span>
      </summary>
      <div className="tool-group-list">
        {calls.map((c) => <ToolCallView key={c.toolUseId} call={c} live={live} cwd={cwd} />)}
      </div>
    </details>
  );
}
