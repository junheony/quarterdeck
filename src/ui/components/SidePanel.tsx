import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { relPath } from '../diff';
import { listFiles, readFile, type FilePreview } from '../sessionApi';
import { viewFor, type SideDoc } from '../sidePanel';
import { CopyButton } from './CopyButton';
import { DiffList } from './DiffView';
import { Markdown } from './MessageView';

/** The iframe shell served by the server with its own sandboxing CSP (server/http.ts PREVIEW_FRAME_CSP). */
export const PREVIEW_FRAME_SRC = '/api/preview-frame';

/**
 * HTML/SVG preview. `sandbox="allow-scripts"` WITHOUT allow-same-origin: the page runs in an opaque origin, so it can't
 * touch deck's DOM, cookies, storage or WebSocket; the shell's CSP also blocks all network. The markup is posted in
 * once the shell has loaded (srcdoc would inherit deck's own CSP, which forbids the inline scripts/styles a preview needs).
 */
export function HtmlPreview({ html, title }: { html: string; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const sent = useRef(false);
  return (
    <iframe
      ref={ref}
      className="side-frame"
      title={`${title} 미리보기`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={PREVIEW_FRAME_SRC}
      data-testid="html-preview"
      onLoad={() => {
        if (sent.current) return;
        sent.current = true;
        ref.current?.contentWindow?.postMessage(html, '*');
      }}
    />
  );
}

/** Plain text with a line-number gutter (no highlighting here; two <pre>s keep 2 MB files cheap to render). */
function NumberedText({ text }: { text: string }) {
  const count = useMemo(() => text.split('\n').length - (text.endsWith('\n') ? 1 : 0), [text]);
  const gutter = useMemo(() => Array.from({ length: Math.max(1, count) }, (_, i) => i + 1).join('\n'), [count]);
  return (
    <div className="side-code" data-testid="side-text">
      <pre className="side-gutter" aria-hidden="true">{gutter}</pre>
      <pre className="side-lines">{text}</pre>
    </div>
  );
}

/** 파일 button: type (or pick from the @ list) a path of the session folder. */
function FilePick({ cwd, onOpen }: { cwd: string; onOpen: (doc: SideDoc) => void }) {
  const [value, setValue] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    listFiles(cwd).then((r) => { if (live) setFiles(r.files); }, () => {});
    return () => { live = false; };
  }, [cwd]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onOpen({ kind: 'file', path: value.trim() });
  };
  return (
    <form className="side-pick" onSubmit={submit}>
      <label className="muted" htmlFor="side-pick-input">세션 폴더의 파일 경로</label>
      <input id="side-pick-input" list="side-pick-files" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="src/App.tsx" />
      <datalist id="side-pick-files">{files.slice(0, 2000).map((f) => <option key={f} value={f} />)}</datalist>
      <button type="submit" className="btn ghost">열기</button>
    </form>
  );
}

type Tab = '보기' | '미리보기' | '원문' | '변경 사항';

/** Desktop-style right panel of one pane: a file (rendered markdown / image / numbered text, its diff) or a reply's HTML. */
export function SidePanel({ doc, cwd, sessionId, onClose, onOpen }: {
  doc: SideDoc;
  cwd: string;
  sessionId: string | null;
  onClose: () => void;
  onOpen: (doc: SideDoc) => void;
}) {
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<{ key: string; file?: FilePreview; error?: string } | null>(null);
  const filePath = doc.kind === 'file' ? doc.path : null;
  const key = `${filePath}\n${reload}`;
  useEffect(() => {
    if (filePath === null) return;
    let live = true;
    readFile(cwd, sessionId, filePath).then(
      (file) => { if (live) setData({ key, file }); },
      (err: unknown) => { if (live) setData({ key, error: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { live = false; };
  }, [cwd, sessionId, filePath, key]);
  const current = data?.key === key ? data : null;

  const view = filePath ? viewFor(filePath) : 'html';
  const diffs = doc.kind === 'file' ? doc.diffs : undefined;
  const tabs: Tab[] = doc.kind === 'pick' ? [] : doc.kind === 'html' ? ['미리보기', '원문']
    : [...(view === 'markdown' || view === 'image' ? ['보기' as const] : []), ...(view === 'html' ? ['미리보기' as const] : []), ...(view !== 'image' ? ['원문' as const] : []), ...(diffs?.length ? ['변경 사항' as const] : [])];
  const [tab, setTab] = useState<Tab | null>(null);
  // A new document starts on its diff when opened from an edit, else on its first tab.
  const docKey = doc.kind === 'file' ? doc.path : doc.kind === 'html' ? doc.html : '';
  useEffect(() => { setTab(null); }, [docKey]);
  const active: Tab | undefined = tab && tabs.includes(tab) ? tab : diffs?.length ? '변경 사항' : tabs[0];

  const text = doc.kind === 'html' ? doc.html : current?.file?.kind === 'text' ? current.file.text : null;
  const shownPath = doc.kind === 'file' ? relPath(current?.file?.path ?? doc.path, cwd) : doc.kind === 'html' ? doc.title : '파일 열기';
  const fullPath = doc.kind === 'file' ? (current?.file?.path ?? doc.path) : null;

  let body: ReactNode = null;
  if (doc.kind === 'pick') body = <FilePick cwd={cwd} onOpen={onOpen} />;
  else if (active === '변경 사항' && diffs) body = <DiffList diffs={diffs} cwd={cwd} />;
  else if (doc.kind === 'html') body = active === '원문' ? <NumberedText text={doc.html} /> : <HtmlPreview key={reload} html={doc.html} title={doc.title} />;
  else if (!current) body = <div className="side-msg muted">불러오는 중…</div>;
  else if (current.error) body = <div className="side-msg error" role="alert">{current.error}</div>;
  else if (current.file?.kind === 'image') body = <div className="side-image"><img src={`data:${current.file.mediaType};base64,${current.file.base64}`} alt={shownPath} /></div>;
  else if (text !== null) {
    if (active === '보기' && view === 'markdown') body = <div className="side-md"><Markdown text={text} /></div>;
    else if (active === '미리보기') body = <HtmlPreview key={reload} html={text} title={shownPath} />;
    else body = <NumberedText text={text} />;
  }

  return (
    <aside className="side-panel" data-testid="side-panel" aria-label="사이드 패널">
      <div className="side-head">
        <span className="side-path" title={fullPath ?? shownPath}>{shownPath}</span>
        <span className="spacer" />
        {text !== null && <CopyButton text={text} label="내용 복사" />}
        {fullPath && <CopyButton text={fullPath} label="경로 복사" caption="경로 복사" />}
        {doc.kind !== 'pick' && <button type="button" className="icon-btn" aria-label="새로고침" title="새로고침" onClick={() => setReload((n) => n + 1)}>↻</button>}
        <button type="button" className="icon-btn" aria-label="사이드 패널 닫기" title="닫기 (Esc)" onClick={onClose}>✕</button>
      </div>
      {tabs.length > 1 && (
        <div className="side-tabs" role="tablist">
          {tabs.map((t) => <button key={t} type="button" role="tab" aria-selected={t === active} className={t === active ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}
        </div>
      )}
      <div className="side-body">{body}</div>
    </aside>
  );
}
