import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_USAGE_ACCOUNTS, UsageIndex } from './UsageIndex';
import type { UsageRow } from '../../shared/token-usage';
import { rootsOf } from '../../shared/accounts.testkit';

let dir: string;
let roots: { a: string; b: string; c: string };
// `indexFile` is reassigned by the v2 suite (its own name next to a v1 file).
let codexRoot: string;
let indexFile: string;
const NOW = new Date('2026-10-02T12:00:00');
const TS = '2026-10-02T03:00:00.000Z';

function asst(id: string, usage: Partial<Record<string, number>>, opts: { model?: string; ts?: string } = {}): string {
  return JSON.stringify({ type: 'assistant', uuid: `u-${id}-${Math.random()}`, timestamp: opts.ts ?? TS, requestId: `req-${id}`, message: { id, model: opts.model ?? 'claude-opus-5-5', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } } }) + '\n';
}
function tokenCount(total: number[], last: number[], ts = TS): string {
  const v = (a: number[]) => ({ input_tokens: a[0], cached_input_tokens: a[1], cache_write_input_tokens: a[2], output_tokens: a[3] });
  return JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: v(total), last_token_usage: v(last) } } }) + '\n';
}
const make = () => new UsageIndex({ projectsRoots: rootsOf(roots), codexSessionsRoot: codexRoot, indexFile, now: () => NOW });
const pick = (rows: UsageRow[], source: string) => rows.filter((r) => r.source === source).reduce((s, r) => ({ input: s.input + r.input, output: s.output + r.output, cacheRead: s.cacheRead + r.cacheRead, cacheWrite: s.cacheWrite + r.cacheWrite, messages: s.messages + r.messages }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-usage-idx-'));
  roots = { a: path.join(dir, 'a'), b: path.join(dir, 'b'), c: path.join(dir, 'c') };
  for (const r of Object.values(roots)) await fs.mkdir(path.join(r, '-proj'), { recursive: true });
  codexRoot = path.join(dir, 'codex', 'sessions');
  await fs.mkdir(path.join(codexRoot, '2026', '10', '02'), { recursive: true });
  indexFile = path.join(dir, 'cfg', 'usage-index.json');
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('UsageIndex', () => {
  it('dedupes repeated lines of one message and counts subagent transcripts', async () => {
    const f = path.join(roots.a, '-proj', 's1.jsonl');
    await fs.writeFile(f, asst('m1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }) + asst('m1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }) + JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
    await fs.mkdir(path.join(roots.a, '-proj', 's1', 'subagents'), { recursive: true });
    await fs.writeFile(path.join(roots.a, '-proj', 's1', 'subagents', 'agent-x.jsonl'), asst('m2', { input_tokens: 1, output_tokens: 2 }, { model: 'claude-sonnet-5-5' }));
    const idx = make();
    await idx.refresh();
    const h = idx.history(30);
    expect(pick(h.rows, 'a')).toEqual({ input: 11, output: 7, cacheRead: 100, cacheWrite: 20, messages: 2 });
    expect(h.rows.find((r) => r.source === 'a' && r.family === 'sonnet')?.output).toBe(2);
    expect(h.rows[0]!.day).toBe('2026-10-02');
  });

  it('reads only appended complete lines and survives a restart from the cache file', async () => {
    const f = path.join(roots.b, '-proj', 's.jsonl');
    const line2 = asst('m2', { output_tokens: 7 });
    await fs.writeFile(f, asst('m1', { output_tokens: 3 }) + line2.slice(0, 20)); // partial second line
    const idx = make();
    await idx.refresh();
    expect(pick(idx.history(30).rows, 'b').output).toBe(3);
    await fs.appendFile(f, line2.slice(20));
    await idx.refresh();
    expect(pick(idx.history(30).rows, 'b').output).toBe(10);

    // A fresh instance resumes from the saved offsets: appended bytes only, nothing counted twice.
    await fs.appendFile(f, asst('m3', { output_tokens: 100 }));
    const again = make();
    await again.refresh();
    expect(pick(again.history(30).rows, 'b')).toMatchObject({ output: 110, messages: 3 });
  });

  it('counts a message copied into two accounts once globally and once per account', async () => {
    const shared = asst('m1', { input_tokens: 5 }) + asst('m2', { input_tokens: 7 });
    await fs.writeFile(path.join(roots.a, '-proj', 's.jsonl'), shared);
    await fs.writeFile(path.join(roots.c, '-proj', 's.jsonl'), shared + asst('m3', { input_tokens: 1 }));
    const idx = make();
    await idx.refresh();
    const rows = idx.history(30).rows;
    expect(pick(rows, 'a').input).toBe(12);
    expect(pick(rows, 'c').input).toBe(13);
    expect(pick(rows, 'all').input).toBe(13);
  });

  it('turns Codex cumulative token_count into deltas, skips repeats, splits cached input', async () => {
    const f = path.join(codexRoot, '2026', '10', '02', 'rollout-x.jsonl');
    await fs.writeFile(f, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }) + '\n'
      + tokenCount([100, 40, 0, 10], [100, 40, 0, 10])
      + tokenCount([100, 40, 0, 10], [100, 40, 0, 10]) // repeated event
      + tokenCount([250, 140, 0, 30], [150, 100, 0, 20]));
    await fs.writeFile(path.join(codexRoot, '2026', '10', '02', 'other.jsonl'), tokenCount([999, 0, 0, 999], [999, 0, 0, 999]));
    const idx = make();
    await idx.refresh();
    const rows = idx.history(30).rows;
    expect(pick(rows, 'codex')).toEqual({ input: 110, output: 30, cacheRead: 140, cacheWrite: 0, messages: 2 });
    expect(rows.find((r) => r.source === 'codex')?.family).toBe('gpt');
    expect(pick(rows, 'all').output).toBe(30);
    await fs.appendFile(f, tokenCount([300, 140, 0, 35], [50, 0, 0, 5]));
    await idx.refresh();
    expect(pick(idx.history(30).rows, 'codex')).toMatchObject({ input: 160, output: 35, messages: 3 });
  });

  it('filters by day window and skips synthetic messages', async () => {
    await fs.writeFile(path.join(roots.a, '-proj', 's.jsonl'),
      asst('old', { output_tokens: 1 }, { ts: '2026-08-01T03:00:00Z' })
      + asst('syn', { output_tokens: 9 }, { model: '<synthetic>' })
      + asst('new', { output_tokens: 2 }));
    const idx = make();
    await idx.refresh();
    expect(pick(idx.history(7).rows, 'a').output).toBe(2);
    expect(pick(idx.history(90).rows, 'a').output).toBe(3);
    const saved = JSON.parse(await fs.readFile(indexFile, 'utf8')) as { version: number };
    expect(saved.version).toBe(2);
  });

  it('takes the max output_tokens of a message split over lines and scans, without double counting', async () => {
    const f = path.join(roots.a, '-proj', 's.jsonl');
    await fs.writeFile(f, asst('m1', { input_tokens: 10, output_tokens: 2 }) + asst('m1', { input_tokens: 10, output_tokens: 9 }));
    await fs.writeFile(path.join(roots.c, '-proj', 's.jsonl'), asst('m1', { input_tokens: 10, output_tokens: 2 }));
    const idx = make();
    await idx.refresh();
    expect(pick(idx.history(30).rows, 'a')).toMatchObject({ input: 10, output: 9, messages: 1 });
    expect(pick(idx.history(30).rows, 'c')).toMatchObject({ input: 10, output: 9, messages: 1 }); // a copy joins at the largest output known
    expect(pick(idx.history(30).rows, 'all')).toMatchObject({ input: 10, output: 9, messages: 1 });
    // A later line (next scan, after a restart) with the final count tops every counter up exactly once.
    await fs.appendFile(f, asst('m1', { input_tokens: 10, output_tokens: 15 }));
    const again = make();
    await again.refresh();
    await again.refresh();
    const rows = again.history(30).rows;
    expect(pick(rows, 'a')).toMatchObject({ output: 15, messages: 1 });
    expect(pick(rows, 'all')).toMatchObject({ input: 10, output: 15, messages: 1 });
    expect(pick(rows, 'c').output).toBe(15);
  });

  it('keeps the dedupe map out of the index JSON (append-only .seen log) and still dedupes after restart', async () => {
    const f = path.join(roots.a, '-proj', 's.jsonl');
    await fs.writeFile(f, asst('m1', { output_tokens: 4 }));
    await make().refresh();
    expect(JSON.parse(await fs.readFile(indexFile, 'utf8')).seen).toBeUndefined();
    expect(await fs.readFile(`${indexFile}.seen`, 'utf8')).toContain('m1\t');
    // The same message in a new file after restart: already seen.
    await fs.writeFile(path.join(roots.b, '-proj', 's.jsonl'), asst('m1', { output_tokens: 4 }));
    const again = make();
    await again.refresh();
    expect(pick(again.history(30).rows, 'all')).toMatchObject({ output: 4, messages: 1 });
  });
});

