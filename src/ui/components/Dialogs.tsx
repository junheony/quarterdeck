import { useEffect } from 'react';
import { shortcutList } from '../shortcuts';

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

/** ⌘/ cheat sheet. */
export function ShortcutHelp({ mac, onClose }: { mac: boolean; onClose: () => void }) {
  useEscape(onClose);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal shortcut-help" role="dialog" aria-modal="true" aria-label="단축키">
        <header className="modal-head"><h2>단축키</h2><button type="button" className="icon-btn" aria-label="닫기" onClick={onClose} autoFocus>✕</button></header>
        <dl className="shortcut-list">
          {shortcutList(mac).map((s) => (
            <div key={s.id} className="shortcut-row"><dt><kbd>{s.keys}</kbd></dt><dd>{s.label}</dd></div>
          ))}
          <div className="shortcut-row"><dt><kbd>{mac ? '⌘' : 'Ctrl+'}Enter</kbd></dt><dd>메시지 보내기</dd></div>
          <div className="shortcut-row"><dt><kbd>⇧Tab</kbd></dt><dd>권한 모드 바꾸기 (입력창에서)</dd></div>
          <div className="shortcut-row"><dt><kbd>{mac ? '⌥' : 'Alt+'}↑/↓</kbd></dt><dd>고정 항목 순서 이동 (고정됨 줄의 버튼에서)</dd></div>
          <div className="shortcut-row"><dt><kbd>Esc</kbd></dt><dd>창 닫기</dd></div>
        </dl>
      </div>
    </div>
  );
}

/** A yes/no question (Esc / backdrop = no). */
export function ConfirmDialog({ title, message, confirmLabel, danger = false, onConfirm, onCancel }: {
  title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  useEscape(onCancel);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal confirm" role="alertdialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>취소</button>
          <button type="button" className={`btn ${danger ? 'deny' : 'primary'}`} onClick={onConfirm} autoFocus>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
