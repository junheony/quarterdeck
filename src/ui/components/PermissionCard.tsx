import { useEffect, useState } from 'react';
import type { PermissionDecision } from '../../shared/turn-types';
import { fileDiffsFor } from '../diff';
import type { PendingPermission } from '../state';
import { DiffList } from './DiffView';
import { Markdown } from './MessageView';

/**
 * How long a card stays in its "보내는 중…" state after a tap. The card normally unmounts on the server's
 * `*_resolved` message; if that never comes (dead socket) the buttons come back so the person can try
 * again, or see that it is stuck.
 */
export const CARD_PENDING_RESET_MS = 8_000;

/**
 * Tapping a button gives no feedback until the server answers, so people tap again. `pending` holds the
 * sent value until the request changes or the fallback timer fires (see CARD_PENDING_RESET_MS).
 */
export function usePending<T>(requestId: string) {
  const [pending, setPending] = useState<T | null>(null);
  useEffect(() => { setPending(null); }, [requestId]);
  useEffect(() => {
    if (pending === null) return;
    const t = setTimeout(() => setPending(null), CARD_PENDING_RESET_MS);
    return () => clearTimeout(t);
  }, [pending]);
  return [pending, setPending] as const;
}

const SENDING_NOTE = <span className="muted sending-note" role="status">보내는 중…</span>;

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
  const [pending, setPending] = usePending<PermissionDecision>(req.requestId);
  const decide = (d: PermissionDecision) => { setPending(d); onDecide(req.requestId, d); };
  return (
    <div className="permission-card plan-card" role="group" aria-label="계획 승인" data-testid="plan-card">
      <div className="permission-head"><span className="dot" aria-hidden="true" />계획 승인</div>
      <div className="permission-scope muted" title={req.cwd}>{req.sessionId ? `세션 ${req.sessionId.slice(0, 8)}` : '새 세션'} · {req.cwd}</div>
      <div className="plan-body">{plan ? <Markdown text={plan} /> : <span className="muted">계획 내용이 없습니다.</span>}</div>
      <div className={pending ? 'permission-actions sending' : 'permission-actions'}>
        <button type="button" className="btn deny" disabled={!!pending} onClick={() => decide('deny')}>계속 계획</button>
        <button type="button" className="btn ghost" disabled={!!pending} title="진행하되 도구 호출마다 묻습니다" onClick={() => decide('once')}>승인하고 진행 · 수동 승인</button>
        <button type="button" className="btn primary" disabled={!!pending} title="진행하며 파일 편집은 묻지 않고 허용합니다" onClick={() => decide('session')}>승인하고 진행 · 편집 자동 승인</button>
        {pending && SENDING_NOTE}
      </div>
    </div>
  );
}

export function PermissionCard({ req, onDecide }: { req: PendingPermission; onDecide: (requestId: string, decision: PermissionDecision) => void }) {
  // Split so each variant owns its hooks (no hook sits behind the early return).
  return req.toolName === 'ExitPlanMode' ? <PlanCard req={req} onDecide={onDecide} /> : <ToolPermissionCard req={req} onDecide={onDecide} />;
}

function ToolPermissionCard({ req, onDecide }: { req: PendingPermission; onDecide: (requestId: string, decision: PermissionDecision) => void }) {
  const [pending, setPending] = usePending<PermissionDecision>(req.requestId);
  const decide = (d: PermissionDecision) => { setPending(d); onDecide(req.requestId, d); };
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
      <div className={pending ? 'permission-actions sending' : 'permission-actions'}>
        {/* defaultToNo: the card opens on 거부 so a stray Enter cannot approve. */}
        <button type="button" className="btn deny" autoFocus={req.defaultToNo} disabled={!!pending} onClick={() => decide('deny')}>거부</button>
        {/* Review I4: only when an SDK suggestion can be kept for the session; the label says what. */}
        {/* A long rule (e.g. a whole Bash command) must not widen the card: short label here, the rule below. */}
        {req.allowSession && <button type="button" className="btn ghost session-allow" title={req.sessionLabel ?? undefined} disabled={!!pending} onClick={() => decide('session')}>이 세션 동안 허용</button>}
        <button type="button" className="btn primary" disabled={!!pending} onClick={() => decide('once')}>허용 1회</button>
        {pending && SENDING_NOTE}
      </div>
      {rule && <div className="permission-session-rule muted" data-testid="session-rule">이 세션 동안 허용: <code>{rule}</code></div>}
    </div>
  );
}
