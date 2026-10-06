import { execFile } from 'node:child_process';
import type { SessionHolder } from '../../shared/session-types';

// `--resume=<id>`, `--resume <id>` and the short `-r <id>`.
const RESUME = /\s(?:--resume[= ]|-r\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f-])/gi;

/**
 * Whether the row is a `claude` CLI: the executable's basename is `claude`, also behind an interpreter (`node …/bin/claude`)
 * or Claude Desktop's `disclaimer --pgroup -- <path>/claude` wrapper, or it is the npm package's `cli.js`. `ps` joins argv with spaces and the paths have
 * spaces of their own (`Application Support`), so "the executable" is what precedes the first ` -flag`. A
 * `grep -- '--resume=<id>'` or a `zsh -c 'claude --resume …'` wrapper is not one.
 */
function isClaudeCli(command: string): boolean {
  const exe = (c: string) => c.split(/\s-/, 1)[0]!.trimEnd();
  let head = exe(command);
  if (head.endsWith('/disclaimer') || head === 'disclaimer') {
    const rest = command.indexOf(' -- ');
    if (rest < 0) return false;
    head = exe(command.slice(rest + 4));
  }
  // `node /path/claude`: the script is the executable. Any other leading word (`vim /notes/claude`) is another program's argument.
  const script = /^(?:\S*\/)?(?:node|bun)\s+(.*)$/.exec(head);
  if (script) head = script[1]!;
  else if (!head.startsWith('/') && /\s/.test(head)) return false;
  return head.slice(head.lastIndexOf('/') + 1) === 'claude' || head.endsWith('/claude-code/cli.js');
}

export type HolderSelf = {
  /** deck's own pid: its descendants (the SDK's CLI children) are not "another" process. */
  pid: number;
  /** Path prefixes of deck's own CLI binaries (`<repo>/node_modules/`): a second deck instance's children are deck too. */
  ownRoots?: string[];
};

/**
 * Sessions a `claude` process outside deck has resumed, from `ps -axo pid=,ppid=,command=` output.
 * Such a process keeps its own in-memory history: what it sends next continues from its own last message,
 * whatever deck wrote meanwhile. `desktop` = Claude Desktop's bundled CLI (wins when both kinds hold one
 * session), `other` = anything else (a terminal `claude --resume`). Pure.
 *
 * Only a process that was started to resume a session shows its id. A session started new in Desktop (or by a
 * bare `claude`) has no `--resume` in its arguments: that holder cannot be seen this way and raises no flag.
 */
export function parseHolders(psText: string, self: HolderSelf): Map<string, SessionHolder> {
  const rows: { pid: number; ppid: number; command: string }[] = [];
  for (const line of psText.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]!.normalize('NFC') });
  }
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  // Descendant, not just child: holds if the SDK ever starts its CLI through a wrapper. Bounded against a pid cycle.
  const underDeck = (pid: number) => {
    for (let p: number | undefined = pid, i = 0; p !== undefined && p > 1 && i < 64; p = parent.get(p), i++) if (p === self.pid) return true;
    return false;
  };
  const roots = (self.ownRoots ?? []).map((r) => r.normalize('NFC'));
  const out = new Map<string, SessionHolder>();
  for (const r of rows) {
    if (!isClaudeCli(r.command) || underDeck(r.pid) || roots.some((root) => r.command.startsWith(root))) continue;
    const kind: SessionHolder = r.command.includes('/Claude/claude-code/') || r.command.includes('mcp__ccd_') ? 'desktop' : 'other';
    for (const m of r.command.matchAll(RESUME)) {
      const id = m[1]!.toLowerCase();
      if (kind === 'desktop' || !out.has(id)) out.set(id, kind);
    }
  }
  return out;
}

/** Read-only process list; rejects when `ps` is missing, fails or takes too long. `ww`: commands are never cut short. */
function psList(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-axww', '-o', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024, timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/**
 * Which Claude sessions another process holds open, as of the last scan. A scan is at most one `ps` per `ttlMs`
 * (callers ask at every open / send); a failed scan keeps the previous answer — the flag is only a warning.
 */
export class ProcessHolders {
  private held = new Map<string, SessionHolder>();
  private at = -Infinity;
  private scan: Promise<boolean> | null = null;
  private readonly ps: () => Promise<string>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly self: HolderSelf;

  constructor(opts: { ownRoots?: string[]; pid?: number; ps?: () => Promise<string>; ttlMs?: number; now?: () => number } = {}) {
    this.ps = opts.ps ?? psList;
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? 5000;
    this.self = { pid: opts.pid ?? process.pid, ...(opts.ownRoots ? { ownRoots: opts.ownRoots } : {}) };
  }

  heldBy(sessionId: string): SessionHolder | null {
    return this.held.get(sessionId.toLowerCase()) ?? null;
  }

  /** Rescans unless the last scan is fresh. True when a holder came, went or changed kind. Never throws. */
  refresh(): Promise<boolean> {
    if (this.scan) return this.scan;
    if (this.now() - this.at < this.ttlMs) return Promise.resolve(false);
    // A failed / timed-out `ps` says nothing about who holds what: the last scan's answer stands, "unchanged".
    this.scan = this.ps()
      .then((text) => {
        const next = parseHolders(text, this.self);
        const changed = next.size !== this.held.size || [...next].some(([id, kind]) => this.held.get(id) !== kind);
        this.held = next;
        return changed;
      })
      .catch(() => false)
      .finally(() => { this.at = this.now(); this.scan = null; });
    return this.scan;
  }
}
