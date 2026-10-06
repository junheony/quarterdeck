import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { SessionEntry } from '../shared/session-types';
import { AttachmentTooLarge, IMAGE_TYPES, MAX_ATTACHMENT_BYTES, isAttachmentId, type AttachmentStore } from './attachments/AttachmentStore';
import { DirError, listDirs, resolveUnderHome } from './dirs';
import { isAllowedHost, isAllowedOrigin, isAuthed, loginCookieHeader, logoutCookieHeader, tokenMatches } from './auth';
import type { SlashCommandCache } from './engine/slashCommands';
import { FileReadError, type FileLister } from './files';
import type { PushNotifier } from './push/PushNotifier';
import { isPushEndpoint, parseSubscription, type SubscriptionStore } from './push/SubscriptionStore';
import { MAX_PINS, isPinnableId, type PinStore } from './sessions/PinStore';
import { isTrashId } from './sessions/SessionTrash';
import { MAX_TITLE_CHARS, type SessionMetaStore } from './sessions/SessionMetaStore';
import { MAX_QUERY_CHARS, type TranscriptSearch } from './sessions/search';
import type { SessionIndex } from './sessions/SessionIndex';
import type { TurnRunner } from './turn/TurnRunner';
import type { UsageIndex } from './usage/UsageIndex';
import type { UsageService } from './usage/UsageService';

/** Deviation (added per review I5): devOrigins/extraHosts feed the Origin+Host checks below. */
export type HttpDeps = {
  token: string; uiDir: string; usage: UsageService; index: SessionIndex; devOrigins?: string[]; extraHosts?: string[]; extraSessions?: () => SessionEntry[]; attachments?: AttachmentStore;
  /** UI build id as of now (buildId.ts) for GET /api/build: a visible tab polls it to notice a UI-only rebuild. Absent = null. */
  build?: () => string | null;
  /** F1: the folder picker only reaches inside this dir (default: the OS home dir). */
  home?: string;
  /** F1/F2: the project list or pins changed; main broadcasts a fresh `index` to every socket. */
  onIndexChanged?: () => void;
  /** F2: pinned sessions; absent = no /api/pins. */
  pins?: PinStore;
  /** Session rename / 보관 (session-meta.json); absent = no /api/session-meta. */
  meta?: SessionMetaStore;
  /** Full-text transcript search; absent = no /api/search. */
  search?: TranscriptSearch;
  /** Composer @ file picker; absent = no /api/files. */
  files?: FileLister;
  /** Composer / command menu; absent = no /api/commands. */
  commands?: SlashCommandCache;
  /** Web Push (알림); absent = no /api/push/*. */
  push?: { notifier: PushNotifier; store: SubscriptionStore };
  /** Sessions whose deck and Desktop (home profile) copies diverged; absent = no /api/session-fork. */
  forks?: Pick<TurnRunner, 'forkStatus' | 'resolveFork' | 'openInDesktop'>;
  /** 삭제 (move to session-trash) and its undo; absent = no /api/session-trash. */
  trash?: Pick<TurnRunner, 'trashSession' | 'restoreSession'>;
  /** Token usage history (사용량 view); absent = no /api/usage/history. */
  usageHistory?: Pick<UsageIndex, 'history' | 'refresh'>;
};

/** /api/usage/history: how long `refresh=1` waits for the scan before answering with what is indexed so far. */
const USAGE_REFRESH_WAIT_MS = 15_000;
const MAX_USAGE_DAYS = 400;

/**
 * Review I8: sent on every response. Only documents are governed by CSP; in dev the page is
 * served by Vite (its own origin, no CSP from here), so no relaxed dev policy is needed.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; script-src 'self'; worker-src 'self'; manifest-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/** At most 30 /api/diag lines a minute reach the log. */
const diagWindow = { at: 0, n: 0 };
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/** Deviation (added per review I5): SameSite=Strict doesn't separate ports, so every
 * state-changing /api/* request must also prove it came from our own origin (or an
 * explicit dev origin) — a matching Sec-Fetch-Site: same-origin is accepted too. */
