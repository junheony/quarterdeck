import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lastConversationAt, resolveCopies, type PrefixFn } from './copies';

type C = { file: string; size: number; mtimeMs: number };
const c = (file: string, mtimeMs: number): C => ({ file, size: file.length, mtimeMs });
/** "file" names double as contents: x is a prefix of y when y starts with x. */
const prefix: PrefixFn = async (a, b) => b.file.startsWith(a.file);

describe('resolveCopies', () => {
  it('a prefix chain → the longest copy wins regardless of mtime', async () => {
    const r = await resolveCopies([c('ab', 9), c('abcd', 1), c('a', 5)], prefix);
    expect(r?.best.file).toBe('abcd');
    expect(r?.heads.map((h) => h.file)).toEqual(['abcd']);
  });

  it('equal copies → the first listed (deck\'s current) wins', async () => {
    const first = c('ab', 1);
    const r = await resolveCopies([first, c('ab', 9)], prefix);
    expect(r?.best).toBe(first);
    expect(r?.heads).toHaveLength(1);
  });

  it('diverged → both heads reported, the latest conversation timestamp wins (not mtime); prefixes of a head drop out', async () => {
    const at: Record<string, number> = { abX: 200, abY: 100 };
    const r = await resolveCopies([c('abX', 1), c('a', 50), c('abY', 7)], prefix, { lastAt: async (f) => at[f] ?? -Infinity });
    expect(r?.heads.map((h) => h.file).sort()).toEqual(['abX', 'abY']);
    expect(r?.best.file).toBe('abX');
  });

  it('diverged with equal timestamps → the non-home (deck) copy wins, whatever its mtime or place in the list', async () => {
    const home = { ...c('abX', 99), account: 'a' };
    const deck = { ...c('abY', 1), account: 'b' };
    const r = await resolveCopies([home, deck], prefix, { home: 'a', lastAt: async () => 100 });
    expect(r?.best).toBe(deck);
  });

  it('no copies → null', async () => {
    expect(await resolveCopies([], prefix)).toBeNull();
  });
});

describe('copies on disk (default ancestor check and timestamps)', () => {
  const conv = (uuid: string, ts: string) => `${JSON.stringify({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content: uuid } })}\n`;
  const meta = `${JSON.stringify({ type: 'artifact-autoreact-ledger', entries: [] })}\n`;
  async function write(name: string, text: string, mtimeMs: number) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-copies-'));
    const file = path.join(dir, name);
    await fs.writeFile(file, text);
    await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
    return { file, size: text.length, mtimeMs };
  }

  it('a home copy ahead only by Desktop metadata is not a head: deck\'s copy (with the newer turn) wins although A is newer by mtime', async () => {
    const shared = conv('u1', '2026-10-01T00:00:00Z');
    const deck = { ...(await write('b.jsonl', shared + conv('u2', '2026-10-01T00:05:00Z'), 1_000)), account: 'b' };
    const home = { ...(await write('a.jsonl', shared + meta, 9_000)), account: 'a' };
    const r = await resolveCopies([home, deck], undefined, { home: 'a' });
    expect(r?.heads).toEqual([deck]);
    expect(r?.best).toBe(deck);
  });

  it('truly diverged on disk: the copy whose last conversation line is newest wins; trailing metadata does not count', async () => {
    const shared = conv('u1', '2026-10-01T00:00:00Z');
    const deck = { ...(await write('b.jsonl', shared + conv('u2-deck', '2026-10-01T00:09:00Z'), 1_000)), account: 'b' };
    const home = { ...(await write('a.jsonl', shared + conv('u2-desk', '2026-10-01T00:05:00Z') + meta, 9_000)), account: 'a' };
    expect(await lastConversationAt(home.file)).toBe(Date.parse('2026-10-01T00:05:00Z'));
    const r = await resolveCopies([home, deck], undefined, { home: 'a' });
    expect(r?.heads).toHaveLength(2);
    expect(r?.best).toBe(deck);
  });

  it('lastConversationAt finds the line before a very long trailing line (spanning many read chunks)', async () => {
    const big = `${JSON.stringify({ type: 'artifact-autoreact-ledger', blob: 'x'.repeat(300_000) })}\n`;
    const f = await write('long.jsonl', conv('u1', '2026-10-01T00:00:00Z') + conv('u2', '2026-10-01T00:07:00Z') + big, 1_000);
    expect(await lastConversationAt(f.file)).toBe(Date.parse('2026-10-01T00:07:00Z'));
    const g = await write('long2.jsonl', `${JSON.stringify({ uuid: 'u3', timestamp: '2026-10-01T00:09:00Z', blob: 'y'.repeat(300_000) })}\n`, 1_000);
    expect(await lastConversationAt(g.file)).toBe(Date.parse('2026-10-01T00:09:00Z'));
  });
});

