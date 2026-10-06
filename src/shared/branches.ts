/**
 * 메시지 편집 갈래 (Desktop's "edit a past message"): editing user message `n` of a session forks a new session
 * that shares the history before that message. deck records each branch child → { parent, n } (session-meta.json);
 * everything else — which versions exist at a message, which one a session shows, the sidebar grouping — is derived.
 *
 * `n` is the message's ordinal among the session's user messages (0 = the first). A child made at `n` shares
 * messages 0…n-1 with its parent and has its own message n onward.
 */
export type BranchLink = { parent: string; n: number };
/** child session id → link; insertion order = creation order. */
export type BranchLinks = Record<string, BranchLink>;

const MAX_DEPTH = 1000;

/** The session whose own copy message `n` is, seen from `id`: walk up while `id` only inherited that message. */
function ownerAt(links: BranchLinks, id: string, n: number): string {
  let s = id;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const l = links[s];
    if (!l || l.n <= n) return s;
    s = l.parent;
  }
  return s;
}

/** The original version of message `n` among the versions `owner` (an owner of message n) is one of. */
function baseAt(links: BranchLinks, owner: string, n: number): string {
  let s = owner;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const l = links[s];
    if (!l || l.n !== n) return s;
    s = ownerAt(links, l.parent, n);
  }
  return s;
}

/**
 * The versions of message `n` as seen from session `id`, oldest first, and which one `id` shows.
 * Null when there is only one version.
 */
export function versionsAt(links: BranchLinks, id: string, n: number): { members: string[]; index: number } | null {
  const own = ownerAt(links, id, n);
  const base = baseAt(links, own, n);
  const members = [base];
  for (const [child, l] of Object.entries(links)) {
    if (l.n === n && child !== base && baseAt(links, ownerAt(links, l.parent, n), n) === base) members.push(child);
  }
  if (members.length < 2) return null;
  const index = members.indexOf(own);
  return { members, index: index < 0 ? 0 : index };
}

/** The session at the top of `id`'s branch tree (itself when it is no branch). */
export function branchRoot(links: BranchLinks, id: string): string {
  let s = id;
  const seen = new Set<string>();
  while (links[s] && !seen.has(s)) {
    seen.add(s);
    s = links[s]!.parent;
  }
  return s;
}

/** `links` from index entries that carry their own `branch` link. */
export function linksOf(entries: Iterable<{ sessionId: string; branch?: BranchLink }>): BranchLinks {
  const out: BranchLinks = {};
  for (const e of entries) if (e.branch) out[e.sessionId] = e.branch;
  return out;
}

export type BranchGroup<T> = {
  /** The row shown: the tree's root (or its oldest listed member when the root is not listed), dated by the newest member. */
  entry: T;
  /** The session a click opens: the newest member. */
  openId: string;
  /** Every listed session of the tree. */
  members: string[];
};

/**
 * Sidebar: one row per branch tree (sessions without branches are trees of one). Sorted newest first, like the input.
 * `links` should cover every listed session (an entry's own `branch`), so trees spanning several lists still group.
 */
export function groupBranches<T extends { sessionId: string; lastModified: number }>(sessions: T[], links: BranchLinks): BranchGroup<T>[] {
  const byRoot = new Map<string, T[]>();
  for (const s of sessions) {
    const r = branchRoot(links, s.sessionId);
    const list = byRoot.get(r);
    if (list) list.push(s);
    else byRoot.set(r, [s]);
  }
  const out: BranchGroup<T>[] = [];
  for (const [root, list] of byRoot) {
    if (list.length === 1) { out.push({ entry: list[0]!, openId: list[0]!.sessionId, members: [list[0]!.sessionId] }); continue; }
    const newest = list.reduce((a, b) => (b.lastModified > a.lastModified ? b : a));
    const head = list.find((s) => s.sessionId === root) ?? list.reduce((a, b) => (b.lastModified < a.lastModified ? b : a));
    out.push({ entry: { ...head, lastModified: newest.lastModified }, openId: newest.sessionId, members: list.map((s) => s.sessionId) });
  }
  return out.sort((a, b) => b.entry.lastModified - a.entry.lastModified);
}
