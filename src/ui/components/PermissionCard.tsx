import type { PermissionDecision } from '../../shared/turn-types';
import { fileDiffsFor } from '../diff';
import type { PendingPermission } from '../state';
import { DiffList } from './DiffView';
import { Markdown } from './MessageView';

/** "이 세션 동안 `Bash(…)` 허용" → "`Bash(…)`": what the session grant covers, shown under the buttons. */
function sessionRule(label: string | null): string | null {
  if (!label) return null;
  const m = /^이 세션 동안 (.+) 허용$/s.exec(label);
  return m ? m[1]! : label;
}

/**
 * 계획 모드: ExitPlanMode asks to leave plan mode with its plan. 'session' = approve and auto-accept edits,
 * 'once' = approve and keep asking, 'deny' = keep planning (the server maps these, TurnRunner/ClaudeEngine).
 */
function PlanCard({ req, onDecide }: { req: PendingPermission; onDecide: (requestId: string, decision: PermissionDecision) => void }) {
  const raw = req.input && typeof req.input === 'object' ? (req.input as { plan?: unknown }).plan : undefined;
  const plan = typeof raw === 'string' ? raw : '';
  return (
    <div className="permission-card plan-card" role="group" aria-label="계획 승인" data-testid="plan-card">
      <div className="permission-head"><span className="dot" aria-hidden="true" />계획 승인</div>
      <div className="permission-scope muted" title={req.cwd}>{req.sessionId ? `세션 ${req.sessionId.slice(0, 8)}` : '새 세션'} · {req.cwd}</div>
      <div className="plan-body">{plan ? <Markdown text={plan} /> : <span className="muted">계획 내용이 없습니다.</span>}</div>
      <div className="permission-actions">
        <button type="button" className="btn deny" onClick={() => onDecide(req.requestId, 'deny')}>계속 계획</button>
        <button type="button" className="btn ghost" title="진행하되 도구 호출마다 묻습니다" onClick={() => onDecide(req.requestId, 'once')}>승인하고 진행 · 수동 승인</button>
        <button type="button" className="btn primary" title="진행하며 파일 편집은 묻지 않고 허용합니다" onClick={() => onDecide(req.requestId, 'session')}>승인하고 진행 · 편집 자동 승인</button>
      </div>
    </div>
  );
}

export function PermissionCard({ req, onDecide }: { req: PendingPermission; onDecide: (requestId: string, decision: PermissionDecision) => void }) {
  if (req.toolName === 'ExitPlanMode') return <PlanCard req={req} onDecide={onDecide} />;
  const input = JSON.stringify(req.input, null, 2);
  // Edit / Write / … asks show the change they would make, like the tool call card will.
  const diffs = fileDiffsFor(req.toolName, req.input, null);
  const rule = req.allowSession ? sessionRule(req.sessionLabel) : null;
  return (
    <div className="permission-card" role="group" aria-label={`권한 요청 ${req.toolName}`}>
      <div className="permission-head"><span className="dot" aria-hidden="true" />권한 요청 <strong>{req.toolName}</strong></div>
      {/* Review I3: prompts from every session reach every tab — say which one this is. */}
      <div className="permission-scope muted" data-testid="permission-scope" title={req.cwd}>
        {req.sessionId ? `세션 ${req.sessionId.slice(0, 8)}` : '새 세션'} · {req.cwd}
      </div>
      {req.title && <div className="permission-title">{req.title}</div>}
      {req.decisionReason && <div className="permission-reason muted">이유: {req.decisionReason}</div>}
      {req.blockedPath && <div className="permission-path muted">경로: {req.blockedPath}</div>}
      {diffs ? (
        <>
          <DiffList diffs={diffs} cwd={req.cwd} />
          <details className="permission-raw">
            <summary>원본 입력 보기</summary>
            <pre>{input.length > 2000 ? input.slice(0, 2000) + '\n…' : input}</pre>
          </details>
        </>
      ) : <pre>{input.length > 2000 ? input.slice(0, 2000) + '\n…' : input}</pre>}
      <div className="permission-actions">
        {/* defaultToNo: the card opens on 거부 so a stray Enter cannot approve. */}
        <button type="button" className="btn deny" autoFocus={req.defaultToNo} onClick={() => onDecide(req.requestId, 'deny')}>거부</button>
        {/* Review I4: only when an SDK suggestion can be kept for the session; the label says what. */}
        {/* A long rule (e.g. a whole Bash command) must not widen the card: short label here, the rule below. */}
        {req.allowSession && <button type="button" className="btn ghost session-allow" title={req.sessionLabel ?? undefined} onClick={() => onDecide(req.requestId, 'session')}>이 세션 동안 허용</button>}
        <button type="button" className="btn primary" onClick={() => onDecide(req.requestId, 'once')}>허용 1회</button>
      </div>
      {rule && <div className="permission-session-rule muted" data-testid="session-rule">이 세션 동안 허용: <code>{rule}</code></div>}
    </div>
  );
}
