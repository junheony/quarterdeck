import { useEffect, useRef, useState } from 'react';
import { disablePush, enablePush, isIos, pushBlocker, pushEnabled, testPush } from '../push';

const BLOCKER_TEXT = {
  insecure: '알림은 HTTPS 주소에서만 됩니다. https://<맥 이름>.ts.net 으로 여세요.',
  'ios-install': 'iPhone·iPad 는 공유 → "홈 화면에 추가" 로 설치한 앱에서만 알림이 됩니다 (iOS 16.4 이상).',
  unsupported: '이 브라우저는 웹 푸시 알림을 지원하지 않습니다.',
} as const;

/** Topbar 알림 button: per-device Web Push on/off, a test push, and why it can't work here when it can't. */
export function NotifyMenu() {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const blocker = pushBlocker();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || blocker) return;
    void pushEnabled().then(setOn, () => setOn(false));
  }, [open, blocker]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const run = (fn: () => Promise<void>, done: string | null) => {
    setBusy(true);
    setNote(null);
    fn().then(() => setNote(done), (err: unknown) => setNote(err instanceof Error ? err.message : '실패')).finally(() => setBusy(false));
  };
  const toggle = () => run(async () => {
    if (on) { await disablePush(); setOn(false); } else { await enablePush(); setOn(true); }
  }, null);

  return (
    <div className="notify" ref={ref}>
      <button type="button" className="text-btn notify-btn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)} title="알림 설정">
        알림
      </button>
      {open && (
        <div className="notify-pop" role="dialog" aria-label="알림 설정">
          {blocker ? (
            <p className="notify-hint">{BLOCKER_TEXT[blocker]}</p>
          ) : (
            <>
              <button type="button" className={`notify-toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on === true} disabled={busy || on === null} onClick={toggle}>
                <span className="switch-track" aria-hidden="true"><span className="switch-knob" /></span>
                <span>알림 {on === null ? '확인 중…' : on ? '켜짐' : '꺼짐'}</span>
              </button>
              <p className="notify-hint">턴 완료 · 질문/권한 카드 대기 · 백그라운드 작업 완료를 이 기기로 알려 줍니다. deck 창을 보고 있을 때는 띄우지 않습니다.</p>
              <button type="button" className="btn ghost notify-test" disabled={busy || !on} onClick={() => run(testPush, '테스트 알림을 보냈습니다')}>테스트 알림</button>
              {isIos() && <p className="notify-hint">iPhone: 설치한 앱(홈 화면)에서 켜야 합니다 · iOS 16.4 이상.</p>}
            </>
          )}
          {note && <p className="notify-note" role="status">{note}</p>}
        </div>
      )}
    </div>
  );
}
