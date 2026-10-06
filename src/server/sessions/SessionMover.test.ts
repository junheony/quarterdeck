import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ancestorTail, isAncestor, moveSession, sha256File, sha256Prefix, snapshotCopy } from './SessionMover';

const ID = '44444444-4444-4444-8444-444444444444';

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-mv-'));
  const srcRoot = path.join(base, 'src', 'projects');
  const srcDir = path.join(srcRoot, '-Users-x-proj');
  await fs.mkdir(path.join(srcDir, ID, 'subagents'), { recursive: true });
  await fs.writeFile(path.join(srcDir, `${ID}.jsonl`), '{"type":"user","cwd":"/Users/x/proj"}\n'.repeat(50));
  await fs.writeFile(path.join(srcDir, ID, 'subagents', 'agent-1.jsonl'), '{"a":1}\n');
  await fs.writeFile(path.join(srcDir, ID, 'custom-title.json'), '{"customTitle":"T"}');
  const dstRoot = path.join(base, 'dst', 'projects');
  return { base, srcRoot, srcDir, dstRoot };
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    const p = path.join(e.parentPath, e.name);
    const rel = path.relative(dir, p);
    out[rel] = e.isDirectory() ? '<dir>' : await sha256File(p);
  }
  return out;
}

describe('moveSession', () => {
  it('copies the jsonl and companion dir into the same slug dir and verifies', async () => {
    const { srcDir, dstRoot } = await fixture();
    const before = await sha256File(path.join(srcDir, `${ID}.jsonl`));
    const beforeStat = await fs.stat(path.join(srcDir, `${ID}.jsonl`));
    const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targetDir).toBe(path.join(dstRoot, '-Users-x-proj'));
    expect(r.targetFile).toBe(path.join(dstRoot, '-Users-x-proj', `${ID}.jsonl`));
    expect(await sha256File(r.targetFile)).toBe(before);
    expect(await fs.readFile(path.join(r.targetDir, ID, 'subagents', 'agent-1.jsonl'), 'utf8')).toBe('{"a":1}\n');
    expect(await fs.readFile(path.join(r.targetDir, ID, 'custom-title.json'), 'utf8')).toBe('{"customTitle":"T"}');
    expect(r.copied.sort()).toEqual([`${ID}.jsonl`, `${ID}/`].sort());
    expect(await fs.readdir(r.targetDir)).not.toContain(`${ID}.jsonl.deck-tmp`);
    // source untouched
    expect(await sha256File(path.join(srcDir, `${ID}.jsonl`))).toBe(before);
    expect((await fs.stat(path.join(srcDir, `${ID}.jsonl`))).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it('concurrent copies of one session to the same target all succeed without trampling each other’s staging', async () => {
    const { srcDir, dstRoot } = await fixture();
    const before = await sha256File(path.join(srcDir, `${ID}.jsonl`));
    const rs = await Promise.all(Array.from({ length: 8 }, () => moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot })));
    expect(rs.map((r) => (r.ok ? 'ok' : r.error))).toEqual(Array(8).fill('ok'));
    const targetDir = path.join(dstRoot, '-Users-x-proj');
    expect(await sha256File(path.join(targetDir, `${ID}.jsonl`))).toBe(before);
    expect(await fs.readFile(path.join(targetDir, ID, 'custom-title.json'), 'utf8')).toBe('{"customTitle":"T"}');
    expect((await fs.readdir(targetDir)).sort()).toEqual([ID, `${ID}.jsonl`].sort());
  });

  it('accepts a target that is a byte-prefix of the source (older deck copy) and keeps target-only companions', async () => {
    const { srcDir, dstRoot } = await fixture();
    const src = await fs.readFile(path.join(srcDir, `${ID}.jsonl`));
    const tDir = path.join(dstRoot, '-Users-x-proj');
    await fs.mkdir(path.join(tDir, ID), { recursive: true });
    await fs.writeFile(path.join(tDir, `${ID}.jsonl`), src.subarray(0, 100));
    await fs.writeFile(path.join(tDir, ID, 'only-on-target.txt'), 'k');
    const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
    expect(r).toMatchObject({ ok: true });
    expect(await sha256File(path.join(tDir, `${ID}.jsonl`))).toBe(await sha256File(path.join(srcDir, `${ID}.jsonl`)));
    expect(await fs.readFile(path.join(tDir, ID, 'only-on-target.txt'), 'utf8')).toBe('k');
    expect(await fs.readFile(path.join(tDir, ID, 'custom-title.json'), 'utf8')).toBe('{"customTitle":"T"}');
    expect((await fs.readdir(tDir)).filter((n) => n.includes('deck-tmp'))).toEqual([]);
  });

  it('refuses a diverged target and leaves it byte-identical', async () => {
    const { srcDir, dstRoot } = await fixture();
    const tDir = path.join(dstRoot, '-Users-x-proj');
    await fs.mkdir(path.join(tDir, ID), { recursive: true });
    await fs.writeFile(path.join(tDir, `${ID}.jsonl`), '{"type":"user","uuid":"u-old"}\n');
    await fs.writeFile(path.join(tDir, ID, 'keep.txt'), 'k');
    const snap = await snapshot(tDir);
    const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('대상 세션이 따로 진행됨');
    if (!r.ok) expect(r.diverged).toBe(true);
    expect(await snapshot(tDir)).toEqual(snap);
  });

  it('leaves the target unchanged when the companion copy fails after staging the jsonl', async () => {
    const { srcDir, dstRoot } = await fixture();
    const src = await fs.readFile(path.join(srcDir, `${ID}.jsonl`));
    const tDir = path.join(dstRoot, '-Users-x-proj');
    await fs.mkdir(path.join(tDir, ID), { recursive: true });
    await fs.writeFile(path.join(tDir, `${ID}.jsonl`), src.subarray(0, 40));
    await fs.writeFile(path.join(tDir, ID, 'keep.txt'), 'k');
    const locked = path.join(srcDir, ID, 'subagents', 'agent-1.jsonl');
    await fs.chmod(locked, 0o000);
    const snap = await snapshot(tDir);
    try {
      const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
      expect(r.ok).toBe(false);
    } finally {
      await fs.chmod(locked, 0o600);
    }
    expect(await snapshot(tDir)).toEqual(snap);
  });

  it('rolls the companions back when the final jsonl rename (commit point) fails', async () => {
    const { srcDir, dstRoot } = await fixture();
    const src = await fs.readFile(path.join(srcDir, `${ID}.jsonl`));
    const tDir = path.join(dstRoot, '-Users-x-proj');
    await fs.mkdir(path.join(tDir, ID), { recursive: true });
    await fs.writeFile(path.join(tDir, `${ID}.jsonl`), src.subarray(0, 40));
    await fs.writeFile(path.join(tDir, ID, 'keep.txt'), 'k');
    const snap = await snapshot(tDir);
    const real = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (a, b) => {
      if (String(b) === path.join(tDir, `${ID}.jsonl`)) throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' });
      return real(a, b);
    });
    try {
      const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
      expect(r.ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(await snapshot(tDir)).toEqual(snap);
  });

  it('refuses when the source is rewritten (not appended) mid-copy and leaves the target untouched', async () => {
    const { srcDir, dstRoot } = await fixture();
    const srcFile = path.join(srcDir, `${ID}.jsonl`);
    const real = fs.readdir.bind(fs) as (...a: unknown[]) => Promise<unknown>;
    // Companions are listed after the jsonl snapshot is staged: rewrite the source's first line there.
    const spy = vi.spyOn(fs, 'readdir').mockImplementation((async (...args: unknown[]) => {
      if (String(args[0]) === path.join(srcDir, ID)) {
        const fh = await fs.open(srcFile, 'r+');
        await fh.write('{"type":"user","cwd":"/Users/x/PROJ"}', 0);
        await fh.close();
      }
      return real(...args);
    }) as typeof fs.readdir);
    try {
      const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('원본이 복사 중 바뀜');
    } finally {
      spy.mockRestore();
    }
    const tDir = path.join(dstRoot, '-Users-x-proj');
    expect(await fs.readdir(tDir).catch(() => [])).toEqual([]);
  });

  it('snapshot-copies a jsonl that keeps growing during the copy, cut at a line boundary', async () => {
    const { srcDir, dstRoot } = await fixture();
    const srcFile = path.join(srcDir, `${ID}.jsonl`);
    const companion = path.join(srcDir, ID, 'subagents', 'agent-1.jsonl');
    // A half-written last line: only complete lines are taken.
    await fs.appendFile(srcFile, '{"type":"assistant","partial":');
    const before = await fs.readFile(srcFile);
    const complete = before.subarray(0, before.lastIndexOf(0x0a) + 1);
    // Keep appending to the jsonl and a subagent transcript while the move runs (the live CLI).
    let stop = false;
    const writer = (async () => {
      while (!stop) {
        await fs.appendFile(srcFile, 'true}\n{"type":"assistant","partial":');
        await fs.appendFile(companion, '{"a":2}\n');
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    let r;
    try {
      r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
    } finally {
      stop = true;
      await writer;
    }
    expect(r).toMatchObject({ ok: true });
    const tFile = path.join(dstRoot, '-Users-x-proj', `${ID}.jsonl`);
    const copy = await fs.readFile(tFile);
    const now = await fs.readFile(srcFile);
    expect(copy.length).toBeGreaterThanOrEqual(complete.length);
    expect(copy.subarray(0, complete.length).equals(complete)).toBe(true);
    expect(now.subarray(0, copy.length).equals(copy)).toBe(true);
    expect(copy[copy.length - 1]).toBe(0x0a);
    const tComp = await fs.readFile(path.join(dstRoot, '-Users-x-proj', ID, 'subagents', 'agent-1.jsonl'));
    expect((await fs.readFile(companion)).subarray(0, tComp.length).equals(tComp)).toBe(true);
    // A second write-back over the older snapshot: accepted as a prefix, no companion backup left behind.
    const again = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
    expect(again).toMatchObject({ ok: true });
    expect(await sha256File(tFile)).toBe(await sha256Prefix(srcFile, (await fs.stat(tFile)).size));
    expect((await fs.readdir(path.join(dstRoot, '-Users-x-proj'))).filter((n) => n.includes('deck-bak'))).toEqual([]);
  });

  it('snapshotCopy gives up (null) on a file that is rewritten on every attempt', async () => {
    const { base } = await fixture();
    const src = path.join(base, 'flappy.txt');
    await fs.writeFile(src, 'aaaa');
    const real = fs.stat.bind(fs);
    let n = 0;
    const spy = vi.spyOn(fs, 'stat').mockImplementation((async (p: Parameters<typeof fs.stat>[0], o?: Parameters<typeof fs.stat>[1]) => {
      if (String(p) === src) await fs.writeFile(src, 'b'.repeat(4 + (++n % 3)));
      return real(p, o);
    }) as typeof fs.stat);
    try {
      expect(await snapshotCopy(src, path.join(base, 'copy.txt'))).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses when the same session id already exists in another directory of the target profile', async () => {
    const { srcDir, dstRoot } = await fixture();
    const other = path.join(dstRoot, '-Users-x-proj-nfd');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, `${ID}.jsonl`), 'x\n');
    const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('-Users-x-proj-nfd');
    await expect(fs.stat(path.join(dstRoot, '-Users-x-proj', `${ID}.jsonl`))).rejects.toThrow();
  });

  it('ignoreOtherDirs (home write-back): copies into the same-named dir and leaves the other copy as is', async () => {
    const { srcDir, dstRoot } = await fixture();
    const other = path.join(dstRoot, '-Users-x-proj-nfd');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, `${ID}.jsonl`), 'x\n');
    const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot, ignoreOtherDirs: true });
    expect(r.ok).toBe(true);
    expect(await sha256File(path.join(dstRoot, '-Users-x-proj', `${ID}.jsonl`))).toBe(await sha256File(path.join(srcDir, `${ID}.jsonl`)));
    expect(await fs.readFile(path.join(other, `${ID}.jsonl`), 'utf8')).toBe('x\n');
    if (!r.ok) return;
    expect('diverged' in r).toBe(false);
  });

  it('works without a companion dir and is a no-op when source == target', async () => {
    const { srcDir, srcRoot, dstRoot } = await fixture();
    await fs.rm(path.join(srcDir, ID), { recursive: true });
    const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.copied).toEqual([`${ID}.jsonl`]);
    const same = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: srcRoot });
    expect(same).toEqual({ ok: true, targetDir: srcDir, targetFile: path.join(srcDir, `${ID}.jsonl`), copied: [] });
  });

  it('fails cleanly when the source is missing or the target root is not writable', async () => {
    const { srcDir, dstRoot, base } = await fixture();
    const missing = await moveSession({ sessionId: '55555555-5555-4555-8555-555555555555', sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
    expect(missing.ok).toBe(false);
    const fileAsRoot = path.join(base, 'not-a-dir');
    await fs.writeFile(fileAsRoot, 'x');
    const bad = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: fileAsRoot });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.length).toBeGreaterThan(0);
  });

  describe('a target ahead only by uuid-less metadata lines (Claude Desktop)', () => {
    const conv = (uuid: string, ts = '2026-10-01T00:00:00.000Z') => `${JSON.stringify({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content: uuid } })}\n`;
    const meta = (n: number) => `${JSON.stringify({ type: 'artifact-autoreact-ledger', entries: [n] })}\n`;

    async function pair(target: string, source: string) {
      const { srcDir, dstRoot } = await fixture();
      await fs.writeFile(path.join(srcDir, `${ID}.jsonl`), source);
      const tDir = path.join(dstRoot, '-Users-x-proj');
      await fs.mkdir(tDir, { recursive: true });
      await fs.writeFile(path.join(tDir, `${ID}.jsonl`), target);
      return { srcDir, dstRoot, srcFile: path.join(srcDir, `${ID}.jsonl`), tFile: path.join(tDir, `${ID}.jsonl`) };
    }

    it('ancestorTail: common prefix + uuid-less (or unparsable) tail = ancestor; a tail line with a uuid = not', async () => {
      const shared = conv('u1') + conv('u2');
      const f = await pair(shared + meta(1) + 'not json\n', shared + conv('u3'));
      // An unparsable (but complete) line counts as metadata for the decision, but is not one to propagate.
      expect(await ancestorTail(f.tFile, f.srcFile)).toEqual([meta(1).trimEnd()]);
      expect(await isAncestor(f.tFile, f.srcFile)).toBe(true);
      // The other way round: the source has a conversation line the target lacks.
      expect(await isAncestor(f.srcFile, f.tFile)).toBe(false);
      await fs.writeFile(f.tFile, shared + meta(1) + conv('u9'));
      expect(await ancestorTail(f.tFile, f.srcFile)).toBeNull();
      // A plain byte-prefix has an empty tail.
      await fs.writeFile(f.tFile, conv('u1'));
      expect(await ancestorTail(f.tFile, f.srcFile)).toEqual([]);
    });

    it('is not divergence: the source is written, then the target\'s metadata tail is appended', async () => {
      const shared = conv('u1') + conv('u2');
      const source = shared + conv('u3-deck');
      const f = await pair(shared + meta(1) + meta(2), source);
      const srcBefore = await sha256File(f.srcFile);
      const r = await moveSession({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot });
      expect(r).toMatchObject({ ok: true });
      expect(await fs.readFile(f.tFile, 'utf8')).toBe(source + meta(1) + meta(2));
      expect(await sha256File(f.srcFile)).toBe(srcBefore);
      expect((await fs.readdir(path.dirname(f.tFile))).filter((n) => n.includes('deck-tmp'))).toEqual([]);
      // The next write-back (deck went on) keeps the metadata once more, without duplicating it.
      await fs.appendFile(f.srcFile, conv('u4-deck'));
      expect(await moveSession({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot })).toMatchObject({ ok: true });
      expect(await fs.readFile(f.tFile, 'utf8')).toBe(source + conv('u4-deck') + meta(1) + meta(2));
    });

    it('a truncated last line (Desktop mid-write) is never metadata: the target is diverged and untouched', async () => {
      const shared = conv('u1');
      const target = `${shared}{"type":"user","uuid":"A-ONLY","message":{"role":"user","content":"half`;
      const f = await pair(target, shared + conv('B-ONLY'));
      expect(await ancestorTail(f.tFile, f.srcFile)).toBeNull();
      const r = await moveSession({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot });
      expect(r).toMatchObject({ ok: false, diverged: true });
      expect(await fs.readFile(f.tFile, 'utf8')).toBe(target);
      // Also when the cut-off part has no uuid yet.
      await fs.writeFile(f.tFile, `${shared}{"type":"artifact-auto`);
      expect(await ancestorTail(f.tFile, f.srcFile)).toBeNull();
    });

    it('an unparsable complete line counts for the decision but is not written back', async () => {
      const shared = conv('u1');
      const source = shared + conv('u2-deck');
      const f = await pair(shared + meta(1) + 'garbage {\n' + meta(2), source);
      expect(await moveSession({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot })).toMatchObject({ ok: true });
      expect(await fs.readFile(f.tFile, 'utf8')).toBe(source + meta(1) + meta(2));
    });

    it('a uuid line far before a long tail ends the check early (the rest is not needed)', async () => {
      const shared = conv('u1');
      const f = await pair(shared + conv('u2-desktop') + meta(1).repeat(20_000), shared + conv('u2-deck'));
      expect(await ancestorTail(f.tFile, f.srcFile)).toBeNull();
    });

    for (const kind of ['metadata tail', 'plain prefix'] as const) {
      it(`aborts when the target changes between the decision and the commit (${kind})`, async () => {
        const shared = conv('u1');
        const target = kind === 'plain prefix' ? shared : shared + meta(1);
        const f = await pair(target, shared + conv('u2-deck'));
        const real = fs.readdir.bind(fs) as (...a: unknown[]) => Promise<unknown>;
        // Companions are listed after the decision and before the commit: Desktop appends to the target there.
        const spy = vi.spyOn(fs, 'readdir').mockImplementation((async (...args: unknown[]) => {
          if (String(args[0]) === path.join(f.srcDir, ID)) await fs.appendFile(f.tFile, conv('u2-desktop'));
          return real(...args);
        }) as typeof fs.readdir);
        try {
          const r = await moveSession({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot });
          expect(r).toMatchObject({ ok: false, error: expect.stringContaining('대상 사본이 복사 중 바뀜') });
        } finally {
          spy.mockRestore();
        }
        expect(await fs.readFile(f.tFile, 'utf8')).toBe(target + conv('u2-desktop'));
        expect((await fs.readdir(path.dirname(f.tFile))).filter((n) => n.includes('deck-tmp'))).toEqual([]);
      });
    }

    it('metadata lines the source already has are not appended twice', async () => {
      const shared = conv('u1');
      const source = shared + conv('u2') + meta(1);
      const f = await pair(shared + meta(1), source);
      expect(await moveSession({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot })).toMatchObject({ ok: true });
      expect(await fs.readFile(f.tFile, 'utf8')).toBe(source);
    });

    it('a target that also has a conversation line of its own is still diverged and untouched', async () => {
      const shared = conv('u1');
      const target = shared + meta(1) + conv('u2-desktop');
      const f = await pair(target, shared + conv('u2-deck'));
      const r = await moveSession({ sessionId: ID, sourceProjectDir: f.srcDir, targetProjectsRoot: f.dstRoot });
      expect(r).toMatchObject({ ok: false, diverged: true });
      expect(await fs.readFile(f.tFile, 'utf8')).toBe(target);
    });
  });
});
