/**
 * Line diffs for file-editing tool calls (Edit / MultiEdit / Write / NotebookEdit, Codex file changes):
 * a plain LCS line diff (no dependency) plus the per-tool input → FileDiff mapping the diff card renders.
 */

export type DiffLine =
  | { kind: 'ctx' | 'add' | 'del'; text: string; oldNo: number | null; newNo: number | null }
  /** Boundary between two hunks (MultiEdit edits, unified-diff hunks). */
  | { kind: 'sep'; text: string; oldNo: null; newNo: null };

export type FileDiff = {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
  /** Write that created the file / Codex `add`. */
  isNew: boolean;
  isDeleted: boolean;
  /** Shown instead of lines when there is nothing to diff (e.g. a Codex change without content). */
  note: string | null;
};

/** Above this many LCS cells the diff degrades to "all removed, then all added" (still correct, just coarse). */
export const MAX_LCS_CELLS = 4_000_000;

/** '' → []; one trailing newline does not make an extra empty line. */
export function splitLines(s: string): string[] {
  if (!s) return [];
  const lines = s.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

type Op = { kind: 'ctx' | 'add' | 'del'; text: string };

/** LCS line diff of `a` → `b` with common prefix/suffix trimmed first. */
export function diffLines(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const head: Op[] = a.slice(0, pre).map((text) => ({ kind: 'ctx', text }));
  const tail: Op[] = a.slice(a.length - suf).map((text) => ({ kind: 'ctx', text }));
  const x = a.slice(pre, a.length - suf);
  const y = b.slice(pre, b.length - suf);
  const n = x.length;
  const m = y.length;
  const mid: Op[] = [];
  if (n * m > MAX_LCS_CELLS) {
    for (const text of x) mid.push({ kind: 'del', text });
    for (const text of y) mid.push({ kind: 'add', text });
    return [...head, ...mid, ...tail];
  }
  // dp[i][j] = LCS length of x[i..] and y[j..], flattened.
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = x[i] === y[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { mid.push({ kind: 'ctx', text: x[i]! }); i++; j++; }
    else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) { mid.push({ kind: 'del', text: x[i]! }); i++; }
    else { mid.push({ kind: 'add', text: y[j]! }); j++; }
  }
  while (i < n) mid.push({ kind: 'del', text: x[i++]! });
  while (j < m) mid.push({ kind: 'add', text: y[j++]! });
  return [...head, ...mid, ...tail];
}

/** Ops → numbered lines; `start` = line number of the first line in both files (null = unknown, no numbers). */
export function numberOps(ops: Op[], start: number | null): DiffLine[] {
  let o = start ?? 0;
  let nn = start ?? 0;
  return ops.map((op) => {
    const oldNo = start === null || op.kind === 'add' ? null : o++;
    const newNo = start === null || op.kind === 'del' ? null : nn++;
    return { kind: op.kind, text: op.text, oldNo, newNo };
  });
}

/**
 * Claude's Edit result quotes the edited region as `cat -n` output ("    12\tline"). The first line of
 * `newText` found there (followed by the rest of it, as far as the snippet goes) gives the start line.
 */
export function startLineFromResult(result: string | null, newText: string): number | null {
  if (!result) return null;
  const want = splitLines(newText);
  if (want.length === 0) return null;
  const numbered: { no: number; text: string }[] = [];
  for (const raw of result.split('\n')) {
    const m = /^\s*(\d+)[\t→](.*)$/.exec(raw);
    if (m) numbered.push({ no: Number(m[1]), text: m[2]! });
  }
  for (let k = 0; k < numbered.length; k++) {
    let ok = true;
    for (let t = 0; t < want.length && k + t < numbered.length; t++) {
      if (numbered[k + t]!.text !== want[t] || numbered[k + t]!.no !== numbered[k]!.no + t) { ok = false; break; }
    }
    if (ok) return numbered[k]!.no;
  }
  return null;
}

function counts(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'del') removed++;
  }
  return { added, removed };
}

function fileDiff(path: string, lines: DiffLine[], extra: Partial<Pick<FileDiff, 'isNew' | 'isDeleted' | 'note'>> = {}): FileDiff {
  return { path, lines, ...counts(lines), isNew: extra.isNew ?? false, isDeleted: extra.isDeleted ?? false, note: extra.note ?? null };
}

const allAdded = (text: string): DiffLine[] => splitLines(text).map((t, i) => ({ kind: 'add', text: t, oldNo: null, newNo: i + 1 }));
const allRemoved = (text: string): DiffLine[] => splitLines(text).map((t, i) => ({ kind: 'del', text: t, oldNo: i + 1, newNo: null }));