function stateChangingOriginOk(req: http.IncomingMessage, devOrigins: string[]): boolean {
  if (req.headers['sec-fetch-site'] === 'same-origin') return true;
  return isAllowedOrigin(req.headers.origin, req.headers.host, devOrigins);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

class BodyTooLarge extends Error {}

/**
 * PF6: on overflow we must NOT call req.destroy() before the 413 response is written — the
 * client then sees "other side closed" and never gets the size message. Instead: stop
 * buffering (discard further chunks) and reject so the caller can respond immediately; the
 * caller is responsible for draining and eventually closing the socket (see drainAndClose).
 */
function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) { cleanup(); reject(new BodyTooLarge()); return; }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = (err: Error) => { cleanup(); reject(err); };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * Fix round 1 finding 1: a real oversized upload (tens of MiB) got ECONNRESET/EPIPE instead of
 * seeing the 413 — writing the response with a `connection: close` header makes Node's own
 * http server auto-destroy the socket on `res` 'finish' (`res._last`/`shouldKeepAlive=false`),
 * which races the still-arriving request body: whatever is left unread in the kernel receive
 * buffer at that moment triggers a TCP RST instead of a clean close, and the client sees the
 * RST before it has necessarily read the 413 body. So the 413 response here never sets
 * `connection: close` (keeping Node's own auto-close path from firing at all), and this
 * function alone owns closing the socket: it keeps consuming (discarding) the body — so the
 * client's still-in-flight upload finishes writing instead of hitting EPIPE — until 'end'
 * (then a graceful half-close), or until a bound (time or bytes) is hit (then a hard destroy).
 * Memory stays flat throughout: chunks are counted, never buffered.
 */
function drainAndClose(req: http.IncomingMessage, opts: { maxDrainBytes?: number; timeoutMs?: number } = {}): void {
  const maxDrainBytes = opts.maxDrainBytes ?? 64 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 5000;
  let drained = 0;
  let done = false;
  const finish = (force: boolean) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    req.removeListener('data', onData);
    req.removeListener('end', onEnd);
    req.removeListener('error', onError);
    const sock = req.socket;
    if (!sock || sock.destroyed) return;
    if (force) sock.destroy();
    else sock.end();
  };
  const onData = (chunk: Buffer) => {
    drained += chunk.length;
    if (drained > maxDrainBytes) finish(true);
  };
  const onEnd = () => finish(false);
  const onError = () => finish(true);
  req.on('data', onData);
  req.on('end', onEnd);
  req.on('error', onError);
  const timer = setTimeout(() => finish(true), timeoutMs);
  timer.unref?.();
  req.resume();
}

/** Writes the 413 (deliberately without `connection: close` — see drainAndClose) then drains. */
function tooLarge(req: http.IncomingMessage, res: http.ServerResponse, message: string): void {
  json(res, 413, { error: message });
  drainAndClose(req);
}

function serveStatic(uiDir: string, urlPath: string, res: http.ServerResponse): void {
  const root = path.resolve(uiDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    json(res, 400, { error: 'bad path' });
    return;
  }
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  let file = path.resolve(root, '.' + normalized);
  if (!file.startsWith(root + path.sep) && file !== root) { json(res, 404, { error: 'not found' }); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  if (!fs.existsSync(file)) { json(res, 503, { error: 'UI 빌드가 없습니다. `npm run build` 를 먼저 실행하세요.' }); return; }
  const rel = path.relative(root, file);
  // PWA: the service worker and manifest are revalidated every time so a new build takes over promptly.
  const cache = rel === 'index.html' ? 'no-store' : rel === 'sw.js' || rel === 'manifest.webmanifest' ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': cache, ...(rel === 'sw.js' ? { 'service-worker-allowed': '/' } : {}) });
  fs.createReadStream(file).pipe(res);
}

/**
 * ux-state: an uploaded IMAGE, for thumbnails in the composer/history. Only ids the store indexed
 * (strict UUID, never a path), only sniffed image types (content-type from the magic bytes, never the
 * client), opened O_NOFOLLOW so a symlink swapped in after indexing is refused. Private cache: the
 * bytes never change for an id.
 */
async function serveAttachment(store: AttachmentStore | undefined, id: string, head: boolean, res: http.ServerResponse): Promise<void> {
  const a = store && isAttachmentId(id) ? store.get(id) : null;
  if (!a || !a.isImage || !IMAGE_TYPES.has(a.mediaType)) { json(res, 404, { error: 'not found' }); return; }
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(a.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    json(res, 404, { error: 'not found' });
    return;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) { json(res, 404, { error: 'not found' }); return; }
    res.writeHead(200, {
      'content-type': a.mediaType,
      'content-length': String(st.size),
      'cache-control': 'private, max-age=604800, immutable',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
    });
    if (head) { res.end(); return; }
    res.end(await fh.readFile());
  } finally {
    await fh.close();
  }
}

