import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeBuildId, liveBuildId } from './buildId';

describe('computeBuildId', () => {
  it('hashes index.html, changes with its content, and is null without a build', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-build-'));
    expect(computeBuildId(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'index.html'), '<script src="/assets/a.js">');
    const a = computeBuildId(dir);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(computeBuildId(dir)).toBe(a);
    fs.writeFileSync(path.join(dir, 'index.html'), '<script src="/assets/b.js">');
    expect(computeBuildId(dir)).not.toBe(a);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('liveBuildId', () => {
  it('follows a rebuild without a restart, and re-hashes only when index.html changes on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-build-'));
    const file = path.join(dir, 'index.html');
    expect(liveBuildId(dir)).toBeNull();
    const t = new Date(1_700_000_000_000); // whole seconds: utimes keeps it exactly
    fs.writeFileSync(file, '<script src="/assets/a.js">');
    fs.utimesSync(file, t, t);
    const a = liveBuildId(dir);
    expect(a).toBe(computeBuildId(dir));
    // same mtime + size: the cached id is served (the content swap below goes unseen until the stat changes)
    fs.writeFileSync(file, '<script src="/assets/b.js">');
    fs.utimesSync(file, t, t);
    expect(liveBuildId(dir)).toBe(a);
    fs.utimesSync(file, t, new Date(t.getTime() + 5000));
    const b = liveBuildId(dir);
    expect(b).not.toBe(a);
    expect(b).toBe(computeBuildId(dir));
    // a build in progress: index.html just written (or missing) — the last settled id stands until it has sat for a few seconds
    const now = t.getTime() + 60_000;
    fs.writeFileSync(file, '<script src="/assets/c.js"></script>');
    fs.utimesSync(file, t, new Date(now - 1000));
    expect(liveBuildId(dir, now)).toBe(b);
    const c = liveBuildId(dir, now + 5000);
    expect(c).not.toBe(b);
    expect(c).toBe(computeBuildId(dir));
    fs.rmSync(file);
    expect(liveBuildId(dir)).toBe(c);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
