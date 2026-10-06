import { ACCOUNT_ID_RE, RESERVED_ACCOUNT_IDS, type Account } from '../shared/accounts';
import { CODEX_SANDBOXES, DEFAULT_EFFORT, isClaudeModel, isCodexModel, isEffort, isGeminiModel, type CodexSandbox, type Effort, type EngineChoice, type EngineKind, type ModelChoice } from '../shared/models';
import { ATTACHMENT_ID, MAX_ATTACHMENTS_PER_TURN } from '../shared/protocol';
import { MAX_PANES, newPane, nextQueueId, parkKey, type AppState, type ChatItem, type PaneState, type QueueItem, type SentFile, type SentRecord, type UploadedAttachment } from './state';

/**
 * ux-state: UI state that survives a reload (localStorage, per browser — phone and desktop are independent).
 * Everything read back is untrusted: each field is validated on its own and a bad one falls back to its
 * default, so one corrupt value never costs the rest (and never throws).
 */
export const UI_KEY = 'deck.ui.v1';
export const SENT_KEY = 'deck.sent.v1';

export type PersistedSession = { sessionId: string | null; cwd: string; title: string; engine: EngineKind | null };
/** `autoEffort`: the effort picked while the model is 자동 (null = 자동 too). */
/**
 * `handoffFrom` / `prefill`: a pending 새 세션으로 이어가기 — the new session has no id (it exists only once its first
 * send runs), so the link to its predecessor and the note waiting in the composer live only here until then.
 * `accountPin`: likewise the pin an id-less session sends with its first turn (an existing session's pin is the server's).
 */
export type PersistedPane = { session: PersistedSession | null; model: ModelChoice; /** PaneState.modelPicked (absent: not picked). */ modelPicked?: true; efforts: Record<EngineKind, Effort>; autoEffort: Effort | null; engine: EngineChoice; sandbox: CodexSandbox; handoffFrom?: { sessionId: string; title: string }; prefill?: string; accountPin?: Account };
export type PersistedUi = { v: 1; panes: PersistedPane[]; active: number; collapsed: string[]; drawer: boolean };

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): Store | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const shortStr = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max;
const ENGINES: readonly EngineChoice[] = ['claude', 'codex', 'gemini', 'auto'];
const isModelChoice = (x: unknown): x is ModelChoice => x === 'auto' || isClaudeModel(x) || isCodexModel(x) || isGeminiModel(x);

