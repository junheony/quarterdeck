import { useAccounts } from '../accounts';
import { useEffect, useRef, useState } from 'react';
import { getForkStatus, resolveFork, type ForkStatus } from '../sessionApi';

/**
 * Session header 갈라짐 button: shown only when deck's copy of the session and Claude Desktop's
 * (home profile) went separate ways. Either side can be made to match the other; the replaced copy
 * is kept as a `*.deck-fork-<time>` backup. Re-checked when the session changes or a turn ends.
 */
export function ForkMenu({ sessionId, busy, onResolved, onError }: { sessionId: string; busy: boolean; onResolved: () => void; onError: (message: string) => void }) {
  const names = useAccounts();
  const [status, setStatus] = useState<ForkStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [tick, setTick] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (busy) return;
    let alive = true;
    getForkStatus(sessionId).then((s) => { if (alive) setStatus(s); }, () => { if (alive) setStatus(null); });
    return () => { alive = false; };
  }, [sessionId, busy, tick]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  if (!status?.diverged) return null;
  const home = status.homeAccount ? names.label(status.homeAccount) : (names.home?.label ?? 'A');
  const deck = status.deckAccount ? names.label(status.deckAccount) : '';
  const pick = (keep: 'deck' | 'home') => {
    const what = keep === 'deck'
      ? `Desktop(${home}) 쪽 대화를 deck 대화로 바꿉니다. 지금 Desktop 대화는 백업 파일로 남습니다. Desktop 에서 이 세션을 닫은 뒤 진행하세요.`
      : `deck(${deck}) 쪽 대화를 Desktop 대화로 바꿉니다. 지금 deck 대화는 백업 파일로 남습니다.`;
    if (!window.confirm(what)) return;
    setWorking(true);
    resolveFork(sessionId, keep).then(() => { setOpen(false); setTick((t) => t + 1); onResolved(); }, (err: unknown) => onError(err instanceof Error ? err.message : '사본 맞추기 실패')).finally(() => setWorking(false));
  };
  return (
    <div className="fork" ref={ref}>
      <button type="button" className="text-btn fork-btn" aria-expanded={open} aria-haspopup="menu" title="deck 과 Desktop 의 대화가 갈라졌습니다" onClick={() => setOpen((o) => !o)}>갈라짐</button>
      {open && (
        <div className="fork-pop" role="menu">
          <p className="fork-hint">Desktop 에서 따로 이어진 대화가 있어 갈라졌습니다. 어느 쪽으로 맞출까요? 바뀌는 쪽은 백업으로 남습니다.</p>
          <button type="button" role="menuitem" className="btn ghost" disabled={working} onClick={() => pick('deck')}>Desktop 쪽을 deck 대화로 맞추기</button>
          <button type="button" role="menuitem" className="btn ghost" disabled={working || busy} onClick={() => pick('home')}>deck 을 Desktop 대화로 맞추기</button>
        </div>
      )}
    </div>
  );
}
