import { useEffect, useState } from 'react';
import { LONG_HINT, contextHint, contextLabel, contextPct, contextTokens, fmtTokens, isLongContext, type ContextInfo } from '../context';

/** Re-renders every `ms` so time-based hints (cache expiry) appear without new server messages. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const R = 7;
const C = 2 * Math.PI * R;

/** Desktop-style context ring next to the model picker; hover (or tap, on phones) shows "컨텍스트 312k / 1M · 캐시 적중 97%". */
/** The 새 세션으로 이어가기 button; mousedown keeps focus where it is so the popover's blur does not eat the click. */
function HandoffButton({ onHandoff }: { onHandoff: () => void }) {
  return (
    <button type="button" className="handoff-btn" data-testid="handoff-btn" onMouseDown={(e) => e.preventDefault()} onPointerDown={(e) => e.preventDefault()} onClick={onHandoff} title="이 세션의 인계 메모를 쓰고 새 세션에서 이어갑니다">
      새 세션으로 이어가기
    </button>
  );
}

/** `onHandoff` (absent = not offered): 새 세션으로 이어가기 in the popover. */
export function ContextGauge({ info, onHandoff }: { info: ContextInfo | null; onHandoff?: () => void }) {
  const [open, setOpen] = useState(false);
  if (!info) return null;
  const tokens = contextTokens(info.usage);
  const pct = contextPct(tokens, info.window);
  const label = contextLabel(info);
  const level = pct >= 85 ? 'high' : isLongContext(tokens, info.window) ? 'long' : 'ok';
  return (
    <span className="ctx-gauge-wrap">
      <button type="button" className={`ctx-gauge ${level}`} title={label} aria-label={label} aria-expanded={open} data-testid="context-gauge" onClick={() => setOpen((o) => !o)} onBlur={() => setOpen(false)}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle className="ctx-track" cx="9" cy="9" r={R} />
          <circle className="ctx-arc" cx="9" cy="9" r={R} strokeDasharray={`${(C * Math.max(pct, 2)) / 100} ${C}`} transform="rotate(-90 9 9)" />
        </svg>
        <span className="ctx-num">{fmtTokens(tokens)}</span>
      </button>
      {open && (
        <span className="ctx-pop" role="status">
          {label}
          {onHandoff && <HandoffButton onHandoff={() => { setOpen(false); onHandoff(); }} />}
        </span>
      )}
    </span>
  );
}

/** One muted line above the composer: cache expired (next turn re-reads everything) or the session is long. Never blocks. */
export function ContextHint({ info, onHandoff }: { info: ContextInfo | null; onHandoff?: () => void }) {
  const now = useNow(60_000);
  const hint = contextHint(info, now);
  if (!hint) return null;
  return (
    <div className="ctx-hint" data-testid="context-hint">
      {hint}
      {hint === LONG_HINT && onHandoff && <HandoffButton onHandoff={onHandoff} />}
    </div>
  );
}