function readJson(key: string, store: Store | null): unknown {
  try {
    const raw = store?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown, store: Store | null): void {
  try { store?.setItem(key, JSON.stringify(value)); } catch { /* quota / private mode: persistence is best-effort */ }
}

function session(x: unknown): PersistedSession | null {
  if (!isObj(x) || !shortStr(x.cwd, 4096) || !x.cwd.startsWith('/')) return null;
  const sessionId = x.sessionId === null ? null : shortStr(x.sessionId, 200) && x.sessionId ? x.sessionId : undefined;
  if (sessionId === undefined) return null;
  const title = shortStr(x.title, 500) ? x.title : (sessionId?.slice(0, 8) ?? '새 세션');
  const engine = x.engine === 'claude' || x.engine === 'codex' || x.engine === 'gemini' ? x.engine : null;
  return { sessionId, cwd: x.cwd, title, engine };
}

function pane(x: unknown): PersistedPane {
  const d = newPane('');
  if (!isObj(x)) return { session: null, model: d.model, efforts: { ...DEFAULT_EFFORT }, autoEffort: null, engine: d.engine, sandbox: d.sandbox };
  const e = isObj(x.efforts) ? x.efforts : {};
  const sess = session(x.session);
  const hf = isObj(x.handoffFrom) ? x.handoffFrom : null;
  const pending = sess !== null && sess.sessionId === null;
  return {
    session: sess,
    model: isModelChoice(x.model) ? x.model : d.model,
    ...(x.modelPicked === true ? { modelPicked: true as const } : {}),
    efforts: { claude: isEffort(e.claude) ? e.claude : DEFAULT_EFFORT.claude, codex: isEffort(e.codex) ? e.codex : DEFAULT_EFFORT.codex, gemini: isEffort(e.gemini) ? e.gemini : DEFAULT_EFFORT.gemini },
    autoEffort: isEffort(x.autoEffort) ? x.autoEffort : null,
    engine: ENGINES.includes(x.engine as EngineChoice) ? (x.engine as EngineChoice) : d.engine,
    sandbox: CODEX_SANDBOXES.includes(x.sandbox as CodexSandbox) ? (x.sandbox as CodexSandbox) : d.sandbox,
    ...(pending && hf && shortStr(hf.sessionId, 200) && hf.sessionId && shortStr(hf.title, 500) ? { handoffFrom: { sessionId: hf.sessionId, title: hf.title } } : {}),
    ...(pending && shortStr(x.prefill, 100_000) && x.prefill ? { prefill: x.prefill } : {}),
    ...(pending && typeof x.accountPin === 'string' && ACCOUNT_ID_RE.test(x.accountPin) && !RESERVED_ACCOUNT_IDS.includes(x.accountPin) ? { accountPin: x.accountPin } : {}),
  };
}

/** Validates (and migrates) whatever is stored; null = nothing usable, start fresh. */
export function parseUi(raw: unknown): PersistedUi | null {
  if (!isObj(raw)) return null;
  // Only v1 exists; an unknown version is dropped rather than guessed at.
  if (raw.v !== 1) return null;
  const panes = Array.isArray(raw.panes) ? raw.panes.slice(0, MAX_PANES).map(pane) : [];
  if (!panes.length) return null;
  const active = Number.isInteger(raw.active) && (raw.active as number) >= 0 && (raw.active as number) < panes.length ? (raw.active as number) : 0;
  const collapsed = Array.isArray(raw.collapsed) ? raw.collapsed.filter((c): c is string => shortStr(c, 4096)).slice(0, 200) : [];
  return { v: 1, panes, active, collapsed, drawer: raw.drawer === true };
}

export function loadUi(store: Store | null = storage()): PersistedUi | null {
  return parseUi(readJson(UI_KEY, store));
}

export function snapshotUi(state: AppState, extra: { collapsed: string[]; drawer: boolean }): PersistedUi {
  return {
    v: 1,
    panes: state.panes.map((p) => ({
      session: p.session ? { sessionId: p.session.sessionId, cwd: p.session.cwd, title: p.session.title, engine: p.session.engine } : null,
      model: p.model, ...(p.modelPicked ? { modelPicked: true as const } : {}), efforts: p.efforts, autoEffort: p.autoEffort, engine: p.engine, sandbox: p.sandbox,
      ...(p.session && p.session.sessionId === null && p.handoffFrom ? { handoffFrom: p.handoffFrom } : {}),
      ...(p.session && p.session.sessionId === null && p.prefill ? { prefill: p.prefill } : {}),
      ...(p.session && p.session.sessionId === null && p.session.accountPin ? { accountPin: p.session.accountPin } : {}),
    })),
    active: Math.max(0, state.panes.findIndex((p) => p.id === state.activePaneId)),
    collapsed: extra.collapsed,
    drawer: extra.drawer,
  };
}

/** Writes only when the serialized value changed; returns what is stored now (feed it back as `last`). */
export function saveUi(ui: PersistedUi, last: string | null = null, store: Store | null = storage()): string {
  const json = JSON.stringify(ui);
  if (json !== last) { try { store?.setItem(UI_KEY, json); } catch { /* best-effort */ } }
  return json;
}

/** The app's start state: panes (sessions, pickers) restored; the sessions themselves are re-opened on `hello`. */
export function hydrate(base: AppState, ui: PersistedUi | null, queues: PersistedQueues | null = null): AppState {
  if (!ui) return withQueues(base, queues);
  const panes: PaneState[] = ui.panes.map((p, i) => ({
    ...newPane(`p${i}`),
    session: p.session ? { ...p.session, account: null, sandbox: null, ...(p.accountPin ? { accountPin: p.accountPin } : {}) } : null,
    model: p.model, modelPicked: p.modelPicked === true, efforts: { ...p.efforts }, autoEffort: p.autoEffort, engine: p.engine, sandbox: p.sandbox,
    handoffFrom: p.handoffFrom ?? null, prefill: p.prefill ?? null,
    // Its history is asked for again once the socket is up: loading until it arrives.
    ...(p.session?.sessionId ? { loading: true } : {}),
  }));
  return withQueues({ ...base, panes, activePaneId: panes[ui.active]?.id ?? panes[0]!.id }, queues);
}

// --- queued messages (sessionStorage: per tab, so two tabs never send each other's queue) ---

export const QUEUE_KEY = 'deck.queues.v1';
/**
 * A queued message (QueueItem minus its per-page id): `restart` = held back by a restarting server, sent after the reconnect;
 * `maybeSent` = may have gone in as that user message (QueueItem); `lostSteer` = a steer whose answer was lost; `ref` = the
 * clientRef it was sent with (checked against the server's acceptedRefs); `at` = when it was sent (ms); `kept` = came back
 * from a parked bucket (QueueItem).
 */
export type PersistedQueueItem = { text: string; attachments: UploadedAttachment[]; restart?: true; maybeSent?: number; lostSteer?: string; ref?: string; at?: number; kept?: true };
/**
 * A pane's queue, kept with its session so it only ever comes back into that session: `pane` = the pane it sat in
 * (null = parked: its pane left the session; a parked new session's comes back into the next new session in `cwd`).
 * The server may restart (and the page reload) before it goes out.
 */
export type PersistedQueue = { pane: number | null; sessionId: string | null; cwd: string; queue: PersistedQueueItem[]; paused?: true };
export type PersistedQueues = { v: 1; queues: PersistedQueue[] };

type QueueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function tabStorage(): QueueStore | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

const MAX_QUEUE = 50;

function queueItem(x: unknown): PersistedQueueItem | null {
  if (!isObj(x) || !shortStr(x.text, 200_000) || !Array.isArray(x.attachments)) return null;
  const attachments = x.attachments.slice(0, MAX_ATTACHMENTS_PER_TURN).flatMap((a): UploadedAttachment[] => {
    if (!isObj(a) || !shortStr(a.id, 64) || !ATTACHMENT_ID.test(a.id) || !shortStr(a.name, 300)) return [];
    return [{ id: a.id, name: a.name, size: typeof a.size === 'number' && a.size >= 0 ? a.size : 0, isImage: a.isImage === true }];
  });
  if (!x.text && !attachments.length) return null;
  return {
    text: x.text, attachments,
    ...(x.restart === true ? { restart: true as const } : {}),
    ...(Number.isInteger(x.maybeSent) && (x.maybeSent as number) >= 0 ? { maybeSent: x.maybeSent as number } : {}),
    ...(shortStr(x.lostSteer, 64) && x.lostSteer ? { lostSteer: x.lostSteer } : {}),
    ...(shortStr(x.ref, 64) && x.ref ? { ref: x.ref } : {}),
    ...(typeof x.at === 'number' && Number.isFinite(x.at) && x.at > 0 ? { at: x.at } : {}),
    ...(x.kept === true ? { kept: true as const } : {}),
  };
}

export function parseQueues(raw: unknown): PersistedQueues | null {
  if (!isObj(raw) || raw.v !== 1 || !Array.isArray(raw.queues)) return null;
  const queues = raw.queues.slice(0, 100).flatMap((x): PersistedQueue[] => {
    if (!isObj(x) || !shortStr(x.cwd, 4096) || !x.cwd.startsWith('/') || !Array.isArray(x.queue)) return [];
    const sessionId = x.sessionId === null ? null : shortStr(x.sessionId, 200) && x.sessionId ? x.sessionId : undefined;
    const pane = Number.isInteger(x.pane) && (x.pane as number) >= 0 && (x.pane as number) < MAX_PANES ? (x.pane as number) : null;
    if (sessionId === undefined) return [];
    const queue = x.queue.slice(0, MAX_QUEUE).map(queueItem).filter((q): q is PersistedQueueItem => !!q);
    return queue.length ? [{ pane, sessionId, cwd: x.cwd, queue, ...(x.paused === true ? { paused: true as const } : {}) }] : [];
  });
  return { v: 1, queues };
}

export function loadQueues(store: QueueStore | null = tabStorage()): PersistedQueues | null {
  return parseQueues(readJson(QUEUE_KEY, store));
}

/** A steer still in flight comes back as a lost one (its answer goes to this page's socket), so the queue waits for the user. */
function persistQueue(queue: QueueItem[]): PersistedQueueItem[] {
  return queue.map((q) => ({
    text: q.text,
    attachments: q.attachments.map(({ id, name, size, isImage }) => ({ id, name, size, isImage })),
    ...(q.restart ? { restart: true as const } : {}),
    ...(q.maybeSent !== undefined ? { maybeSent: q.maybeSent } : {}),
    ...(q.steer || q.lostSteer ? { lostSteer: (q.steer ?? q.lostSteer)! } : {}),
    ...(q.ref ? { ref: q.ref } : {}),
    ...(q.at !== undefined ? { at: q.at } : {}),
    ...(q.kept ? { kept: true as const } : {}),
  }));
}

/**
 * A send still waiting for its turn_started (a reload, or the page going away, before the answer): saved at the head of
 * its queue like one whose socket died — checked against the history after the reload. Without a session id or an
 * ordinal it cannot be checked: a plain item, and the queue waits for the user.
 */
function awaiting(p: PaneState): { item: PersistedQueueItem; checkable: boolean } | null {
  const a = p.awaitingSend;
  if (!p.awaitingStart || !p.awaitingRef || !a) return null;
  const checkable = !!p.session?.sessionId && a.n !== undefined && !a.branch;
  const item: PersistedQueueItem = {
    text: a.text, attachments: a.attachments.map(({ id, name, isImage }) => ({ id, name, size: 0, isImage })),
    ...(checkable ? { restart: true as const, maybeSent: a.n! } : {}),
    ref: p.awaitingRef, ...(a.at !== undefined ? { at: a.at } : {}),
  };
  return { item, checkable };
}

export function snapshotQueues(state: AppState): PersistedQueues {
  const panes = state.panes.flatMap((p, i): PersistedQueue[] => {
    const head = awaiting(p);
    if (!p.session || (!p.queue.length && !head)) return [];
    const paused = p.queuePaused || p.queue.some((q) => q.steer) || (!!head && !head.checkable);
    return [{ pane: i, sessionId: p.session.sessionId, cwd: p.session.cwd, queue: [...(head ? [head.item] : []), ...persistQueue(p.queue)], ...(paused ? { paused: true as const } : {}) }];
  });
  const parked = Object.entries(state.parked).map(([key, b]): PersistedQueue => ({ pane: null, sessionId: key === parkKey(null, b.cwd) ? null : key, cwd: b.cwd, queue: persistQueue(b.queue), paused: true }));
  return { v: 1, queues: [...panes, ...parked] };
}

/**
 * Writes only when the serialized value changed; returns what is stored now (feed it back as `last`). A failed write
 * (quota) removes the stored copy instead — an older queue must never come back after a reload and send again what
 * already went out — and returns null, so the next change tries again.
 */
export function saveQueues(q: PersistedQueues, last: string | null = null, store: QueueStore | null = tabStorage()): string | null {
  const json = JSON.stringify(q);
  if (json === last) return last;
  try {
    store?.setItem(QUEUE_KEY, json);
    return json;
  } catch (err) {
    console.warn('deck: queued messages could not be saved for a reload', err);
    try { store?.removeItem(QUEUE_KEY); } catch { /* storage unavailable */ }
    return null;
  }
}

/**
 * Stored queues back into the panes still showing their session (fresh ids: they are per page). A message held for the
 * restart waits for this page's first reconnect; an id-less session's queue (its first send may have made the session)
 * waits for the user. A queue whose pane shows something else now is parked with its session (no id: with its folder).
 */
function withQueues(state: AppState, stored: PersistedQueues | null): AppState {
  if (!stored?.queues.length) return state;
  const panes = state.panes.slice();
  const filled = new Set<number>();
  const parked = { ...state.parked };
  const shows = (i: number, q: PersistedQueue) => !filled.has(i) && panes[i]?.session?.sessionId === q.sessionId && panes[i]!.session!.cwd === q.cwd;
  for (const q of stored.queues) {
    const at = q.pane !== null && shows(q.pane, q) ? q.pane : q.pane !== null ? panes.findIndex((_, i) => shows(i, q)) : -1;
    const fresh = (keepHold: boolean) => q.queue.map(({ restart, ...item }): QueueItem => ({ ...item, id: nextQueueId(), ...(restart && keepHold ? { restart: 'hold' as const } : {}) }));
    if (at >= 0) {
      filled.add(at);
      panes[at] = { ...panes[at]!, queue: fresh(q.sessionId !== null), queuePaused: q.paused === true || q.sessionId === null };
    } else {
      const key = parkKey(q.sessionId, q.cwd);
      parked[key] = { cwd: q.cwd, queue: [...(parked[key]?.queue ?? []), ...fresh(false)] };
    }
  }
  return { ...state, panes, parked };
}

// --- sent attachments per session (thumbnails for reloaded transcripts) ---

const MAX_SESSIONS = 50;
const MAX_RECORDS = 40;
type SentMap = Record<string, { at: number; records: SentRecord[] }>;

function sentFile(x: unknown): SentFile | null {
  if (!isObj(x) || !shortStr(x.id, 64) || !/^[0-9a-f-]{36}$/.test(x.id) || !shortStr(x.name, 300)) return null;
  return { id: x.id, name: x.name, isImage: x.isImage === true };
}

function sentMap(raw: unknown): SentMap {
  const out: SentMap = {};
  if (!isObj(raw)) return out;
  for (const [sid, v] of Object.entries(raw)) {
    if (!isObj(v) || !Array.isArray(v.records) || sid.length > 200) continue;
    const records = v.records.flatMap((r): SentRecord[] => {
      if (!isObj(r) || !shortStr(r.text, 100_000) || !Array.isArray(r.files)) return [];
      const files = r.files.map(sentFile).filter((f): f is SentFile => !!f);
      return files.length ? [{ text: r.text, files }] : [];
    });
    if (records.length) out[sid] = { at: typeof v.at === 'number' ? v.at : 0, records: records.slice(-MAX_RECORDS) };
  }
  return out;
}

export function loadSent(sessionId: string, store: Store | null = storage()): SentRecord[] {
  return sentMap(readJson(SENT_KEY, store))[sessionId]?.records ?? [];
}

/** Records every user item with files of every pane that has a session id (merging, newest sessions kept). */
export function saveSent(panes: PaneState[], now = Date.now(), store: Store | null = storage()): void {
  const fresh = panes.flatMap((p) => {
    const sid = p.session?.sessionId;
    if (!sid) return [];
    const records = p.items.flatMap((it: ChatItem): SentRecord[] => (it.kind === 'user' && it.attachments?.length ? [{ text: it.text, files: it.attachments }] : []));
    return records.length ? [[sid, records] as const] : [];
  });
  if (!fresh.length) return;
  const map = sentMap(readJson(SENT_KEY, store));
  let changed = false;
  for (const [sid, records] of fresh) {
    const prev = map[sid]?.records ?? [];
    const merged = [...prev];
    for (const r of records) if (!merged.some((m) => m.text === r.text && m.files[0]?.id === r.files[0]?.id)) { merged.push(r); changed = true; }
    if (merged.length !== prev.length) map[sid] = { at: now, records: merged.slice(-MAX_RECORDS) };
  }
  if (!changed) return;
  const kept = Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_SESSIONS);
  writeJson(SENT_KEY, Object.fromEntries(kept), store);
}
