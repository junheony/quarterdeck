import { useState } from 'react';
import type { QueueItem } from '../state';

/** ux-state: messages queued while a turn runs — a compact card above the composer: header (대기열 N · 모두 지우기), then one row per message (click to edit, ✕ to drop). */
export function QueueChips({ queue, paused, onEdit, onRemove, onClear, onResume, onSendNow }: {
  queue: QueueItem[];
  paused: boolean;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onResume: () => void;
  /** 지금 전송 (absent = not offered). */
  onSendNow?: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  if (!queue.length) return null;
  const save = () => {
    if (editing === null) return;
    const text = draft.trim();
    const item = queue.find((q) => q.id === editing);
    if (text) onEdit(editing, text);
    else if (item && !item.attachments.length) onRemove(editing);
    setEditing(null);
  };
  return (
    <div className={`queue ${paused ? 'paused' : ''}`} data-testid="queue">
      <div className="queue-head">
        <span className="queue-label">{paused ? '대기열 멈춤' : queue.every((q) => q.steer) ? '실행 중에 보냄' : '대기열'} <span className="queue-count">{queue.length}</span></span>
        <span className="spacer" />
        {paused && <button type="button" className="text-btn queue-resume" onClick={onResume}>이어서 보내기</button>}
        <button type="button" className="text-btn queue-clear" onClick={onClear}>모두 지우기</button>
      </div>
      <ol className="queue-list">
        {queue.map((q, i) => (
          <li key={q.id} className="queue-item">
            {editing === q.id ? (
              <input
                autoFocus
                value={draft}
                aria-label={`대기 메시지 ${i + 1} 수정`}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={save}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') setEditing(null); }}
              />
            ) : (
              <button type="button" className="queue-text" title={q.steer ? q.text : `${q.text}\n(클릭해서 수정)`} onClick={() => { if (q.steer) return; setEditing(q.id); setDraft(q.text); }}>
                {q.attachments.length > 0 && <span className="queue-att" aria-hidden="true">📎{q.attachments.length}</span>}
                {q.text || '첨부만'}
                {q.steer && <span className="queue-steer" title="이미 보냈습니다 — 기다리면 다음 단계에서 Claude 가 이어서 반영합니다 (멈출 필요 없음)"> · 보냄 · 다음 단계에서 반영</span>}
                {q.restart && <span className="queue-steer" title="서버가 재시작 중이라 보내지 못했습니다 — 다시 연결되면 자동으로 보냅니다"> · 재시작 뒤 전송</span>}
              </button>
            )}
            {onSendNow && editing !== q.id && (
              <button type="button" className="queue-now" aria-label={`대기 메시지 ${i + 1} ${q.steer ? '멈추고 지금 보내기' : '지금 전송'}`} title={q.steer ? '멈추고 지금 보내기 — 기다리면 저절로 반영됩니다. 누르면 실행 중인 작업을 멈추고 이 메시지로 바로 새로 시작합니다' : '지금 전송 — 실행 중인 턴을 멈추고 이 메시지를 바로 보냅니다'} onClick={() => onSendNow(q.id)}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 13V3.5M4 7.5l4-4 4 4" /></svg>
                <span className="queue-now-label" aria-hidden="true">{q.steer ? '멈추고 지금 보내기' : '지금 전송'}</span>
              </button>
            )}
            <button type="button" className="queue-remove" aria-label={`대기 메시지 ${i + 1} 삭제`} title="대기열에서 빼기" onClick={() => onRemove(q.id)}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
