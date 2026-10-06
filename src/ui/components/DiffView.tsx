import { useContext, useState } from 'react';
import { SidePanelContext } from '../sidePanel';
import { relPath, type FileDiff } from '../diff';

/** Lines shown before "더 보기". */
export const DIFF_FOLD_AT = 30;

/** Claude-Desktop-style file diff: path header with +N −M, then red/green unified lines (folded past DIFF_FOLD_AT). */
export function DiffCard({ diff, cwd, state }: { diff: FileDiff; cwd?: string | null; state?: string }) {
  const [open, setOpen] = useState(false);
  const shown = open ? diff.lines : diff.lines.slice(0, DIFF_FOLD_AT);
  const hidden = diff.lines.length - shown.length;
  const numbered = diff.lines.some((l) => l.oldNo !== null || l.newNo !== null);
  const openSide = useContext(SidePanelContext);
  return (
    <div className="diff-card" data-testid="diff-card">
      <div className="diff-head" title={diff.path}>
        {openSide && !diff.isDeleted
          ? <button type="button" className="diff-path file-link" title={`${diff.path} — 사이드 패널에서 열기`} onClick={() => openSide({ kind: 'file', path: diff.path, diffs: [diff] })}>{relPath(diff.path, cwd)}</button>
          : <span className="diff-path">{relPath(diff.path, cwd)}</span>}
        {diff.isNew && <span className="diff-tag new">새 파일</span>}
        {diff.isDeleted && <span className="diff-tag del">삭제</span>}
        {state && <span className="tool-state">{state}</span>}
        <span className="grow" />
        {diff.added > 0 && <span className="diff-count add">+{diff.added}</span>}
        {diff.removed > 0 && <span className="diff-count del">−{diff.removed}</span>}
      </div>
      {diff.note && diff.lines.length === 0 && <div className="diff-note muted">{diff.note}</div>}
      {shown.length > 0 && (
        <div className="diff-body" role="table" aria-label={`${relPath(diff.path, cwd)} 변경 내용`}>
          {shown.map((l, i) => l.kind === 'sep'
            ? <div key={i} className="diff-line sep" role="row"><span className="diff-sep-text">{l.text || '⋯'}</span></div>
            : (
              <div key={i} className={`diff-line ${l.kind}`} role="row">
                {numbered && <span className="diff-no" aria-hidden="true">{l.oldNo ?? ''}</span>}
                {numbered && <span className="diff-no" aria-hidden="true">{l.newNo ?? ''}</span>}
                <span className="diff-sign" aria-hidden="true">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                <span className="diff-text">{l.text || ' '}</span>
              </div>
            ))}
        </div>
      )}
      {hidden > 0 && <button type="button" className="more-btn diff-more" onClick={() => setOpen(true)}>더 보기 ({hidden}줄)</button>}
      {open && diff.lines.length > DIFF_FOLD_AT && <button type="button" className="more-btn diff-more" onClick={() => setOpen(false)}>접기</button>}
    </div>
  );
}

export function DiffList({ diffs, cwd, state }: { diffs: FileDiff[]; cwd?: string | null; state?: string }) {
  return <div className="diff-list">{diffs.map((d, i) => <DiffCard key={`${d.path}-${i}`} diff={d} cwd={cwd} {...(i === 0 && state ? { state } : {})} />)}</div>;
}
