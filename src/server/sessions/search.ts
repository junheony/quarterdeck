import fs from 'node:fs/promises';
import type { Seat } from '../../shared/accounts';
import type { EngineKind } from '../../shared/models';
import type { SessionEntry, TranscriptMessage } from '../../shared/session-types';
import { readCodexTranscript } from '../engine/codexRollout';
import { readTranscript } from './transcript';

export type SearchHit = {
  sessionId: string;
  title: string;
  cwd: string;
  account: Seat;
  engine: EngineKind;
  lastModified: number;
  role: 'user' | 'assistant';
  /** Text around the match; `[matchStart, matchStart + matchLength)` is the match inside it. */
  snippet: string;
  matchStart: number;
  matchLength: number;
};

export type SearchResult = { hits: SearchHit[]; scanned: number; /** files skipped (too large) or results cut at the limit */ truncated: boolean };

export const MIN_QUERY_CHARS = 2;
export const MAX_QUERY_CHARS = 200;

type Doc = { role: 'user' | 'assistant'; text: string };
type Cached = { mtimeMs: number; size: number; docs: Doc[] };

export type SearchOptions = {
  /** Sessions to search (already de-duplicated; titles as the sidebar shows them). */
  sessions: () => SessionEntry[];
  /** Larger transcript files are skipped (default 64 MB). */
  maxFileBytes?: number;
  /** Text kept per session for searching, newest kept (default 2M chars). */
  maxCharsPerSession?: number;
  readClaude?: (file: string) => Promise<TranscriptMessage[]>;
  readCodex?: (file: string) => Promise<TranscriptMessage[]>;
};

const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 120;
const PER_SESSION = 3;

/**
 * Full-text search over every session's user/assistant text (tool output excluded). Each transcript is
 * read once and cached by (mtime, size); later searches only re-read files that changed. Only files the
 * session index knows are ever opened — the query never names a path.
 */
export class TranscriptSearch {
  private cache = new Map<string, Cached>();
  private readonly maxFileBytes: number;
  private readonly maxChars: number;

  constructor(private readonly opts: SearchOptions) {
    this.maxFileBytes = opts.maxFileBytes ?? 64 * 1024 * 1024;
    this.maxChars = opts.maxCharsPerSession ?? 2_000_000;
  }

  private async docs(s: SessionEntry): Promise<Doc[] | 'too-large' | null> {
    if (!s.file) return null;
    let st: import('node:fs').Stats;
    try { st = await fs.stat(s.file); } catch { return null; }
    if (st.size > this.maxFileBytes) return 'too-large';
    const hit = this.cache.get(s.file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.docs;
    const read = s.engine === 'codex'
      ? (this.opts.readCodex ?? ((f) => readCodexTranscript(f)))
      : (this.opts.readClaude ?? ((f) => readTranscript(f, { maxMessages: Number.POSITIVE_INFINITY, maxToolResultChars: 0 })));
    let messages: TranscriptMessage[];
    try { messages = await read(s.file); } catch { return null; }
    const docs: Doc[] = [];
    let chars = 0;
    for (let i = messages.length - 1; i >= 0 && chars < this.maxChars; i--) {
      const m = messages[i]!;
      if ((m.kind === 'user' || m.kind === 'assistant') && m.text) {
        docs.push({ role: m.kind, text: m.text });
        chars += m.text.length;
      }
    }
    docs.reverse();
    this.cache.set(s.file, { mtimeMs: st.mtimeMs, size: st.size, docs });
    return docs;
  }

  async search(query: string, limit = 50): Promise<SearchResult> {
    const q = query.trim().slice(0, MAX_QUERY_CHARS);
    if (q.length < MIN_QUERY_CHARS) return { hits: [], scanned: 0, truncated: false };
    const needle = q.toLowerCase();
    const sessions = [...this.opts.sessions()].sort((a, b) => b.lastModified - a.lastModified);
    const live = new Set(sessions.map((s) => s.file));
    for (const f of this.cache.keys()) if (!live.has(f)) this.cache.delete(f);
    const hits: SearchHit[] = [];
    let scanned = 0;
    let truncated = false;
    for (const s of sessions) {
      const docs = await this.docs(s);
      if (docs === 'too-large') { truncated = true; continue; }
      if (!docs) continue;
      scanned++;
      let found = 0;
      // Newest messages first: the hit most likely wanted is the latest mention.
      for (let i = docs.length - 1; i >= 0 && found < PER_SESSION; i--) {
        const d = docs[i]!;
        const at = d.text.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        found++;
        const from = Math.max(0, at - SNIPPET_BEFORE);
        const to = Math.min(d.text.length, at + q.length + SNIPPET_AFTER);
        const lead = from > 0 ? '…' : '';
        const raw = d.text.slice(from, to).replace(/\s/g, ' ');
        hits.push({
          sessionId: s.sessionId, title: s.title, cwd: s.cwd, account: s.account, engine: s.engine ?? 'claude', lastModified: s.lastModified,
          role: d.role, snippet: lead + raw + (to < d.text.length ? '…' : ''), matchStart: lead.length + (at - from), matchLength: q.length,
        });
        if (hits.length >= limit) return { hits, scanned, truncated: true };
      }
    }
    return { hits, scanned, truncated };
  }
}