/** Side panel HTML preview: the iframe shell (static, no data, so served without the login check). */
export const PREVIEW_FRAME_PATH = '/api/preview-frame';
/**
 * The shell's OWN policy (it replaces SECURITY_HEADERS for this response). `sandbox allow-scripts` forces an opaque
 * origin even if the page is opened directly, so it can never read deck's cookies/storage or call its API as us;
 * no connect-src/img-src http(s) means no fetch/WebSocket/beacon to deck or anywhere else; inline script/style are
 * allowed only here (the previewed page needs them); frame-ancestors 'self' lets only deck embed it.
 */
export const PREVIEW_FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
// The parent posts the HTML once; the shell replaces itself with it (document.write keeps this response's CSP).
const PREVIEW_FRAME_HTML = '<!doctype html><meta charset="utf-8"><script>addEventListener("message",function(e){if(e.source!==parent||typeof e.data!=="string")return;document.open();document.write(e.data);document.close();},{once:true});</script>';

function servePreviewFrame(res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PREVIEW_FRAME_CSP });
  res.end(PREVIEW_FRAME_HTML);
}

export function createRequestHandler(deps: HttpDeps) {
  const devOrigins = deps.devOrigins ?? [];
  const extraHosts = deps.extraHosts ?? [];
  const home = deps.home ?? os.homedir();
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    // Deviation (added per review I5): DNS-rebinding defence — reject any Host deck
    // doesn't itself bind to, even though an attacker-controlled Host would still
    // equal its own Origin and pass the check below.
    if (!isAllowedHost(req.headers.host, extraHosts)) { json(res, 421, { error: `host ${req.headers.host ?? ''} not allowed` }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const authed = isAuthed(req.headers.cookie, deps.token);
    // PWA: behind `tailscale serve` (TLS terminated by tailscaled, proxied to 127.0.0.1) the cookie is marked Secure.
    const secure = req.headers['x-forwarded-proto'] === 'https';
    if (url.pathname.startsWith('/api/') && MUTATING_METHODS.has(req.method ?? '') && !stateChangingOriginOk(req, devOrigins)) {
      json(res, 403, { error: '허용되지 않은 출처입니다' });
      return;
    }
    void (async () => {
      if (url.pathname === '/api/login' && req.method === 'POST') {
        let token = '';
        try { token = String((JSON.parse(await readBody(req)) as { token?: unknown }).token ?? ''); } catch { /* fallthrough */ }
        if (!token || !tokenMatches(token, deps.token)) { json(res, 401, { error: '토큰이 올바르지 않습니다' }); return; }
        json(res, 200, { ok: true }, { 'set-cookie': loginCookieHeader(deps.token, secure) });
        return;
      }
      if (url.pathname === '/api/logout' && req.method === 'POST') { json(res, 200, { ok: true }, { 'set-cookie': logoutCookieHeader(secure) }); return; }
      if (url.pathname === PREVIEW_FRAME_PATH && req.method === 'GET') { servePreviewFrame(res); return; }
      if (url.pathname.startsWith('/api/')) {
        if (!authed) { json(res, 401, { error: '로그인이 필요합니다' }); return; }
        if (url.pathname === '/api/me') { json(res, 200, { ok: true }); return; }
        if (url.pathname === '/api/build' && req.method === 'GET') { json(res, 200, { build: deps.build?.() ?? null }); return; }
        // Device-side layout numbers (shellFit.ts) for a problem that only shows on a real device: one log line, nothing stored.
        if (url.pathname === '/api/diag' && req.method === 'POST') {
          const now = Date.now();
          if (now - diagWindow.at > 60_000) { diagWindow.at = now; diagWindow.n = 0; }
          let body: unknown = null;
          try { body = JSON.parse(await readBody(req, 4096)); } catch { /* invalid below */ }
          if (!body || typeof body !== 'object' || Array.isArray(body)) { json(res, 400, { error: '잘못된 요청입니다' }); return; }
          if (++diagWindow.n <= 30) console.log(`deck: diag ${JSON.stringify(body).slice(0, 2000)}`);
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === '/api/bootstrap') { json(res, 200, { usage: deps.usage.snapshot(), projects: deps.index.projects(deps.extraSessions?.() ?? []), pins: deps.pins?.list() ?? [], desktop: deps.index.desktop() }); return; }
        if (url.pathname === '/api/pins' && req.method === 'POST') {
          if (!deps.pins) { json(res, 404, { error: 'not found' }); return; }
          let body: { sessionId?: unknown; pinned?: unknown } = {};
          try { body = JSON.parse(await readBody(req)) as typeof body; } catch { /* invalid below */ }
          if (!body || !isPinnableId(body.sessionId) || typeof body.pinned !== 'boolean') { json(res, 400, { error: '잘못된 고정 요청입니다' }); return; }
          const pins = await deps.pins.set(body.sessionId, body.pinned);
          deps.onIndexChanged?.();
          json(res, 200, { pins });
          return;
        }
        if (url.pathname === '/api/pins/order' && req.method === 'POST') {
          // 고정됨 drag order: the full list, top first; ids that are not pinned are ignored by the store.
          if (!deps.pins) { json(res, 404, { error: 'not found' }); return; }
          let body: { order?: unknown } = {};
          try { body = JSON.parse(await readBody(req)) as typeof body; } catch { /* invalid below */ }
          if (!body || !Array.isArray(body.order) || body.order.length > MAX_PINS * 2 || !body.order.every(isPinnableId)) { json(res, 400, { error: '잘못된 고정 순서 요청입니다' }); return; }
          const before = deps.pins.list();
          const pins = await deps.pins.reorder(body.order);
          if (pins !== before) deps.onIndexChanged?.(); // an unchanged order is not broadcast
          json(res, 200, { pins });
          return;
        }
        if (url.pathname === '/api/session-meta' && req.method === 'POST') {
          if (!deps.meta) { json(res, 404, { error: 'not found' }); return; }
          let body: { sessionId?: unknown; title?: unknown; archived?: unknown } = {};
          try { body = JSON.parse(await readBody(req)) as typeof body; } catch { /* invalid below */ }
          const titleOk = body?.title === undefined || body.title === null || (typeof body.title === 'string' && body.title.length <= MAX_TITLE_CHARS);
          const archivedOk = body?.archived === undefined || typeof body.archived === 'boolean';
          if (!body || !isPinnableId(body.sessionId) || !titleOk || !archivedOk || (body.title === undefined && body.archived === undefined)) { json(res, 400, { error: '잘못된 세션 정보 요청입니다' }); return; }
          const meta = await deps.meta.update(body.sessionId, { ...(body.title !== undefined ? { title: body.title as string | null } : {}), ...(body.archived !== undefined ? { archived: body.archived as boolean } : {}) });
          deps.index.regroup();
          deps.onIndexChanged?.();
          json(res, 200, { meta });
          return;
        }
        if (url.pathname === '/api/session-fork') {
          if (!deps.forks) { json(res, 404, { error: 'not found' }); return; }
          if (req.method === 'GET') {
            const sessionId = url.searchParams.get('sessionId');
            if (!isPinnableId(sessionId)) { json(res, 400, { error: '잘못된 세션입니다' }); return; }
            json(res, 200, (await deps.forks.forkStatus(sessionId)) ?? { diverged: false });
            return;
          }
          if (req.method === 'POST') {
            let body: { sessionId?: unknown; keep?: unknown } = {};
            try { body = JSON.parse(await readBody(req)) as typeof body; } catch { /* invalid below */ }
            if (!body || !isPinnableId(body.sessionId) || (body.keep !== 'deck' && body.keep !== 'home')) { json(res, 400, { error: '잘못된 요청입니다' }); return; }
            const r = await deps.forks.resolveFork(body.sessionId, body.keep);
            if (!r.ok) { json(res, 409, { error: r.error }); return; }
            await deps.index.refresh();
            deps.onIndexChanged?.();
            json(res, 200, r);
            return;
          }
        }
        if ((url.pathname === '/api/session-trash' || url.pathname === '/api/session-trash/restore') && req.method === 'POST') {
          if (!deps.trash) { json(res, 404, { error: 'not found' }); return; }
          let body: { sessionId?: unknown; trashId?: unknown } = {};
          try { body = JSON.parse(await readBody(req)) as typeof body; } catch { /* invalid below */ }
          const restore = url.pathname.endsWith('/restore');
          if (!body || (restore ? !isTrashId(body.trashId) : !isPinnableId(body.sessionId))) { json(res, 400, { error: '잘못된 삭제 요청입니다' }); return; }
          const r = restore ? await deps.trash.restoreSession(body.trashId as string) : await deps.trash.trashSession(body.sessionId as string);
          if (!r.ok) { json(res, 409, { error: r.error }); return; }
          await deps.index.refresh();
          deps.onIndexChanged?.();
          json(res, 200, r);
          return;
        }
        const openMatch = /^\/api\/sessions\/([^/]+)\/open-in-desktop$/.exec(url.pathname);
        if (openMatch && req.method === 'POST') {
          if (!deps.forks) { json(res, 404, { error: 'not found' }); return; }
          const id = openMatch[1]!;
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) { json(res, 400, { error: '잘못된 세션입니다' }); return; }
          const r = await deps.forks.openInDesktop(id);
          if (r.ok) { json(res, 200, { ok: true, url: `claude://resume?session=${id}`, busy: r.busy }); return; }
          if (r.reason === 'unsupported') { json(res, 400, { error: 'Claude 세션만 Desktop 에서 열 수 있습니다' }); return; }
          if (r.reason === 'diverged') { json(res, 200, { ok: false, reason: 'diverged' }); return; }
          json(res, 500, { error: r.error ?? 'Desktop 사본 갱신 실패' });
          return;
        }
        if (url.pathname === '/api/usage/history' && req.method === 'GET') {
          if (!deps.usageHistory) { json(res, 404, { error: 'not found' }); return; }
          const n = Number(url.searchParams.get('days') ?? 30);
          const days = Number.isInteger(n) ? Math.min(MAX_USAGE_DAYS, Math.max(1, n)) : 30;
          if (url.searchParams.get('refresh') === '1') {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([deps.usageHistory.refresh(), new Promise<void>((r) => { timer = setTimeout(r, USAGE_REFRESH_WAIT_MS); })]);
            clearTimeout(timer);
          }
          json(res, 200, deps.usageHistory.history(days));
          return;
        }
        if (url.pathname === '/api/search' && req.method === 'GET') {
          if (!deps.search) { json(res, 404, { error: 'not found' }); return; }
          const q = url.searchParams.get('q') ?? '';
          if (q.length > MAX_QUERY_CHARS) { json(res, 400, { error: '검색어가 너무 깁니다' }); return; }
          json(res, 200, await deps.search.search(q));
          return;
        }
        if (url.pathname === '/api/file' && req.method === 'GET') {
          if (!deps.files) { json(res, 404, { error: 'not found' }); return; }
          try {
            // A known session's own folder wins over the client's cwd (a new, unsaved session only has the cwd).
            const sid = url.searchParams.get('session');
            const known = sid ? deps.index.projects(deps.extraSessions?.() ?? []).flatMap((p) => p.sessions).find((e) => e.sessionId === sid) : undefined;
            json(res, 200, await deps.files.read(known?.cwd ?? url.searchParams.get('cwd') ?? '', url.searchParams.get('path') ?? ''));
          } catch (err) {
            if (err instanceof DirError) { json(res, 400, { error: err.message }); return; }
            if (err instanceof FileReadError) { json(res, err.status, { error: err.message }); return; }
            throw err;
          }
          return;
        }
        if (url.pathname === '/api/files' && req.method === 'GET') {
          if (!deps.files) { json(res, 404, { error: 'not found' }); return; }
          try {
            json(res, 200, await deps.files.list(url.searchParams.get('cwd') ?? ''));
          } catch (err) {
            if (err instanceof DirError) { json(res, 400, { error: err.message }); return; }
            throw err;
          }
          return;
        }
        if (url.pathname === '/api/commands' && req.method === 'GET') {
          if (!deps.commands) { json(res, 404, { error: 'not found' }); return; }
          json(res, 200, { commands: deps.commands.get(url.searchParams.get('sessionId'), url.searchParams.get('cwd')) });
          return;
        }
        if (url.pathname.startsWith('/api/push/')) {
          const push = deps.push;
          if (!push) { json(res, 404, { error: 'not found' }); return; }
          if (url.pathname === '/api/push/key' && req.method === 'GET') { json(res, 200, { publicKey: push.notifier.publicKey }); return; }
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return; }
          let body: { subscription?: unknown; endpoint?: unknown } = {};
          try { body = (JSON.parse(await readBody(req)) as typeof body) ?? {}; } catch { /* invalid below */ }
          if (url.pathname === '/api/push/subscribe') {
            const sub = parseSubscription(body.subscription);
            if (!sub) { json(res, 400, { error: '지원하지 않는 알림 구독입니다' }); return; }
            await push.store.add(sub);
            json(res, 200, { ok: true });
            return;
          }
          if (!isPushEndpoint(body.endpoint)) { json(res, 400, { error: '잘못된 알림 구독입니다' }); return; }
          const endpoint = body.endpoint;
          if (url.pathname === '/api/push/unsubscribe') { await push.store.remove(endpoint); json(res, 200, { ok: true }); return; }
          if (url.pathname === '/api/push/status') { json(res, 200, { subscribed: push.store.has(endpoint) }); return; }
          if (url.pathname === '/api/push/test') {
            const ok = await push.notifier.sendTo(endpoint, { kind: 'test', title: 'deck', body: '테스트 알림입니다', sessionId: null, tag: 'test' });
            json(res, ok ? 200 : 502, ok ? { ok: true } : { error: '알림을 보내지 못했습니다 (구독이 없거나 전송 실패)' });
            return;
          }
          json(res, 404, { error: 'not found' });
          return;
        }
        if (url.pathname === '/api/dirs' && req.method === 'GET') {
          try {
            json(res, 200, await listDirs(url.searchParams.get('path') || '~', home));
          } catch (err) {
            if (err instanceof DirError) { json(res, 400, { error: err.message }); return; }
            throw err;
          }
          return;
        }
        if (url.pathname === '/api/recent-folders' && req.method === 'GET') { json(res, 200, { recent: deps.index.recent() }); return; }
        if (url.pathname === '/api/recent-folders' && req.method === 'POST') {
          let input = '';
          try { input = String((JSON.parse(await readBody(req)) as { path?: unknown }).path ?? ''); } catch { /* fallthrough */ }
          let real: string;
          try {
            real = await resolveUnderHome(input, home);
          } catch (err) {
            if (err instanceof DirError) { json(res, 400, { error: err.message }); return; }
            throw err;
          }
          const recent = await deps.index.addRecent(real);
          deps.onIndexChanged?.();
          json(res, 200, { path: real, recent });
          return;
        }
        if (url.pathname === '/api/attachments' && req.method === 'POST') {
          if (!deps.attachments) { json(res, 404, { error: 'not found' }); return; }
          // Fix round 1 finding 1(a): a declared Content-Length over the limit is rejected
          // before reading any of the body at all.
          const declaredLength = Number(req.headers['content-length']);
          if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES) {
            tooLarge(req, res, new AttachmentTooLarge().message);
            return;
          }
          let data: Buffer;
          try {
            data = await readRaw(req, MAX_ATTACHMENT_BYTES);
          } catch (err) {
            if (err instanceof BodyTooLarge) { tooLarge(req, res, new AttachmentTooLarge().message); return; }
            throw err;
          }
          let name = 'file';
          try { name = decodeURIComponent(String(req.headers['x-deck-filename'] ?? '')) || 'file'; } catch { /* keep default */ }
          try {
            const a = await deps.attachments.save(name, data);
            json(res, 201, { id: a.id, name: a.name, mediaType: a.mediaType, size: a.size, isImage: a.isImage });
          } catch (err) {
            if (err instanceof AttachmentTooLarge) { json(res, 413, { error: err.message }); return; }
            throw err;
          }
          return;
        }
        if (url.pathname.startsWith('/api/attachments/') && (req.method === 'GET' || req.method === 'HEAD')) {
          await serveAttachment(deps.attachments, url.pathname.slice('/api/attachments/'.length), req.method === 'HEAD', res);
          return;
        }
        json(res, 404, { error: 'not found' });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method not allowed' }); return; }
      serveStatic(deps.uiDir, url.pathname, res);
    })().catch((err: unknown) => {
      // Review M5: details (paths, messages) stay in the server log.
      console.error('deck http: 500', req.method, url.pathname, err);
      if (!res.headersSent) json(res, 500, { error: '서버 내부 오류' });
      else res.destroy();
    });
  };
}