/** `@@ -a,b +c,d @@` unified diff (Codex `update`) → numbered lines with a separator between hunks. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const raw of splitLines(diff)) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) {
      if (out.length) out.push({ kind: 'sep', text: h[3]!.trim(), oldNo: null, newNo: null });
      o = Number(h[1]);
      n = Number(h[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('\\')) continue;
    const c = raw[0];
    const text = raw.slice(1);
    if (c === '+') out.push({ kind: 'add', text, oldNo: null, newNo: n++ });
    else if (c === '-') out.push({ kind: 'del', text, oldNo: o++, newNo: null });
    else out.push({ kind: 'ctx', text: c === ' ' ? text : raw, oldNo: o++, newNo: n++ });
  }
  return out;
}

type Rec = Record<string, unknown>;
const str = (o: Rec, k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);

export const DIFF_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Codex `file_change` changes: `[{ path, kind }]` (exec --json) or `{ [path]: { type, content | unified_diff } }` (rollout). */
function codexDiffs(changes: unknown): FileDiff[] | null {
  const list: { path: string; kind: string; content: string | null; diff: string | null }[] = [];
  if (Array.isArray(changes)) {
    for (const c of changes) {
      if (!c || typeof c !== 'object') continue;
      const r = c as Rec;
      const kind = r.kind && typeof r.kind === 'object' ? String((r.kind as Rec).type ?? '') : String(r.kind ?? r.type ?? '');
      if (typeof r.path === 'string') list.push({ path: r.path, kind, content: str(r, 'content'), diff: str(r, 'unified_diff') ?? str(r, 'diff') });
    }
  } else if (changes && typeof changes === 'object') {
    for (const [p, v] of Object.entries(changes as Rec)) {
      const r = v && typeof v === 'object' ? (v as Rec) : {};
      list.push({ path: p, kind: String(r.type ?? r.kind ?? ''), content: str(r, 'content'), diff: str(r, 'unified_diff') });
    }
  } else return null;
  if (list.length === 0) return null;
  return list.map((c) => {
    if (c.kind === 'add') return c.content !== null ? fileDiff(c.path, allAdded(c.content), { isNew: true }) : fileDiff(c.path, [], { isNew: true, note: '새 파일' });
    if (c.kind === 'delete') return c.content !== null ? fileDiff(c.path, allRemoved(c.content), { isDeleted: true }) : fileDiff(c.path, [], { isDeleted: true, note: '삭제됨' });
    if (c.diff) return fileDiff(c.path, parseUnifiedDiff(c.diff));
    return fileDiff(c.path, [], { note: '수정됨 (변경 내용은 기록되지 않음)' });
  });
}

/** The diff a file-editing tool call makes, or null when the call is not one (or its input is unusable). */
export function fileDiffsFor(name: string, input: unknown, result: string | null): FileDiff[] | null {
  const i = input && typeof input === 'object' ? (input as Rec) : null;
  if (!i) return null;
  if (Array.isArray(i.changes) || (i.changes && typeof i.changes === 'object' && !str(i, 'file_path'))) return codexDiffs(i.changes);
  if (!DIFF_TOOLS.has(name)) return null;
  const file = str(i, 'file_path') ?? str(i, 'notebook_path');
  if (!file) return null;
  switch (name) {
    case 'Edit': {
      const oldS = str(i, 'old_string');
      const newS = str(i, 'new_string');
      if (oldS === null || newS === null) return null;
      const start = i.replace_all === true ? null : startLineFromResult(result, newS);
      return [fileDiff(file, numberOps(diffLines(splitLines(oldS), splitLines(newS)), start))];
    }
    case 'MultiEdit': {
      if (!Array.isArray(i.edits)) return null;
      const lines: DiffLine[] = [];
      for (const e of i.edits) {
        if (!e || typeof e !== 'object') continue;
        const oldS = str(e as Rec, 'old_string');
        const newS = str(e as Rec, 'new_string');
        if (oldS === null || newS === null) continue;
        if (lines.length) lines.push({ kind: 'sep', text: '', oldNo: null, newNo: null });
        lines.push(...numberOps(diffLines(splitLines(oldS), splitLines(newS)), null));
      }
      return [fileDiff(file, lines)];
    }
    case 'Write': {
      const content = str(i, 'content');
      if (content === null) return null;
      return [fileDiff(file, allAdded(content), { isNew: !result || /created/i.test(result) })];
    }
    case 'NotebookEdit': {
      if (i.edit_mode === 'delete') return [fileDiff(file, [], { note: '셀 삭제' })];
      const src = str(i, 'new_source');
      if (src === null) return null;
      // The cell's old source is not in the input: the new source shows as added, without line numbers.
      return [fileDiff(file, allAdded(src).map((l) => ({ ...l, newNo: null })))];
    }
  }
  return null;
}

/** `path` relative to `cwd` when inside it, else as given. */
export function relPath(p: string, cwd?: string | null): string {
  if (!cwd) return p;
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return p.startsWith(base) ? p.slice(base.length) : p;
}
