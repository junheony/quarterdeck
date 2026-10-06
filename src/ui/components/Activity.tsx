import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { TaskStatus, TurnPhase } from '../../shared/turn-types';
import type { AgentInfo, ChatItem, PaneBackground, ToolCallItem } from '../state';
import { toolLabel } from '../toolLabel';
import { ClaudeMark } from './EngineMark';

type Assistant = Extract<ChatItem, { kind: 'assistant' }>;

/** Date.now(), re-read every `ms` while `active` — the only ticking state; kept inside the small components that show time. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

/** m:ss (h:mm:ss past an hour). */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 950 → "950", 1234 → "1.2k", 25300 → "25k". */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  return n < 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(n / 1000)}k`;
}

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const clip = (s: string, n = 40) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/** Present-tense verb and a short argument for a running tool call (status row). */
export function toolVerb(call: Pick<ToolCallItem, 'name' | 'input'>): { verb: string; arg: string } {
  const i = call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {};
  const s = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  const file = s('file_path') || s('path') || s('notebook_path');
  switch (call.name) {
    case 'Read': return { verb: '파일 읽는 중', arg: file ? base(file) : '' };
    case 'Bash': return { verb: '명령 실행 중', arg: clip(s('description') || s('command')) };
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return { verb: '파일 수정 중', arg: file ? base(file) : '' };
    case 'Grep': case 'Glob': return { verb: '검색 중', arg: clip(s('pattern')) };
    case 'Agent': case 'Task': return { verb: '에이전트 실행 중', arg: clip(s('description') || s('subagent_type')) };
    case 'WebSearch': return { verb: '웹 검색 중', arg: clip(s('query')) };
    case 'WebFetch': return { verb: '웹 페이지 가져오는 중', arg: clip(s('url')) };
    case 'TodoWrite': return { verb: '할 일 정리 중', arg: '' };
    default: return { verb: '작업 중', arg: call.name.startsWith('mcp__') ? call.name.split('__').slice(1).join(' · ') : call.name };
  }
}

const PHASE_VERB: Record<TurnPhase, string> = { thinking: '생각 중…', responding: '응답 작성 중…', tool: '도구 준비 중…' };
const IDLE_VERBS = ['생각 중…', '작업 중…', '살펴보는 중…', '정리하는 중…'];

/**
 * Desktop-style live line above the composer while a turn runs: spinner, what it is doing now, m:ss,
 * output tokens, tool count and a stop button. Owns the 1s timer so nothing else re-renders per tick.
 */
export function StatusRow({ startedAt, started, progress, live, onInterrupt }: {
  startedAt: number | null;
  /** turn_started arrived (false = 시작하는 중…). */
  started: boolean;
  progress: { outputTokens: number; phase: TurnPhase } | null;
  live: Assistant | null;
  onInterrupt?: () => void;
}) {
  const now = useNow(true);
  const ms = startedAt === null ? 0 : now - startedAt;
  const running = live ? live.toolCalls.findLast((c) => c.result === null) : undefined;
  const tool = running ? toolVerb(running) : null;
  const verb = !started ? '시작하는 중…' : tool ? tool.verb : progress ? PHASE_VERB[progress.phase] : IDLE_VERBS[Math.floor(ms / 6000) % IDLE_VERBS.length]!;
  const tools = live ? live.toolCalls.length : 0;
  return (
    <div className="turn-status" role="status" data-testid="turn-status">
      <ClaudeMark className="spark spin" />
      <span className="status-verb">{verb}</span>
      {tool?.arg && <code className="status-arg" title={tool.arg}>{tool.arg}</code>}
      <span className="status-meta">
        <span>{clock(ms)}</span>
        {progress && progress.outputTokens > 0 && <span className="status-tokens"><span className="sep">·</span><span title="출력 토큰">↓ {tokens(progress.outputTokens)}<span className="status-unit"> 토큰</span></span></span>}
        {tools > 0 && <span className="status-tools"><span className="sep">·</span><span>도구 {tools}회</span></span>}
      </span>
      {started && onInterrupt && <button type="button" className="status-stop" onClick={onInterrupt} title="중단 (Esc)">중단</button>}
    </div>
  );
}

/** Subagent cards read live agent state from here, so MessageView's memo holds while agents update. */
export type AgentCtx = { agents: Record<string, AgentInfo>; bgLive: boolean; /** the pane has a turn running */ active: boolean };
export const AgentContext = createContext<AgentCtx>({ agents: {}, bgLive: false, active: false });

const STATUS_TEXT: Record<TaskStatus, string> = { running: '실행 중', completed: '완료', failed: '실패', stopped: '중단됨' };

/**
 * What an Agent/Task call's card shows: the call's own result wins; live subagent state fills in the rest.
 * `live`: the call's item streams, or (opened mid-turn: the call sits in the reloaded transcript) the pane's turn runs.
 */
export function agentStatus(call: ToolCallItem, info: AgentInfo | undefined, live: boolean, bgLive: boolean): TaskStatus {
  if (call.isError) return 'failed';
  if (info?.backgrounded) return info.status === 'running' && !live && !bgLive ? 'completed' : info.status;
  if (call.result === null) return info && info.status !== 'running' ? info.status : live ? 'running' : 'stopped';
  return info?.status === 'failed' ? 'failed' : 'completed';
}

const SHOW_CALLS = 5;

function pretty(v: unknown, max = 4000): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > max ? s.slice(0, max) + '\n…' : s;
}

/** One Agent/Task call: type and description, live timer/tokens, its last few tool calls, then ✓/✗ and duration. */
export function AgentCard({ call, live }: { call: ToolCallItem; live: boolean }) {
  const { agents, bgLive, active } = useContext(AgentContext);
  const info = agents[call.toolUseId];
  const status = agentStatus(call, info, live || (active && !!info), bgLive);
  const running = status === 'running';
  const now = useNow(running && !!info);
  const [all, setAll] = useState(false);
  const input = call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {};
  const type = info?.subagentType || (typeof input.subagent_type === 'string' ? input.subagent_type : '') || '에이전트';
  const desc = info?.description || (typeof input.description === 'string' ? input.description : '');
  const ms = info ? (info.usage && !running ? info.usage.durationMs : (info.endedAt ?? now) - info.startedAt) : null;
  const calls = info?.calls ?? [];
  const shown = all ? calls : calls.slice(-SHOW_CALLS);
  const icon = running ? <ClaudeMark className="spark spin" /> : status === 'completed' ? <span className="agent-mark ok" aria-hidden="true">✓</span> : status === 'failed' ? <span className="agent-mark err" aria-hidden="true">✗</span> : <span className="agent-mark" aria-hidden="true">■</span>;
  return (
    <div className={`agent-card ${status}`} data-testid="agent-card">
      <div className="agent-head">
        {icon}
        <span className="agent-type">{type}</span>
        <span className="agent-desc" title={desc}>{desc}</span>
        {info?.backgrounded && <span className="agent-badge">백그라운드</span>}
        <span className="agent-meta">
          {ms !== null && <span>{clock(ms)}</span>}
          {info?.usage && info.usage.totalTokens > 0 && <span>{tokens(info.usage.totalTokens)} 토큰</span>}
          {!running && <span className={`agent-status ${status}`}>{STATUS_TEXT[status]}</span>}
        </span>
      </div>
      {calls.length > 0 && (
        <ul className="agent-calls">
          {!all && calls.length > SHOW_CALLS && (
            <li><button type="button" className="agent-more" onClick={() => setAll(true)}>+{calls.length - SHOW_CALLS}개 더 보기</button></li>
          )}
          {shown.map((c) => (
            <li key={c.toolUseId} className={c.isError ? 'error' : c.done ? 'done' : 'running'}>
              <span className="agent-call-mark" aria-hidden="true">{c.isError ? '✗' : c.done ? '✓' : '…'}</span>
              <span className="tool-label">{toolLabel({ ...c, result: null })}</span>
            </li>
          ))}
        </ul>
      )}
      {running && calls.length === 0 && info?.lastToolName && <div className="agent-last muted">{info.lastToolName}</div>}
      {(call.result !== null || typeof input.prompt === 'string') && (
        <details className="agent-detail">
          <summary><span className="tool-label">{call.result !== null ? '결과 보기' : '지시 보기'}</span><span className="tool-caret" aria-hidden="true">›</span></summary>
          <div className="tool-detail">
            {typeof input.prompt === 'string' && <pre className="tool-input">{pretty(input.prompt)}</pre>}
            {call.result !== null && <pre className="tool-output">{pretty(call.result)}</pre>}
          </div>
        </details>
      )}
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = { local_bash: '명령', local_agent: '에이전트', mcp_task: 'MCP', local_workflow: '워크플로', remote_agent: '원격 에이전트' };

/**
 * "백그라운드 작업 N개" pill with a pulsing dot; click opens the task list (each with its age, status and
 * 중지 when the process can stop one task) and 모두 중지.
 */
export function BackgroundPill({ bg, onStopTask, onStopAll }: { bg: PaneBackground; onStopTask?: (taskId: string) => void; onStopAll: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(open);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const rows = bg.detail.length ? bg.detail.map((d) => ({ id: d.id, description: d.description, type: d.type, ms: now - bg.receivedAt + d.ageMs })) : bg.tasks.map((t, i) => ({ id: null as string | null, description: t, type: '', ms: null as number | null, key: i }));
  const n = rows.length;
  return (
    <div className="bg-pill-wrap" ref={ref}>
      <button type="button" className={`bg-pill ${open ? 'open' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog" data-testid="bg-pill">
        <span className="pulse-dot" aria-hidden="true" />
        <span className="bg-pill-label"><span className="bg-pill-word">백그라운드</span><span className="bg-pill-long"> 작업</span> {n}개</span>
      </button>
      {open && (
        <div className="bg-popover" role="dialog" aria-label="백그라운드 작업" data-testid="bg-popover">
          <div className="bg-pop-head">백그라운드 작업 {n}개</div>
          <ul className="bg-list">
            {rows.map((r, i) => (
              <li key={r.id ?? i}>
                <span className="pulse-dot" aria-hidden="true" />
                <span className="bg-desc" title={r.description}>{r.description || '작업'}</span>
                <span className="bg-sub">
                  {r.type && <span>{TYPE_LABEL[r.type] ?? r.type}</span>}
                  {r.ms !== null && <span>{clock(r.ms)}</span>}
                  <span>실행 중</span>
                </span>
                {bg.canStop && r.id && onStopTask && <button type="button" className="btn ghost bg-stop-one" onClick={() => onStopTask(r.id!)}>중지</button>}
              </li>
            ))}
          </ul>
          <div className="bg-pop-foot">
            <button type="button" className="btn ghost bg-stop-all" onClick={() => { setOpen(false); onStopAll(); }}>모두 중지</button>
          </div>
        </div>
      )}
    </div>
  );
}
