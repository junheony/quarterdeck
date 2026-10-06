import { describe, expect, it } from 'vitest';
import { MAX_LCS_CELLS, diffLines, fileDiffsFor, numberOps, parseUnifiedDiff, relPath, splitLines, startLineFromResult } from './diff';

const kinds = (ops: { kind: string }[]) => ops.map((o) => o.kind).join('');

describe('diffLines (LCS)', () => {
  it('identical input is all context', () => {
    expect(diffLines(['a', 'b'], ['a', 'b']).every((o) => o.kind === 'ctx')).toBe(true);
  });

  it('a changed middle line is one del + one add between context', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'B', 'c']);
    expect(ops).toEqual([{ kind: 'ctx', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'add', text: 'B' }, { kind: 'ctx', text: 'c' }]);
  });

  it('finds the longest common subsequence, not just prefix/suffix', () => {
    const ops = diffLines(['x', 'a', 'y', 'b', 'z'], ['a', 'q', 'b']);
    expect(ops.filter((o) => o.kind === 'ctx').map((o) => o.text)).toEqual(['a', 'b']);
    expect(ops.filter((o) => o.kind === 'del').map((o) => o.text)).toEqual(['x', 'y', 'z']);
    expect(ops.filter((o) => o.kind === 'add').map((o) => o.text)).toEqual(['q']);
  });

  it('pure insertion and pure deletion', () => {
    expect(kinds(diffLines([], ['a', 'b']))).toBe('addadd');
    expect(kinds(diffLines(['a', 'b'], []))).toBe('deldel');
  });

  it('applying the ops reproduces both sides', () => {
    const a = ['1', '2', '3', '4', '5', '6'];
    const b = ['0', '2', '3', 'x', '5', '6', '7'];
    const ops = diffLines(a, b);
    expect(ops.filter((o) => o.kind !== 'add').map((o) => o.text)).toEqual(a);
    expect(ops.filter((o) => o.kind !== 'del').map((o) => o.text)).toEqual(b);
  });

  it('degrades to del-then-add above the cell cap', () => {
    const n = Math.ceil(Math.sqrt(MAX_LCS_CELLS)) + 1;
    const a = Array.from({ length: n }, (_, i) => `a${i}`);
    const b = Array.from({ length: n }, (_, i) => `b${i}`);
    const ops = diffLines(a, b);
    expect(ops.length).toBe(2 * n);
    expect(ops[0]!.kind).toBe('del');
    expect(ops.at(-1)!.kind).toBe('add');
  });
});

describe('splitLines / numberOps', () => {
  it('drops one trailing newline; empty string has no lines', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
  });

  it('numbers old lines on ctx/del and new lines on ctx/add', () => {
    const lines = numberOps(diffLines(['a', 'b', 'c'], ['a', 'B', 'B2', 'c']), 10);
    expect(lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([['ctx', 10, 10], ['del', 11, null], ['add', null, 11], ['add', null, 12], ['ctx', 12, 13]]);
    expect(numberOps(diffLines(['a'], ['b']), null).every((l) => l.oldNo === null && l.newNo === null)).toBe(true);
  });
});

describe('startLineFromResult', () => {
  const result = "The file /w/x.ts has been updated. Here's the result of running `cat -n` on a snippet of the edited file:\n    40\tfoo\n    41\tconst a = 2;\n    42\tconst b = 3;\n    43\tbar";
  it('finds the new text in the cat -n snippet', () => {
    expect(startLineFromResult(result, 'const a = 2;\nconst b = 3;')).toBe(41);
  });
  it('null when absent, empty, or not quoted', () => {
    expect(startLineFromResult(result, 'nope')).toBeNull();
    expect(startLineFromResult(result, '')).toBeNull();
    expect(startLineFromResult('The file has been updated successfully.', 'x')).toBeNull();
    expect(startLineFromResult(null, 'x')).toBeNull();
  });
});

