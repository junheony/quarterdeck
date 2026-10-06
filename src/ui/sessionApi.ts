import type { EngineKind } from '../shared/models';

/** Mirrors server/sessions/search.ts SearchHit (the UI bundle does not import server code). */
export interface SearchHit {
  sessionId: string;
  title: string;
  cwd: string;
  account: string;
  engine: EngineKind;
  lastModified: number;
  role: 'user' | 'assistant';
  snippet: string;
  matchStart: number;
  matchLength: number;
}

/** Mirrors server/engine/slashCommands.ts SlashCommandInfo. */
export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint: string;
}

async function getJson<T>(url: string, fetchFn: typeof fetch, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(url, { credentials: 'same-origin' });
  } catch {
    throw new Error(`${what} 실패: 네트워크 오류`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${what} 실패 (${res.status})`);
  }
  return (await res.json()) as T;
}

/** Rename (title: string, or null = back to the transcript's own title) and/or 보관; the server broadcasts the new index. */
export async function postSessionMeta(sessionId: string, change: { title?: string | null; archived?: boolean }, fetchFn: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn('/api/session-meta', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, ...change }) });
  } catch {
    throw new Error('세션 정보 저장 실패: 네트워크 오류');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `세션 정보 저장 실패 (${res.status})`);
  }
}

export function searchTranscripts(q: string, fetchFn: typeof fetch = fetch): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  return getJson(`/api/search?q=${encodeURIComponent(q)}`, fetchFn, '검색');
}

export function listFiles(cwd: string, fetchFn: typeof fetch = fetch): Promise<{ files: string[]; truncated: boolean }> {
  return getJson(`/api/files?cwd=${encodeURIComponent(cwd)}`, fetchFn, '파일 목록');
}

export function listCommands(sessionId: string | null, cwd: string | null, fetchFn: typeof fetch = fetch): Promise<{ commands: SlashCommandInfo[] }> {
  const qs = new URLSearchParams();
  if (sessionId) qs.set('sessionId', sessionId);
  if (cwd) qs.set('cwd', cwd);
  return getJson(`/api/commands?${qs.toString()}`, fetchFn, '명령 목록');
}

/** Mirrors TurnRunner.forkStatus: deck's copy and Claude Desktop's (home profile) went separate ways. */
export type ForkStatus = { diverged: boolean; deckAccount?: string; homeAccount?: string };

export function getForkStatus(sessionId: string, fetchFn: typeof fetch = fetch): Promise<ForkStatus> {
  return getJson(`/api/session-fork?sessionId=${encodeURIComponent(sessionId)}`, fetchFn, '사본 확인');
}

/** keep 'deck': Desktop's copy is backed up and replaced by deck's; 'home': the reverse. Nothing is deleted. */
export async function resolveFork(sessionId: string, keep: 'deck' | 'home', fetchFn: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn('/api/session-fork', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, keep }) });
  } catch {
    throw new Error('사본 맞추기 실패: 네트워크 오류');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `사본 맞추기 실패 (${res.status})`);
  }
}

export type OpenInDesktopResult = { ok: true; url: string; busy: boolean } | { ok: false; reason: 'diverged' };

/** Writes deck's copy back into the Desktop profile and returns the `claude://resume` URL to open. */
export async function openInDesktop(sessionId: string, fetchFn: typeof fetch = fetch): Promise<OpenInDesktopResult> {
  let res: Response;
  try {
    res = await fetchFn(`/api/sessions/${encodeURIComponent(sessionId)}/open-in-desktop`, { method: 'POST', credentials: 'same-origin' });
  } catch {
    throw new Error('Desktop 에서 열기 실패: 네트워크 오류');
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Desktop 에서 열기 실패 (${res.status})`);
  return body as OpenInDesktopResult;
}

async function postJson<T>(url: string, body: unknown, fetchFn: typeof fetch, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error(`${what} 실패: 네트워크 오류`);
  }
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(out.error ?? `${what} 실패 (${res.status})`);
  return out;
}

/** 삭제: the transcript moves to the profile's session-trash/ (never unlinked); `trashId` undoes it. */
export function trashSession(sessionId: string, fetchFn: typeof fetch = fetch): Promise<{ trashId: string }> {
  return postJson('/api/session-trash', { sessionId }, fetchFn, '삭제');
}

export function restoreSession(trashId: string, fetchFn: typeof fetch = fetch): Promise<{ sessionId: string }> {
  return postJson('/api/session-trash/restore', { trashId }, fetchFn, '되돌리기');
}

/** Mirrors server/files.ts FilePreview. */
export type FilePreview =
  | { path: string; size: number; kind: 'text'; text: string }
  | { path: string; size: number; kind: 'image'; mediaType: string; base64: string };

/** Side panel: one file of the session folder (the server checks containment and the deny list). */
export function readFile(cwd: string, sessionId: string | null, path: string, fetchFn: typeof fetch = fetch): Promise<FilePreview> {
  const qs = new URLSearchParams({ cwd, path });
  if (sessionId) qs.set('session', sessionId);
  return getJson(`/api/file?${qs}`, fetchFn, '파일 열기');
}
