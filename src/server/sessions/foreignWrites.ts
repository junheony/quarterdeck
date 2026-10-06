import fs from 'node:fs/promises';

/** The `entrypoint` Claude Code stamps on entries written through the Agent SDK — deck's own processes. Desktop writes `claude-desktop`, a terminal `cli`. */
export const DECK_ENTRYPOINT = 'sdk-ts';

/** Two writers interleave: a line a little older than `since` may sit after a newer one, so the backwards read goes this far past it. */
const OVERLAP_MS = 60_000;

/** Main-chain `user` entries the CLI writes without anyone saying anything: slash-command echoes and their output (`/model`), task notifications, reminders. */
const NOT_A_PROMPT = /^\s*<(?:local-command-|command-|task-notification|system-reminder|bash-)/;

/** The text of a `user` entry somebody typed; null for tool results, meta entries and the CLI's own bookkeeping entries. */
function promptText(r: Record<string, unknown>): string | null {
  if (r.isMeta) return null;
  const content = (r.message as { content?: unknown } | null | undefined)?.content;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? (content as { type?: unknown; text?: unknown }[]).find((b) => b?.type === 'text' && typeof b.text === 'string')?.text as string | undefined
      : undefined;
  return text === undefined || NOT_A_PROMPT.test(text) ? null : text;
}

/**
 * What one transcript line says about writes since `sinceMs`: `foreign` = a main-chain prompt or assistant entry
 * written at or after it by something other than deck's SDK process; `old` = a conversation line from well
 * before it (nothing earlier in the file can matter); null = neither. An entry without an `entrypoint`
 * (older CLI) cannot be told apart and counts as deck's. Only "the conversation went on" counts: a `/model`
 * typed in Desktop writes user entries too, and must not cost deck's held-open process its background work.
 */
export function classifyLine(line: string, sinceMs: number): 'foreign' | 'old' | null {
  if (!line.includes('"timestamp"')) return null;
  let r: Record<string, unknown> | null;
  try { r = JSON.parse(line) as Record<string, unknown> | null; } catch { return null; }
  if (!r || typeof r !== 'object' || typeof r.uuid !== 'string' || typeof r.timestamp !== 'string') return null;
  const t = Date.parse(r.timestamp);
  if (!Number.isFinite(t)) return null;
  if (t < sinceMs) return t < sinceMs - OVERLAP_MS ? 'old' : null;
  if (r.isSidechain || typeof r.entrypoint !== 'string' || r.entrypoint === DECK_ENTRYPOINT) return null;
  return r.type === 'assistant' || (r.type === 'user' && promptText(r) !== null) ? 'foreign' : null;
}

/**
 * Whether the transcript gained main-chain entries since `sinceMs` that no deck process wrote (Claude Desktop or a
 * terminal CLI continued the session), looking only at the bytes from `from` on. Reads backwards from the end and
 * stops at `from` or at the first line from well before `sinceMs`. `end` is the offset this scan found clean up to:
 * handed back as the next scan's `from`, a check costs what was appended since the last one, however long the
 * process has been held open. It stays at `from` when something foreign was found or the last line is still being
 * written. A missing file is "no"; a file shorter than `from` (rewritten) is read whole.
 */
export async function scanForeign(file: string, sinceMs: number, from = 0): Promise<{ foreign: boolean; end: number }> {
  let fh: fs.FileHandle;
  try { fh = await fs.open(file, 'r'); } catch { return { foreign: false, end: 0 }; }
  try {
    const CHUNK = 1 << 16;
    const size = (await fh.stat()).size;
    if (size < from) from = 0;
    if (size === from) return { foreign: false, end: from };
    const last = Buffer.alloc(1);
    await fh.read(last, 0, 1, size - 1);
    const clean = { foreign: false, end: last[0] === 0x0a ? size : from };
    let end = size;
    // The part of a line that began in an earlier chunk (see copies.ts lastConversationAt): pieces, joined once per line.
    let carry: Buffer[] = [];
    while (end > from) {
      const start = Math.max(from, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      const chunk = buf.subarray(0, bytesRead);
      end = start;
      // `from` is a line start (a previous scan's `end`), like offset 0.
      const cut = start === from ? 0 : chunk.indexOf(0x0a) + 1;
      if (start > from && cut === 0) { carry.push(chunk); continue; }
      const lines = Buffer.concat([chunk.subarray(cut), ...carry.reverse()]).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const c = classifyLine(lines[i]!, sinceMs);
        if (c === 'foreign') return { foreign: true, end: from };
        if (c === 'old') return clean;
      }
      carry = [chunk.subarray(0, cut)];
    }
    return clean;
  } finally {
    await fh.close();
  }
}

/** `scanForeign` over the whole file, as a yes / no. */
export async function foreignWriteSince(file: string, sinceMs: number): Promise<boolean> {
  return (await scanForeign(file, sinceMs)).foreign;
}
