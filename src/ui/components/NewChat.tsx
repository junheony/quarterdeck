import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { CODEX_SANDBOXES, DEFAULT_SANDBOX, GEMINI_SANDBOX_LABEL, SANDBOX_LABEL, type CodexSandbox, type EngineChoice } from '../../shared/models';
import type { GeminiStatus } from '../../shared/protocol';
import type { ProjectEntry } from '../../shared/session-types';
import type { UploadedAttachment } from '../state';
import { ATTACHMENT_ONLY_TEXT, filesFrom, uploadFile, useUploads, type UploadFn } from '../upload';
import { AttachMenu, AttachmentBar } from './AttachmentBar';
import { ClaudeMark, EngineMark, engineOf } from './EngineMark';
import { touchEnterIsNewline } from './Chat';
import { useAutoGrow } from '../useAutoGrow';
import { clearDraft, loadDraft, saveDraft } from '../drafts';

const RECENT_CARDS = 4;

export function greeting(hour: number): string {
  if (hour >= 5 && hour < 11) return '좋은 아침이에요';
  if (hour >= 11 && hour < 17) return '좋은 오후예요';
  if (hour >= 17 && hour < 22) return '좋은 저녁이에요';
  return '늦은 시간까지 수고 많아요';
}

function ago(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < 3_600_000) return `${Math.max(1, Math.floor(d / 60_000))}분 전`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}시간 전`;
  return `${Math.floor(d / 86_400_000)}일 전`;
}

const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 4.5c0-.6.4-1 1-1h3.2l1.4 1.5H13c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" />
  </svg>
);

/** The engine and sandbox the new session opens with (D3: the engine is fixed once it exists; a GPT sandbox can change later). */
export type NewChatOptions = { engine: EngineChoice; sandbox: CodexSandbox };

/** Same markup as Chat's composer picker (`.pick`: ellipsizing label over a transparent native select), so the rows match. */
function Pick({ className, label, children, ...rest }: { className?: string; label: ReactNode } & Omit<ComponentProps<'select'>, 'className'>) {
  return (
    <span className={`pick ${className ?? ''}`} data-disabled={rest.disabled ? '' : undefined}>
      <span className="pick-label" aria-hidden="true">{label}</span>
      <select {...rest}>{children}</select>
    </span>
  );
}

/**
 * The empty pane, Desktop-style: greeting, a composer card (auto-growing text; [+] attach, project chip, model, ↑ in
 * its bottom row) and the latest sessions as compact cards. Everything is reachable here, so the phone does not need
 * the drawer to start or resume. Attachments upload as soon as they are picked and ride the first message.
 */
export function NewChat({ projects, defaultCwd, onStart, onOpenSession, now, uploadFn, modelPicker, draftKey = 'new', engine: engineProp = 'claude', sandbox: sandboxProp = DEFAULT_SANDBOX, codexAvailable = false, gemini = null, onEngine, onSandbox }: {
  projects: ProjectEntry[];
  /** Preselected project (the pane's last one); falls back to the first listed. */
  defaultCwd?: string | null;
  /** Opens a new session in `cwd`; non-empty `text` is sent as its first message, with `attachments`. */
  onStart: (cwd: string, name: string, text: string, attachments: UploadedAttachment[], options: NewChatOptions) => void;
  onOpenSession?: (sessionId: string, cwd: string, title: string) => void;
  now?: number;
  uploadFn?: UploadFn;
  /** The pane's model picker: the new session's first turn uses the pane's model. */
  modelPicker?: ReactNode;
  /** Where the unsent text is kept (see drafts.ts); one per pane, e.g. newChatDraftKey(pane.id). */
  draftKey?: string;
  /** The pane's engine/sandbox the pickers start from (a new session follows the picker, as in Chat). */
  engine?: EngineChoice;
  sandbox?: CodexSandbox;
  /** The engine picker appears only when another engine than Claude is available (same rule as Chat). */
  codexAvailable?: boolean;
  gemini?: GeminiStatus | null;
  /** Mirrors a pick to the pane (so its model picker lists the picked engine's models). */
  onEngine?: (engine: EngineChoice) => void;
  onSandbox?: (sandbox: CodexSandbox) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState(() => loadDraft(draftKey));
  const [engine, setEngine] = useState<EngineChoice>(engineProp);
  const [sandbox, setSandbox] = useState<CodexSandbox>(sandboxProp);
  // Follow the pane when it changes the choice itself (e.g. its own picker or a restored pane state).
  useEffect(() => setEngine(engineProp), [engineProp]);
  useEffect(() => setSandbox(sandboxProp), [sandboxProp]);
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [drag, setDrag] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const onUploaded = useCallback((a: UploadedAttachment) => setAttachments((all) => (all.some((x) => x.id === a.id) ? all : [...all, a])), []);
  const { addFiles, uploading, error } = useUploads({ uploadFn: uploadFn ?? uploadFile, current: attachments.length, onUploaded });
  const cwd = picked ?? (defaultCwd && projects.some((p) => p.cwd === defaultCwd) ? defaultCwd : projects[0]?.cwd ?? null);
  const project = projects.find((p) => p.cwd === cwd) ?? null;
  const pinned = projects.filter((p) => p.pinned);
  const others = projects.filter((p) => !p.pinned);
  const recent = projects.flatMap((p) => p.sessions.map((s) => ({ s, name: p.name }))).filter(({ s }) => !s.archived)
    .sort((a, b) => b.s.lastModified - a.s.lastModified)
    .filter((r, i, all) => all.findIndex((x) => x.s.sessionId === r.s.sessionId) === i)
    .slice(0, RECENT_CARDS);
  const t = now ?? Date.now();

  // Auto-grow: the card follows the text up to the CSS max-height, then the textarea scrolls.
  useAutoGrow(taRef, text);
  // Unsent picks: their local previews are released with the screen (a sent turn shows the server copy).
  const unsent = useRef(attachments);
  unsent.current = attachments;
  useEffect(() => () => { for (const a of unsent.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); }, []);

  const hasDraft = text.trim().length > 0 || attachments.length > 0;
  const canStart = !!project && uploading === 0;
  const start = () => {
    if (!project || !canStart) return;
    const msg = text.trim() || (attachments.length ? ATTACHMENT_ONLY_TEXT : '');
    clearDraft(draftKey);
    onStart(project.cwd, project.name, msg, attachments, { engine, sandbox });
  };
  const edit = (v: string) => { setText(v); saveDraft(draftKey, v); };
  const geminiReady = !!gemini && (gemini.loggedIn.g1 || gemini.loggedIn.g2);
  const engineSelect = codexAvailable || !!gemini?.available;
  const sandboxLabel = engine === 'gemini' ? GEMINI_SANDBOX_LABEL : SANDBOX_LABEL;
  const remove = (id: string) => setAttachments((all) => {
    const url = all.find((a) => a.id === id)?.previewUrl;
    if (url) URL.revokeObjectURL(url);
    return all.filter((a) => a.id !== id);
  });
  const option = (p: ProjectEntry) => <option key={p.cwd} value={p.cwd}>{p.name}</option>;
  const sendLabel = hasDraft ? '보내기 — 새 대화로 시작 (Enter)' : '빈 새 대화 열기';

  return (
    <div className="newchat">
      <div className="newchat-inner">
        <h1 className="newchat-greeting"><ClaudeMark className="spark" />{greeting(new Date(t).getHours())}</h1>
        {projects.length === 0 ? (
          <p className="muted">프로젝트가 없습니다. 사이드바의 폴더 열기로 시작하거나 ~/.config/deck/projects.json 에 고정 프로젝트를 적어두세요.</p>
        ) : (
          <form className={`newchat-box ${drag ? 'dragover' : ''}`} onSubmit={(e) => { e.preventDefault(); start(); }}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); const files = filesFrom(e.dataTransfer); if (files.length) void addFiles(files); }}>
            <textarea ref={taRef} value={text} onChange={(e) => edit(e.target.value)} rows={2} placeholder="무엇을 도와드릴까요?" aria-label="첫 메시지"
              name="deck-message" autoComplete="off" data-1p-ignore="" data-lpignore="true"
              onPaste={(e) => { const files = filesFrom(e.clipboardData); if (files.length) { e.preventDefault(); void addFiles(files); } }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!e.shiftKey && !e.altKey && !touchEnterIsNewline()))) { e.preventDefault(); start(); }
              }} />
            {(attachments.length > 0 || uploading > 0 || error) && (
              <div className="newchat-files"><AttachmentBar attachments={attachments} uploading={uploading} error={error} onRemove={remove} /></div>
            )}
            <div className="newchat-row">
              <AttachMenu onFiles={(f) => void addFiles(f)} />
              <label className="newchat-project" title={cwd ?? ''}>
                <FolderIcon />
                <span className="sr-only">프로젝트</span>
                <select value={cwd ?? ''} onChange={(e) => setPicked(e.target.value)} aria-label="프로젝트">
                  {pinned.length > 0 && <optgroup label="고정">{pinned.map(option)}</optgroup>}
                  {others.length > 0 && <optgroup label="최근">{others.map(option)}</optgroup>}
                </select>
              </label>
              <span className="newchat-actions">
                {engineSelect && (
                  <Pick label={engine === 'codex' ? 'GPT' : engine === 'gemini' ? 'Gemini' : engine === 'auto' ? '자동' : 'Claude'} value={engine}
                    onChange={(e) => { const v = e.target.value as EngineChoice; setEngine(v); onEngine?.(v); }} title="이 세션의 엔진 (세션 생성 후 변경 불가)" aria-label="엔진" data-testid="engine-select">
                    <option value="claude">Claude</option>
                    {codexAvailable && <option value="codex">GPT</option>}
                    {gemini?.available && <option value="gemini" disabled={!geminiReady} title={geminiReady ? undefined : 'docs/gemini-spike.md 의 로그인 명령을 먼저 실행하세요'}>{geminiReady ? 'Gemini' : 'Gemini · 로그인 필요'}</option>}
                    {codexAvailable && <option value="auto">자동</option>}
                  </Pick>
                )}
                {engineSelect && engine !== 'claude' && (
                  <Pick className="sandbox" label={sandboxLabel[sandbox]} value={sandbox} onChange={(e) => { const v = e.target.value as CodexSandbox; setSandbox(v); onSandbox?.(v); }}
                    title={engine === 'gemini' ? 'Gemini 승인 모드 (승인 카드 없음 · 세션 생성 후 변경 불가)' : 'GPT 샌드박스 (승인 카드 없음 · 세션을 만든 뒤에도 바꿀 수 있음)'} aria-label="샌드박스" data-testid="sandbox-select">
                    {CODEX_SANDBOXES.map((x) => <option key={x} value={x}>{sandboxLabel[x]}</option>)}
                  </Pick>
                )}
                {modelPicker}
                <button type="submit" className="send" disabled={!canStart} title={sendLabel} aria-label={sendLabel}><span aria-hidden="true">↑</span></button>
              </span>
            </div>
          </form>
        )}
        {recent.length > 0 && onOpenSession && (
          <section className="newchat-recent" aria-label="최근 대화">
            <h2 className="muted">최근 대화</h2>
            <div className="newchat-cards">
              {recent.map(({ s, name }) => (
                <button type="button" key={s.sessionId} className="newchat-card" title={`${s.title}\n${s.cwd}`} onClick={() => onOpenSession(s.sessionId, s.cwd, s.title)}>
                  <span className="newchat-card-title"><EngineMark engine={engineOf(s)} decorative />{s.title}</span>
                  <span className="newchat-card-meta">{name} · {ago(s.lastModified, t)}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