describe('fileDiffsFor', () => {
  it('Edit: counts and line numbers from the result snippet', () => {
    const [d] = fileDiffsFor('Edit', { file_path: '/w/x.ts', old_string: 'const a = 1;', new_string: 'const a = 2;\nconst b = 3;' }, "    41\tconst a = 2;\n    42\tconst b = 3;")!;
    expect(d!.path).toBe('/w/x.ts');
    expect([d!.added, d!.removed]).toEqual([2, 1]);
    expect(d!.lines.find((l) => l.kind === 'del')!.oldNo).toBe(41);
    expect(d!.lines.filter((l) => l.kind === 'add').map((l) => l.newNo)).toEqual([41, 42]);
  });

  it('Edit with replace_all has no line numbers', () => {
    const [d] = fileDiffsFor('Edit', { file_path: '/w/x', old_string: 'a', new_string: 'b', replace_all: true }, '     1\tb')!;
    expect(d!.lines.every((l) => l.oldNo === null)).toBe(true);
  });

  it('Write is all-green with 1-based numbers; new when the result says created', () => {
    const [d] = fileDiffsFor('Write', { file_path: '/w/n.md', content: '# t\n\nbody\n' }, 'File created successfully at: /w/n.md')!;
    expect(d!.lines.map((l) => [l.kind, l.newNo])).toEqual([['add', 1], ['add', 2], ['add', 3]]);
    expect([d!.added, d!.removed, d!.isNew]).toEqual([3, 0, true]);
    expect(fileDiffsFor('Write', { file_path: '/w/n.md', content: 'x' }, 'The file /w/n.md has been updated successfully.')![0]!.isNew).toBe(false);
  });

  it('MultiEdit: one file, hunks separated', () => {
    const [d] = fileDiffsFor('MultiEdit', { file_path: '/w/m', edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'b', new_string: '' }] }, null)!;
    expect(d!.lines.map((l) => l.kind)).toEqual(['del', 'add', 'sep', 'del']);
    expect([d!.added, d!.removed]).toEqual([1, 2]);
  });

  it('NotebookEdit: new source added; delete has a note', () => {
    expect(fileDiffsFor('NotebookEdit', { notebook_path: '/w/n.ipynb', new_source: 'x=1\ny=2' }, null)![0]!.added).toBe(2);
    expect(fileDiffsFor('NotebookEdit', { notebook_path: '/w/n.ipynb', new_source: '', edit_mode: 'delete' }, null)![0]!.note).toBe('셀 삭제');
  });

  it('Codex exec changes (path + kind only) and rollout changes (with content / unified_diff)', () => {
    const live = fileDiffsFor('Edit', { changes: [{ path: '/w/a.ts', kind: 'update' }, { path: '/w/b.ts', kind: 'add' }] }, null)!;
    expect(live.map((d) => [d.path, d.isNew, d.note !== null])).toEqual([['/w/a.ts', false, true], ['/w/b.ts', true, true]]);
    const rollout = fileDiffsFor('Edit', { changes: { '/w/c.ts': { type: 'update', unified_diff: '@@ -5,2 +5,2 @@\n keep\n-old\n+new' }, '/w/d.ts': { type: 'add', content: 'l1\nl2' } } }, null)!;
    expect([rollout[0]!.added, rollout[0]!.removed]).toEqual([1, 1]);
    expect(rollout[0]!.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([['ctx', 5, 5], ['del', 6, null], ['add', null, 6]]);
    expect(rollout[1]!.added).toBe(2);
  });

  it('null for other tools and unusable input', () => {
    expect(fileDiffsFor('Bash', { command: 'ls' }, null)).toBeNull();
    expect(fileDiffsFor('Edit', { file_path: '/x' }, null)).toBeNull();
    expect(fileDiffsFor('Edit', null, null)).toBeNull();
  });
});

describe('parseUnifiedDiff', () => {
  it('separates hunks and skips file headers', () => {
    const lines = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n@@ -10,1 +10,2 @@ fn\n c\n+d');
    expect(lines.map((l) => l.kind)).toEqual(['del', 'add', 'sep', 'ctx', 'add']);
    expect(lines.at(-1)!.newNo).toBe(11);
  });
});

describe('relPath', () => {
  it('relative inside cwd, absolute outside', () => {
    expect(relPath('/w/p/src/a.ts', '/w/p')).toBe('src/a.ts');
    expect(relPath('/w/pp/a.ts', '/w/p')).toBe('/w/pp/a.ts');
    expect(relPath('/w/a', null)).toBe('/w/a');
  });
});
