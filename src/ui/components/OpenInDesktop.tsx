import { useState } from 'react';
import { openInDesktop } from '../sessionApi';

/** Claude Desktop exists only on macOS; touch clients (iPad reporting as Mac) cannot hand off to it. */
export function canOpenInDesktop(): boolean {
  return typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent) && !('ontouchend' in document);
}

/** Session header button: refreshes the Desktop copy, then hands the session to `claude://resume`. */
export function OpenInDesktop({ sessionId, onError, navigate = (url: string) => { window.location.href = url; } }: { sessionId: string; onError: (message: string) => void; navigate?: (url: string) => void }) {
  const [working, setWorking] = useState(false);
  if (!canOpenInDesktop()) return null;
  const run = async () => {
    setWorking(true);
    try {
      const r = await openInDesktop(sessionId);
      if (!r.ok) { onError('기록이 갈라져 있어 먼저 맞춰야 합니다 (머리글의 \'갈라짐\' 메뉴)'); return; }
      if (r.busy && !window.confirm('deck 에서 아직 작업 중이라 Desktop 이 열기를 거절할 수 있습니다. 계속할까요?')) return;
      navigate(r.url);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Desktop 에서 열기 실패');
    } finally {
      setWorking(false);
    }
  };
  return <button type="button" className="text-btn open-desktop-btn" disabled={working} title="Claude Desktop 에서 이 대화 열기" onClick={() => void run()}>Desktop에서 열기</button>;
}
