import { useEffect, useRef, useState } from 'react';

type Dir = { name: string; path: string };

/** `~/Documents/we` → list `~/Documents/`, keep the subfolders starting with `we`. */
export function splitInput(input: string): { dir: string; prefix: string } {
  if (!input || input === '~') return { dir: '~', prefix: '' };
  const i = input.lastIndexOf('/');
  if (i < 0) return { dir: '~', prefix: input };
  return { dir: input.slice(0, i + 1), prefix: input.slice(i + 1) };
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `요청 실패 (${res.status})`;
}

/** F1: 폴더 열기 — a path with subfolder autocomplete (home only, server-checked) and the recent folders. */
export function FolderPicker({ onOpen, onClose, fetchFn = fetch }: { onOpen: (path: string) => void; onClose: () => void; fetchFn?: typeof fetch }) {
  const [input, setInput] = useState('~/');
  const [dirs, setDirs] = useState<Dir[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const { dir, prefix } = splitInput(input);

  useEffect(() => {
    void fetchFn('/api/recent-folders', { credentials: 'same-origin' })
      .then(async (r) => (r.ok ? ((await r.json()) as { recent: string[] }).recent : []))
      .then(setRecent, () => {});
  }, [fetchFn]);

  useEffect(() => {
    const n = ++seq.current;
    void fetchFn(`/api/dirs?path=${encodeURIComponent(dir)}`, { credentials: 'same-origin' })
      .then(async (r) => (r.ok ? ((await r.json()) as { dirs: Dir[] }).dirs : []))
      .then((d) => { if (n === seq.current) setDirs(d); }, () => { if (n === seq.current) setDirs([]); });
  }, [dir, fetchFn]);

  const open = async (path: string) => {
    setError(null);
    try {
      const res = await fetchFn('/api/recent-folders', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
      if (!res.ok) { setError(await errorOf(res)); return; }
      onOpen(((await res.json()) as { path: string }).path);
    } catch {
      setError('네트워크 오류');
    }
  };

  const shown = dirs.filter((d) => d.name.toLowerCase().startsWith(prefix.toLowerCase()));
  return (
    <div className="folder-picker">
      <div className="folder-picker-row">
        <input
          aria-label="폴더 경로"
          value={input}
          autoFocus
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void open(input); }
            else if (e.key === 'Escape') onClose();
          }}
        />
        <button type="button" className="btn primary" onClick={() => void open(input)}>열기</button>
        <button type="button" className="icon-btn" aria-label="닫기" onClick={onClose}>✕</button>
      </div>
      {error && <div className="error">{error}</div>}
      {shown.length > 0 && (
        <ul className="folder-list">
          {shown.slice(0, 50).map((d) => <li key={d.path} onClick={() => setInput(`${d.path}/`)}>{d.name}</li>)}
        </ul>
      )}
      {recent.length > 0 && (
        <>
          <div className="muted">최근 폴더</div>
          <ul className="folder-list">
            {recent.map((r) => <li key={r} onClick={() => void open(r)}>{r}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}
