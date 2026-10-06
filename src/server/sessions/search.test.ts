import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionEntry } from '../../shared/session-types';
import { TranscriptSearch } from './search';

const L = (o: unknown) => JSON.stringify(o) + '\n';
const user = (text: string) => L({ type: 'user', cwd: '/w/p', message: { role: 'user', content: text } });
const assistant = (id: string, text: string) => L({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }] } });
const toolResult = (text: string) => L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: text }] } });

async function session(dir: string, id: string, body: string, lastModified: number): Promise<SessionEntry> {
  const file = path.join(dir, `${id}.jsonl`);
  await fs.writeFile(file, body);
  return { sessionId: id, account: 'b', engine: 'claude', cwd: '/w/p', projectDir: dir, file, title: `title ${id}`, lastModified, sizeBytes: body.length };
}

describe('TranscriptSearch', () => {
  it('finds user and assistant text (not tool output), newest session first, with a highlighted snippet', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-search-'));
    const a = await session(dir, 'aaa', user('please fix the Flaky websocket test') + assistant('m1', 'Done.') + toolResult('flaky websocket in tool output'), 1);
    const b = await session(dir, 'bbb', user('hello') + assistant('m2', 'The flaky WEBSOCKET reconnect is fixed now.'), 2);
    const c = await session(dir, 'ccc', user('unrelated'), 3);
    const s = new TranscriptSearch({ sessions: () => [a, b, c] });
    const r = await s.search('flaky websocket');
    expect(r.scanned).toBe(3);
    expect(r.hits.map((h) => [h.sessionId, h.role])).toEqual([['bbb', 'assistant'], ['aaa', 'user']]);
    const h = r.hits[0]!;
    expect(h.title).toBe('title bbb');
    expect(h.snippet.slice(h.matchStart, h.matchStart + h.matchLength).toLowerCase()).toBe('flaky websocket');
  });

  it('short queries return nothing; long text is snipped with ellipses', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-search-'));
    const long = `${'x'.repeat(500)} needle ${'y'.repeat(500)}`;
    const a = await session(dir, 'aaa', user(long), 1);
    const s = new TranscriptSearch({ sessions: () => [a] });
    expect((await s.search('n')).hits).toEqual([]);
    const [h] = (await s.search('needle')).hits;
    expect(h!.snippet.startsWith('…')).toBe(true);
    expect(h!.snippet.endsWith('…')).toBe(true);
    expect(h!.snippet.length).toBeLessThan(200);
    expect(h!.snippet.slice(h!.matchStart, h!.matchStart + 6)).toBe('needle');
  });

  it('caches by mtime/size: unchanged files are not re-read, changed ones are', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-search-'));
    const a = await session(dir, 'aaa', user('alpha'), 1);
    let reads = 0;
    const { readTranscript } = await import('./transcript');
    const s = new TranscriptSearch({ sessions: () => [a], readClaude: (f) => { reads++; return readTranscript(f, { maxMessages: Infinity }); } });
    await s.search('alpha');
    await s.search('alpha');
    expect(reads).toBe(1);
    await fs.appendFile(a.file, user('beta gamma'));
    expect((await s.search('gamma')).hits).toHaveLength(1);
    expect(reads).toBe(2);
  });

  it('skips files over the size cap (truncated) and missing files; respects the hit limit', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-search-'));
    const big = await session(dir, 'big', user(`match ${'z'.repeat(2000)}`), 1);
    const gone = { ...big, sessionId: 'gone', file: path.join(dir, 'missing.jsonl') };
    const r = await new TranscriptSearch({ sessions: () => [big, gone], maxFileBytes: 100 }).search('match');
    expect(r).toMatchObject({ hits: [], scanned: 0, truncated: true });
    const many = await Promise.all(Array.from({ length: 5 }, (_, i) => session(dir, `s${i}`, user('match here'), i)));
    const limited = await new TranscriptSearch({ sessions: () => many }).search('match', 3);
    expect(limited.hits).toHaveLength(3);
    expect(limited.truncated).toBe(true);
  });

  it('reads Codex sessions through the rollout reader', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-search-'));
    const file = path.join(dir, 'rollout.jsonl');
    await fs.writeFile(file, 'x');
    const entry: SessionEntry = { sessionId: 'thr', account: 'gpt', engine: 'codex', cwd: '/w', projectDir: dir, file, title: 'gpt', lastModified: 1, sizeBytes: 1 };
    const s = new TranscriptSearch({ sessions: () => [entry], readCodex: async () => [{ kind: 'assistant', text: 'codex answer here', model: null, toolCalls: [], ts: null }] });
    expect((await s.search('answer')).hits[0]).toMatchObject({ sessionId: 'thr', engine: 'codex', account: 'gpt' });
  });
});