describe('UsageIndex v2 (bit per source, v1 migration)', () => {
  let v1File: string;
  let logs: string[];
  const makeWith = (projectsRoots: Record<string, string>) => new UsageIndex({ projectsRoots: rootsOf(projectsRoots), codexSessionsRoot: codexRoot, indexFile, legacyIndexFile: v1File, now: () => NOW });
  const saved = async () => JSON.parse(await fs.readFile(indexFile, 'utf8')) as { version: number; sources: string[]; seen?: unknown };
  const moreRoots = async (ids: string[]) => {
    const out: Record<string, string> = {};
    for (const id of ids) { out[id] = path.join(dir, id); await fs.mkdir(path.join(out[id]!, '-proj'), { recursive: true }); }
    return out;
  };
  /** A v1 index as the old code wrote it: mask a=1 b=2 c=4 GLOBAL=8, value = mask + maxOutput * 16. */
  const V1_BUCKETS = {
    '2026-10-01|a|opus': [10, 5, 100, 20, 1], '2026-10-01|b|opus': [7, 7, 0, 0, 1], '2026-10-01|c|sonnet': [7, 7, 0, 0, 1],
    '2026-10-01|all|opus': [17, 12, 100, 20, 2], '2026-10-01|codex|gpt': [110, 30, 140, 0, 2], '2026-10-01|all|gpt': [110, 30, 140, 0, 2],
  };
  const V1_SEEN = `m1\t${(1 | 8) + 5 * 16}\nm2\t${(2 | 4 | 8) + 3 * 16}\nm2\t${(2 | 4 | 8) + 7 * 16}\n`;
  async function writeV1(opts: { seenText?: string; inline?: Record<string, number>; extra?: Record<string, unknown> } = {}): Promise<void> {
    await fs.mkdir(path.dirname(v1File), { recursive: true });
    const seenText = opts.seenText ?? V1_SEEN;
    const body = { version: 1, lastScanAt: '2026-10-01T10:00:00.000Z', files: {}, buckets: V1_BUCKETS, ...(opts.inline ? { seen: opts.inline } : { seenLen: Buffer.byteLength(seenText) }), ...opts.extra };
    await fs.writeFile(v1File, JSON.stringify(body));
    // A tail beyond seenLen is what a save that never finished left behind: not part of the counts.
    if (!opts.inline) await fs.writeFile(`${v1File}.seen`, seenText + 'crashed-tail\t9\n');
  }
  const bucketsOf = (rows: UsageRow[]) => Object.fromEntries(rows.map((r) => [`${r.day}|${r.source}|${r.family}`, [r.input, r.output, r.cacheRead, r.cacheWrite, r.messages]]));

  beforeEach(() => {
    v1File = path.join(dir, 'cfg', 'usage-index.json');
    indexFile = path.join(dir, 'cfg', 'usage-index-v2.json');
    logs = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('migrates a v1 index once: same aggregates, sources a/b/c, v1 files left as they were', async () => {
    await writeV1();
    const before = [await fs.readFile(v1File, 'utf8'), await fs.readFile(`${v1File}.seen`, 'utf8')];
    const idx = makeWith(roots);
    await idx.refresh();
    expect(bucketsOf(idx.history(30).rows)).toEqual(V1_BUCKETS);
    expect(idx.history(30).sources).toEqual(['a', 'b', 'c', 'codex']);
    expect(await saved()).toMatchObject({ version: 2, sources: ['a', 'b', 'c'] });
    // GLOBAL moved to bit 0, a/b/c to bits 1–3; mask and max output are separate fields; the last v1 line of an id wins.
    expect((await fs.readFile(`${indexFile}.seen`, 'utf8')).split('\n').sort()).toEqual(['', 'm1\t3\t5', 'm2\t13\t7']);
    expect([await fs.readFile(v1File, 'utf8'), await fs.readFile(`${v1File}.seen`, 'utf8')]).toEqual(before);

    // The migrated dedupe state behaves like the v1 one did: m1 joins b without touching the total; a larger m2 tops b, c and the total up.
    await fs.writeFile(path.join(roots.b, '-proj', 's.jsonl'), asst('m1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }, { ts: '2026-10-01T03:00:00.000Z' }));
    await fs.writeFile(path.join(roots.a, '-proj', 's.jsonl'), asst('m2', { input_tokens: 7, output_tokens: 9 }, { ts: '2026-10-01T03:00:00.000Z' }));
    // The v1 files are not read again once the v2 index exists.
    await fs.writeFile(v1File, 'not json');
    const again = makeWith(roots);
    await again.refresh();
    expect(bucketsOf(again.history(30).rows)).toEqual({
      ...V1_BUCKETS,
      '2026-10-01|a|opus': [17, 14, 100, 20, 2], '2026-10-01|b|opus': [17, 14, 100, 20, 2], '2026-10-01|c|sonnet': [7, 7, 0, 0, 1],
      // m2's top-up lands in the family of the line that carries it (opus here), as in v1.
      '2026-10-01|c|opus': [0, 2, 0, 0, 0], '2026-10-01|all|opus': [17, 14, 100, 20, 2],
    });
    expect(logs.filter((l) => l.includes('버립니다'))).toEqual([]);
  });

  it('migrates the oldest v1 form (dedupe map inline in the JSON)', async () => {
    await writeV1({ inline: { m1: 1 | 8, m2: (2 | 8) + 7 * 16 } });
    const idx = makeWith(roots);
    await idx.refresh();
    expect(bucketsOf(idx.history(30).rows)).toEqual(V1_BUCKETS);
    expect((await fs.readFile(`${indexFile}.seen`, 'utf8')).split('\n').sort()).toEqual(['', 'm1\t3\t0', 'm2\t5\t7']);
    expect((await saved()).seen).toBeUndefined();
  });

  it('migrates again when a first attempt stopped before the v2 index was written', async () => {
    await writeV1();
    await fs.writeFile(`${indexFile}.seen`, 'half\t3');
    const idx = makeWith(roots);
    await idx.refresh();
    expect(bucketsOf(idx.history(30).rows)).toEqual(V1_BUCKETS);
    expect((await fs.readFile(`${indexFile}.seen`, 'utf8')).split('\n').sort()).toEqual(['', 'm1\t3\t5', 'm2\t13\t7']);
  });

  it('counts a fourth and fifth account without colliding with the global total', async () => {
    const five: Record<string, string> = { ...roots, ...(await moreRoots(['d', 'e'])) };
    // Only in d: in v1 d would have had GLOBAL's bit, and the total would have skipped it.
    await fs.writeFile(path.join(five.d!, '-proj', 's.jsonl'), asst('m1', { input_tokens: 5 }) + asst('m2', { input_tokens: 7 }));
    await fs.writeFile(path.join(five.e!, '-proj', 's.jsonl'), asst('m2', { input_tokens: 7 }) + asst('m3', { input_tokens: 1 }));
    await fs.writeFile(path.join(five.a!, '-proj', 's.jsonl'), asst('m2', { input_tokens: 7 }));
    const idx = makeWith(five);
    await idx.refresh();
    const check = (rows: UsageRow[]) => {
      expect(pick(rows, 'd')).toMatchObject({ input: 12, messages: 2 });
      expect(pick(rows, 'e')).toMatchObject({ input: 8, messages: 2 });
      expect(pick(rows, 'a')).toMatchObject({ input: 7, messages: 1 });
      expect(pick(rows, 'b').messages).toBe(0);
      expect(pick(rows, 'all')).toMatchObject({ input: 13, messages: 3 });
    };
    check(idx.history(30).rows);
    expect(idx.history(30).sources).toEqual(['a', 'b', 'c', 'd', 'e', 'codex']);
    expect((await saved()).sources).toEqual(['a', 'b', 'c', 'd', 'e']);
    // After a restart the same messages in new files are already seen, per account and globally.
    await fs.writeFile(path.join(five.d!, '-proj', 't.jsonl'), asst('m1', { input_tokens: 5 }) + asst('m3', { input_tokens: 1 }));
    await fs.writeFile(path.join(five.e!, '-proj', 't.jsonl'), asst('m2', { input_tokens: 7 }));
    const again = makeWith(five);
    await again.refresh();
    expect(pick(again.history(30).rows, 'd')).toMatchObject({ input: 13, messages: 3 });
    expect(pick(again.history(30).rows, 'e')).toMatchObject({ input: 8, messages: 2 });
    expect(pick(again.history(30).rows, 'all')).toMatchObject({ input: 13, messages: 3 });
  });

  it('keeps the usage and the bit of an account that left the configuration; a new account goes to the end', async () => {
    const four: Record<string, string> = { ...roots, ...(await moreRoots(['d'])) };
    await fs.writeFile(path.join(four.d!, '-proj', 's.jsonl'), asst('m1', { input_tokens: 5 }));
    await fs.writeFile(path.join(four.b!, '-proj', 's.jsonl'), asst('m2', { input_tokens: 2 }));
    await makeWith(four).refresh();

    const later: Record<string, string> = { a: roots.a, ...(await moreRoots(['e'])) };
    await fs.writeFile(path.join(later.e!, '-proj', 's.jsonl'), asst('m1', { input_tokens: 5 }) + asst('m9', { input_tokens: 1 }));
    const idx = makeWith(later);
    await idx.refresh();
    const rows = idx.history(30).rows;
    expect(pick(rows, 'd')).toMatchObject({ input: 5, messages: 1 });
    expect(pick(rows, 'b')).toMatchObject({ input: 2, messages: 1 });
    expect(pick(rows, 'e')).toMatchObject({ input: 6, messages: 2 }); // e did not inherit d's bit
    expect(pick(rows, 'all')).toMatchObject({ input: 8, messages: 3 });
    expect((await saved()).sources).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('counts a later, larger output for every account that holds the message, whatever its bit', async () => {
    const five: Record<string, string> = { ...roots, ...(await moreRoots(['d', 'e'])) };
    await fs.writeFile(path.join(five.d!, '-proj', 's.jsonl'), asst('m1', { output_tokens: 2 }));
    await fs.writeFile(path.join(five.e!, '-proj', 's.jsonl'), asst('m1', { output_tokens: 2 }));
    await makeWith(five).refresh();
    await fs.appendFile(path.join(five.e!, '-proj', 's.jsonl'), asst('m1', { output_tokens: 300_000 }));
    const idx = makeWith(five);
    await idx.refresh();
    for (const s of ['d', 'e', 'all']) expect(pick(idx.history(30).rows, s)).toMatchObject({ output: 300_000, messages: 1 });
    expect(await fs.readFile(`${indexFile}.seen`, 'utf8')).toContain(`m1\t${1 | 16 | 32}\t300000\n`);
  });

  describe('an index that cannot be read is dropped (logged) and everything is scanned again', () => {
    const cases: [string, () => Promise<void>][] = [
      ['broken JSON', async () => { await fs.writeFile(indexFile, '{"version":2,'); }],
      ['a version this code does not know', async () => { const s = JSON.parse(await fs.readFile(indexFile, 'utf8')); await fs.writeFile(indexFile, JSON.stringify({ ...s, version: 3 })); }],
      ['a v1 body under the v2 name', async () => { const s = JSON.parse(await fs.readFile(indexFile, 'utf8')); delete s.sources; await fs.writeFile(indexFile, JSON.stringify({ ...s, version: 1 })); }],
      ['a dedupe line that does not parse', async () => { await fs.writeFile(`${indexFile}.seen`, 'm1\t3\tx\n'); await fs.writeFile(indexFile, JSON.stringify({ ...JSON.parse(await fs.readFile(indexFile, 'utf8')), seenLen: 7 })); }],
      ['a v1-shaped dedupe line', async () => { await fs.writeFile(`${indexFile}.seen`, 'm1\t73\n'); await fs.writeFile(indexFile, JSON.stringify({ ...JSON.parse(await fs.readFile(indexFile, 'utf8')), seenLen: 6 })); }],
      ['a mask with a bit no source has', async () => { await fs.writeFile(`${indexFile}.seen`, 'm1\t33\t4\n'); await fs.writeFile(indexFile, JSON.stringify({ ...JSON.parse(await fs.readFile(indexFile, 'utf8')), seenLen: 8 })); }],
      ['a dedupe log shorter than the index counted', async () => { await fs.writeFile(`${indexFile}.seen`, ''); }],
      ['a missing dedupe log', async () => { await fs.rm(`${indexFile}.seen`); }],
      ['a bucket that is not five numbers', async () => { const s = JSON.parse(await fs.readFile(indexFile, 'utf8')); s.buckets['2026-10-02|a|opus'] = [1, 'x']; await fs.writeFile(indexFile, JSON.stringify(s)); }],
    ];
    for (const [name, corrupt] of cases) {
      it(name, async () => {
        await fs.writeFile(path.join(roots.a, '-proj', 's.jsonl'), asst('m1', { input_tokens: 3, output_tokens: 4 }));
        await makeWith(roots).refresh();
        await corrupt();
        const broken = await fs.readFile(indexFile, 'utf8');
        logs = [];
        const idx = makeWith(roots);
        await idx.refresh();
        expect(logs.filter((l) => l.includes('버립니다'))).toHaveLength(1);
        expect(logs.join('\n')).toContain(indexFile);
        // What was given up on is kept aside, not overwritten.
        expect(await fs.readFile(`${indexFile}.bad`, 'utf8')).toBe(broken);
        // Scanned from zero exactly once: neither lost nor doubled.
        expect(pick(idx.history(30).rows, 'a')).toEqual({ input: 3, output: 4, cacheRead: 0, cacheWrite: 0, messages: 1 });
        expect(pick(idx.history(30).rows, 'all')).toMatchObject({ output: 4, messages: 1 });
        expect(await saved()).toMatchObject({ version: 2 });
        const third = makeWith(roots);
        await third.refresh();
        expect(pick(third.history(30).rows, 'all')).toMatchObject({ output: 4, messages: 1 });
      });
    }

    it('a v1 index that cannot be converted (unknown line, mask without a counter)', async () => {
      for (const seenText of ['m1\tabc\n', 'm1\t80\n', 'no-tab\n', 'm1\t9.5\n']) {
        await fs.rm(indexFile, { force: true });
        await writeV1({ seenText });
        await fs.writeFile(path.join(roots.a, '-proj', 's.jsonl'), asst('m1', { input_tokens: 3, output_tokens: 4 }));
        logs = [];
        const idx = makeWith(roots);
        await idx.refresh();
        expect(logs.filter((l) => l.includes('버립니다') && l.includes(v1File))).toHaveLength(1);
        expect(await fs.readFile(`${v1File}.seen`, 'utf8')).toContain(seenText); // v1 files are never moved or written
        expect(bucketsOf(idx.history(30).rows)).toEqual({ '2026-10-02|a|opus': [3, 4, 0, 0, 1], '2026-10-02|all|opus': [3, 4, 0, 0, 1] });
      }
    });

    it('nothing is logged when there is simply no index yet', async () => {
      await makeWith(roots).refresh();
      expect(logs).toEqual([]);
    });
  });

  it('refuses a source beyond the bit width with a log, and counts the others exactly', async () => {
    const ids = Array.from({ length: MAX_USAGE_ACCOUNTS + 1 }, (_, i) => `x${i}`);
    const many = await moreRoots(ids);
    for (const id of ids) await fs.writeFile(path.join(many[id]!, '-proj', 's.jsonl'), asst('shared', { input_tokens: 2 }) + asst(`own-${id}`, { input_tokens: 1 }));
    const idx = makeWith(many);
    await idx.refresh();
    await idx.refresh();
    const rows = idx.history(30).rows;
    const over = ids.at(-1)!;
    for (const id of ids.slice(0, -1)) expect(pick(rows, id)).toMatchObject({ input: 3, messages: 2 });
    expect(rows.filter((r) => r.source === over)).toEqual([]);
    expect(pick(rows, 'all')).toMatchObject({ input: 2 + MAX_USAGE_ACCOUNTS, messages: 1 + MAX_USAGE_ACCOUNTS });
    expect(logs.filter((l) => l.includes(over) && l.includes(String(MAX_USAGE_ACCOUNTS)))).toHaveLength(1);
    expect((await saved()).sources).toEqual(ids.slice(0, -1));
    const again = makeWith(many);
    await again.refresh();
    expect(pick(again.history(30).rows, 'all')).toMatchObject({ input: 2 + MAX_USAGE_ACCOUNTS, messages: 1 + MAX_USAGE_ACCOUNTS });
  });

  const noDrops = () => expect(logs.filter((l) => l.includes('버립니다') || l.includes('scan failed'))).toEqual([]);
  /** Two more starts on what the last one saved: the index is read back as it is, never dropped. */
  async function restartTwice(projectsRoots: Record<string, string>): Promise<UsageIndex> {
    await makeWith(projectsRoots).refresh();
    const idx = makeWith(projectsRoots);
    await idx.refresh();
    noDrops();
    await expect(fs.stat(`${indexFile}.bad`)).rejects.toMatchObject({ code: 'ENOENT' });
    return idx;
  }

  it('cuts an output_tokens beyond what the dedupe value can hold, and reads its own index back', async () => {
    const cap = 2 ** 29 - 1;
    await fs.writeFile(path.join(roots.a, '-proj', 's.jsonl'), asst('huge', { input_tokens: 1e300, output_tokens: 600_000_000 }) + asst('m1', { output_tokens: 4 }));
    await fs.writeFile(path.join(roots.b, '-proj', 's.jsonl'), asst('huge', { input_tokens: 1e300, output_tokens: 600_000_000 }));
    await makeWith(roots).refresh();
    expect(await fs.readFile(`${indexFile}.seen`, 'utf8')).toContain(`huge\t${1 | 2 | 4}\t${cap}\n`);
    const idx = await restartTwice(roots);
    expect(pick(idx.history(30).rows, 'a')).toEqual({ input: cap, output: cap + 4, cacheRead: 0, cacheWrite: 0, messages: 2 });
    expect(pick(idx.history(30).rows, 'b')).toMatchObject({ output: cap, messages: 1 });
    expect(pick(idx.history(30).rows, 'all')).toMatchObject({ output: cap + 4, messages: 2 });
  });

  it('floors fractional token counts (Claude and Codex), and reads its own index back', async () => {
    await fs.writeFile(path.join(roots.a, '-proj', 's.jsonl'), asst('frac', { input_tokens: 1.9, output_tokens: 2.5, cache_read_input_tokens: 0.5 }) + asst('frac', { input_tokens: 1.9, output_tokens: 3.2 }));
    await fs.writeFile(path.join(codexRoot, '2026', '10', '02', 'rollout-f.jsonl'), tokenCount([100.7, 40.2, 0, 10.9], [100.7, 40.2, 0, 10.9]) + tokenCount([1e300, 40.2, 0, 10.9], [1, 0, 0, 0]));
    await makeWith(roots).refresh();
    expect(await fs.readFile(`${indexFile}.seen`, 'utf8')).toBe('frac\t3\t3\n');
    const idx = await restartTwice(roots);
    expect(pick(idx.history(30).rows, 'a')).toEqual({ input: 1, output: 3, cacheRead: 0, cacheWrite: 0, messages: 1 });
    expect(pick(idx.history(30).rows, 'codex')).toEqual({ input: Number.MAX_SAFE_INTEGER - 40, output: 10, cacheRead: 40, cacheWrite: 0, messages: 2 });
  });

  it('leaves out a message whose id would split its dedupe line (logged once), and reads its own index back', async () => {
    await fs.writeFile(path.join(roots.a, '-proj', 's.jsonl'), asst('m\t1', { output_tokens: 5 }) + asst('m\n2', { output_tokens: 5 }) + asst('m\r3', { output_tokens: 5 }) + asst('ok', { output_tokens: 4 }));
    await makeWith(roots).refresh();
    expect(logs.filter((l) => l.includes('메시지 id'))).toHaveLength(1);
    expect(await fs.readFile(`${indexFile}.seen`, 'utf8')).toBe('ok\t3\t4\n');
    const idx = await restartTwice(roots);
    expect(pick(idx.history(30).rows, 'a')).toMatchObject({ output: 4, messages: 1 });
    expect(pick(idx.history(30).rows, 'all')).toMatchObject({ output: 4, messages: 1 });
  });

  it('appends after the last whole line when an earlier append left a piece behind', async () => {
    const f = path.join(roots.a, '-proj', 's.jsonl');
    await fs.writeFile(f, asst('m1', { output_tokens: 4 }));
    const idx = makeWith(roots);
    await idx.refresh();
    // What appendFile leaves when it fails after writing part of its data (ENOSPC, EIO): the save threw, the process lives on.
    await fs.appendFile(`${indexFile}.seen`, 'm2\t3');
    await fs.appendFile(f, asst('m2', { output_tokens: 7 }) + asst('m3', { output_tokens: 1 }));
    await idx.refresh();
    expect(await fs.readFile(`${indexFile}.seen`, 'utf8')).toBe('m1\t3\t4\nm2\t3\t7\nm3\t3\t1\n');
    const again = await restartTwice(roots);
    expect(pick(again.history(30).rows, 'a')).toMatchObject({ output: 12, messages: 3 });
  });

  it('drops what lies beyond seenLen in the dedupe log (a save that never finished) and counts those messages', async () => {
    const f = path.join(roots.a, '-proj', 's.jsonl');
    await fs.writeFile(f, asst('m1', { output_tokens: 4 }));
    await makeWith(roots).refresh();
    // The log was appended, the index was not rewritten: its offsets and counts do not include these.
    await fs.appendFile(`${indexFile}.seen`, 'm2\t3\t7\nm3\t3');
    await fs.appendFile(f, asst('m2', { output_tokens: 7 }));
    const idx = makeWith(roots);
    await idx.refresh();
    noDrops();
    expect(pick(idx.history(30).rows, 'a')).toMatchObject({ output: 11, messages: 2 });
    expect(await fs.readFile(`${indexFile}.seen`, 'utf8')).toBe('m1\t3\t4\nm2\t3\t7\n');
    await restartTwice(roots);
  });

  it('dedupes and tops up on the last bit (account 23) across restarts', async () => {
    const ids = Array.from({ length: MAX_USAGE_ACCOUNTS }, (_, i) => `x${i}`);
    const many = await moreRoots(ids);
    const last = ids.at(-1)!;
    await fs.writeFile(path.join(many[last]!, '-proj', 's.jsonl'), asst('m1', { input_tokens: 3, output_tokens: 2 }));
    await fs.writeFile(path.join(many.x0!, '-proj', 's.jsonl'), asst('m1', { input_tokens: 3, output_tokens: 2 }));
    await makeWith(many).refresh();
    expect(await fs.readFile(`${indexFile}.seen`, 'utf8')).toContain(`m1\t${1 + 2 + 2 ** MAX_USAGE_ACCOUNTS}\t2\n`);
    // After a restart: the same message again in the last account (already counted), a larger output in the first.
    await fs.writeFile(path.join(many[last]!, '-proj', 't.jsonl'), asst('m1', { input_tokens: 3, output_tokens: 2 }));
    await fs.appendFile(path.join(many.x0!, '-proj', 's.jsonl'), asst('m1', { input_tokens: 3, output_tokens: 9 }));
    const idx = await restartTwice(many);
    for (const s of [last, 'x0', 'all']) expect(pick(idx.history(30).rows, s)).toEqual({ input: 3, output: 9, cacheRead: 0, cacheWrite: 0, messages: 1 });
    expect(pick(idx.history(30).rows, 'x1').messages).toBe(0);
  });

  it('converts the v1 files again when the v2 index broke, counting what came after the migration exactly once', async () => {
    await writeV1();
    await makeWith(roots).refresh();
    // After the migration: one new message, and one the v1 index had already counted for a (m1).
    await fs.writeFile(path.join(roots.a, '-proj', 's.jsonl'),
      asst('m1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }, { ts: '2026-10-01T03:00:00.000Z' }) + asst('m5', { input_tokens: 4 }));
    const expected = { ...V1_BUCKETS, '2026-10-02|a|opus': [4, 0, 0, 0, 1], '2026-10-02|all|opus': [4, 0, 0, 0, 1] };
    const first = makeWith(roots);
    await first.refresh();
    expect(bucketsOf(first.history(30).rows)).toEqual(expected);
    await fs.writeFile(indexFile, '{"version":2,"sour');
    logs = [];
    const idx = makeWith(roots);
    await idx.refresh();
    expect(logs.filter((l) => l.includes('버립니다'))).toHaveLength(1);
    expect(logs.filter((l) => l.includes('옮겼습니다'))).toHaveLength(1);
    expect(bucketsOf(idx.history(30).rows)).toEqual(expected);
    expect(await fs.readFile(`${indexFile}.bad`, 'utf8')).toBe('{"version":2,"sour');
    expect(await fs.readFile(`${indexFile}.seen.bad`, 'utf8')).toContain('m5\t3\t0\n');
    logs = [];
    await fs.rm(`${indexFile}.bad`);
    const again = await restartTwice(roots);
    expect(bucketsOf(again.history(30).rows)).toEqual(expected);
  });

  it('a read error is a failed scan, not a broken index: nothing is dropped, moved or converted, and the next scan loads it', async () => {
    await fs.writeFile(path.join(roots.a, '-proj', 's.jsonl'), asst('m1', { input_tokens: 3, output_tokens: 4 }));
    await makeWith(roots).refresh();
    const before = [await fs.readFile(indexFile, 'utf8'), await fs.readFile(`${indexFile}.seen`, 'utf8')];
    await writeV1(); // still there from before the migration: must not be taken instead
    const eio = () => Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
    for (const target of [indexFile, `${indexFile}.seen`]) {
      const real = fs.readFile.bind(fs);
      const spy = vi.spyOn(fs, 'readFile').mockImplementation(((file: unknown, ...rest: unknown[]) => (file === target ? Promise.reject(eio()) : (real as (...a: unknown[]) => Promise<unknown>)(file, ...rest))) as typeof fs.readFile);
      logs = [];
      const idx = makeWith(roots);
      await idx.refresh();
      expect(logs.filter((l) => l.includes('scan failed') && l.includes('EIO'))).toHaveLength(1);
      expect(logs.filter((l) => l.includes('버립니다') || l.includes('옮겼습니다'))).toEqual([]);
      expect(idx.history(30).rows).toEqual([]);
      spy.mockRestore();
      expect([await fs.readFile(indexFile, 'utf8'), await fs.readFile(`${indexFile}.seen`, 'utf8')]).toEqual(before);
      await expect(fs.stat(`${indexFile}.bad`)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(`${indexFile}.seen.bad`)).rejects.toMatchObject({ code: 'ENOENT' });
      // The next cycle of the same instance reads the index that was there all along.
      logs = [];
      await idx.refresh();
      noDrops();
      expect(bucketsOf(idx.history(30).rows)).toEqual({ '2026-10-02|a|opus': [3, 4, 0, 0, 1], '2026-10-02|all|opus': [3, 4, 0, 0, 1] });
    }
  });
});
