import { useState } from 'react';
import type { Question, QuestionAnswers } from '../../shared/turn-types';
import { answersFor, type PendingQuestion } from '../state';
import { usePending } from './PermissionCard';

export function QuestionCard({ req, onAnswer }: { req: PendingQuestion; onAnswer: (requestId: string, answers: QuestionAnswers) => void }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [free, setFree] = useState<Record<string, string>>({});
  // Same tap feedback as PermissionCard: lock the form until the server resolves the request (or 8 s pass).
  const [pending, setPending] = usePending<true>(req.requestId);

  // Picking an option and typing free text are mutually exclusive per question: whichever the user
  // touches last wins, and the other mode's state for that question is cleared so the UI never shows
  // a selection (a `.picked` option, or free text) that would not actually be submitted.
  const toggle = (q: Question, label: string) => {
    setFree((f) => (f[q.question] ? { ...f, [q.question]: '' } : f));
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
      return { ...p, [q.question]: next };
    });
  };
  const setFreeText = (q: Question, value: string) => {
    setFree((f) => ({ ...f, [q.question]: value }));
    if (value.trim()) setPicked((p) => (p[q.question]?.length ? { ...p, [q.question]: [] } : p));
  };
  const answerOf = (q: Question) => (free[q.question]?.trim() || (picked[q.question] ?? []).join(', '));
  const complete = req.questions.every((q) => answerOf(q) !== '');
  // The keys must be the exact question text (Task 9's answersFor is the single source of truth for
  // that mapping — the server drops mismatched keys and denies the request).
  const submit = () => { setPending(true); onAnswer(req.requestId, answersFor(req, req.questions.map((q) => answerOf(q)))); };

  return (
    <div className="question-card" role="group" aria-label="질문">
      <div className="question-head"><span className="dot" aria-hidden="true" />질문</div>
      <div className="question-scope muted" data-testid="question-scope" title={req.cwd}>{req.sessionId ? `세션 ${req.sessionId.slice(0, 8)}` : '새 세션'} · {req.cwd}</div>
      {req.questions.map((q) => (
        <div key={q.question} className="question">
          {q.header && <span className="chip header">{q.header}</span>}
          <div className="question-text">{q.question}{q.multiSelect && <span className="muted"> (복수 선택)</span>}</div>
          <div className="question-options">
            {q.options.map((o) => {
              const isPicked = (picked[q.question] ?? []).includes(o.label);
              return (
                <button type="button" key={o.label} className={`option ${isPicked ? 'picked' : ''}`} aria-pressed={isPicked} disabled={!!pending} onClick={() => toggle(q, o.label)}>
                  <span className="option-label">{o.label}</span>
                  {o.description && <span className="option-desc muted">{o.description}</span>}
                </button>
              );
            })}
          </div>
          <input className="question-free" placeholder="기타 (직접 입력)" aria-label={`${q.header} 직접 입력`} value={free[q.question] ?? ''} disabled={!!pending} onChange={(e) => setFreeText(q, e.target.value)} />
        </div>
      ))}
      <div className={pending ? 'permission-actions sending' : 'permission-actions'}>
        <button type="button" className="btn primary" disabled={!complete || !!pending} onClick={submit}>답변 보내기</button>
        {pending && <span className="muted sending-note" role="status">보내는 중…</span>}
      </div>
    </div>
  );
}
