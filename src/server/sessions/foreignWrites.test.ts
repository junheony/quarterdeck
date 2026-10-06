import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyLine, foreignWriteSince, scanForeign } from './foreignWrites';

const T0 = Date.parse('2026-10-05T10:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
let n = 0;
const entry = (o: { type?: string; entrypoint?: string | null; ms: number; side?: boolean; text?: string; content?: unknown; meta?: boolean }) => JSON.stringify({
  parentUuid: n ? `u${n}` : null, isSidechain: !!o.side, type: o.type ?? 'user', uuid: `u${++n}`, timestamp: at(o.ms),
  ...(o.entrypoint === null ? {} : { entrypoint: o.entrypoint ?? 'sdk-ts' }),
  ...(o.meta ? { isMeta: true } : {}),
  message: { role: o.type ?? 'user', content: o.content ?? o.text ?? 'x' },
});
const meta = (type: string) => JSON.stringify({ type, sessionId: 's' });

let dir: string;
beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-foreign-')); });
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });
async function transcript(name: string, lines: string[]): Promise<string> {
  const f = path.join(dir, name);
  await fs.writeFile(f, lines.join('\n') + '\n');
  return f;
}

describe('classifyLine', () => {
  it('foreign = a main-chain user/assistant entry at or after `since` from another entrypoint', () => {
    expect(classifyLine(entry({ entrypoint: 'claude-desktop', ms: 0 }), T0)).toBe('foreign');
    expect(classifyLine(entry({ type: 'assistant', entrypoint: 'cli', ms: 5 }), T0)).toBe('foreign');
    expect(classifyLine(entry({ entrypoint: 'sdk-ts', ms: 5 }), T0)).toBeNull();
    // Sidechain (subagent) entries, attachments and entries that do not say who wrote them are not a foreign turn.
    expect(classifyLine(entry({ entrypoint: 'claude-desktop', ms: 5, side: true }), T0)).toBeNull();
    expect(classifyLine(entry({ type: 'attachment', entrypoint: 'claude-desktop', ms: 5 }), T0)).toBeNull();
    expect(classifyLine(entry({ entrypoint: null, ms: 5 }), T0)).toBeNull();
  });

  it('only the conversation going on counts: a slash command, its output, a task notification, a meta entry or a tool result in Desktop is not foreign', () => {
    const desk = (o: { text?: string; content?: unknown; meta?: boolean }) => classifyLine(entry({ entrypoint: 'claude-desktop', ms: 5, ...o }), T0);
    expect(desk({ text: '<command-name>/model</command-name>\n<command-message>model</command-message>' })).toBeNull();
    expect(desk({ text: '<local-command-stdout>Set model to opus</local-command-stdout>' })).toBeNull();
    expect(desk({ text: '<local-command-caveat>Caveat: the messages below…</local-command-caveat>' })).toBeNull();
    expect(desk({ text: '<task-notification>\n<task-id>x</task-id></task-notification>' })).toBeNull();
    expect(desk({ content: [{ type: 'text', text: '<task-notification>done</task-notification>' }] })).toBeNull();
    expect(desk({ text: 'a real prompt', meta: true })).toBeNull();
    expect(desk({ content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] })).toBeNull();
    // What somebody typed, as a string or as blocks (an image first), and any assistant entry.
    expect(desk({ text: 'a real prompt' })).toBe('foreign');
    expect(desk({ content: [{ type: 'image', source: {} }, { type: 'text', text: 'look at <this>' }] })).toBe('foreign');
    expect(classifyLine(entry({ type: 'assistant', entrypoint: 'claude-desktop', ms: 5, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }), T0)).toBe('foreign');
  });

  it('old = a conversation line from well before `since`; a line just before it, metadata and junk are neither', () => {
    expect(classifyLine(entry({ entrypoint: 'claude-desktop', ms: -120_000 }), T0)).toBe('old');
    expect(classifyLine(entry({ entrypoint: 'claude-desktop', ms: -1000 }), T0)).toBeNull();
    expect(classifyLine(meta('custom-title'), T0)).toBeNull();
    expect(classifyLine('{"timestamp": broken', T0)).toBeNull();
    expect(classifyLine('', T0)).toBeNull();
  });
});

describe('foreignWriteSince', () => {
  it("only deck's own entries since the process started: not foreign", async () => {
    const f = await transcript('own.jsonl', [entry({ ms: -300_000 }), entry({ type: 'assistant', ms: -299_000 }), entry({ ms: 1000 }), entry({ type: 'assistant', ms: 2000 }), meta('last-prompt')]);
    expect(await foreignWriteSince(f, T0)).toBe(false);
  });

  it('Desktop went on with the session after the process started: foreign, also behind trailing metadata lines', async () => {
    const f = await transcript('desktop.jsonl', [
      entry({ ms: -300_000 }), entry({ type: 'assistant', ms: -299_000 }),
      entry({ ms: 1000 }),
      entry({ entrypoint: 'claude-desktop', ms: 3000, text: 'from desktop' }), entry({ type: 'assistant', entrypoint: 'claude-desktop', ms: 4000 }),
      entry({ type: 'assistant', ms: 5000 }),
      meta('custom-title'), meta('agent-name'), meta('mode'),
    ]);
    expect(await foreignWriteSince(f, T0)).toBe(true);
    // Counted from after Desktop's last entry, nothing foreign is left.
    expect(await foreignWriteSince(f, T0 + 4500)).toBe(false);
  });

  it('what Desktop wrote before the process started was read by it: not foreign', async () => {
    const f = await transcript('before.jsonl', [entry({ entrypoint: 'claude-desktop', ms: -200_000 }), entry({ type: 'assistant', entrypoint: 'claude-desktop', ms: -199_000 }), entry({ ms: 10 }), entry({ type: 'assistant', ms: 20 })]);
    expect(await foreignWriteSince(f, T0)).toBe(false);
  });

  it('reads backwards across chunks: a foreign entry in front of a very long own line is found, one behind old lines is not looked for', async () => {
    const big = 'y'.repeat(200_000);
    const f = await transcript('long.jsonl', [entry({ ms: -300_000 }), entry({ entrypoint: 'cli', ms: 100 }), entry({ type: 'assistant', ms: 200, text: big }), entry({ ms: 300, text: big })]);
    expect(await foreignWriteSince(f, T0)).toBe(true);
    const g = await transcript('stop.jsonl', [entry({ entrypoint: 'cli', ms: 100 }), entry({ ms: 400_000, text: big }), entry({ type: 'assistant', ms: 401_000 })]);
    expect(await foreignWriteSince(g, T0 + 402_000)).toBe(false);
  });

  it('a missing or empty file is "no"', async () => {
    expect(await foreignWriteSince(path.join(dir, 'nope.jsonl'), T0)).toBe(false);
    const f = path.join(dir, 'empty.jsonl');
    await fs.writeFile(f, '');
    expect(await foreignWriteSince(f, T0)).toBe(false);
  });
});

describe('scanForeign (cursor)', () => {
  it('hands back the offset it found clean up to; the next scan reads only what came after it', async () => {
    const f = await transcript('cursor.jsonl', [entry({ ms: 1000 }), entry({ type: 'assistant', ms: 2000 })]);
    const first = await scanForeign(f, T0);
    expect(first).toEqual({ foreign: false, end: (await fs.stat(f)).size });
    // Nothing appended: nothing read.
    expect(await scanForeign(f, T0, first.end)).toEqual(first);
    await fs.appendFile(f, entry({ ms: 3000 }) + '\n');
    const second = await scanForeign(f, T0, first.end);
    expect(second).toEqual({ foreign: false, end: (await fs.stat(f)).size });
    await fs.appendFile(f, entry({ entrypoint: 'claude-desktop', ms: 4000 }) + '\n' + entry({ type: 'assistant', ms: 5000 }) + '\n');
    // Found: the cursor stays, so the answer is the same until the caller starts over.
    expect(await scanForeign(f, T0, second.end)).toEqual({ foreign: true, end: second.end });
    expect(await scanForeign(f, T0, second.end)).toEqual({ foreign: true, end: second.end });
  });

  it('does not look before the cursor: a foreign entry there was the previous scan\'s to report', async () => {
    const lines = [entry({ entrypoint: 'claude-desktop', ms: 1000 }), entry({ ms: 2000 })];
    const f = await transcript('behind.jsonl', lines);
    const from = Buffer.byteLength(lines[0]! + '\n');
    expect((await scanForeign(f, T0, from)).foreign).toBe(false);
    expect((await scanForeign(f, T0, 0)).foreign).toBe(true);
  });

  it('a line still being written is not passed over: the cursor waits for its newline', async () => {
    const f = await transcript('partial.jsonl', [entry({ ms: 1000 })]);
    const size = (await fs.stat(f)).size;
    const half = entry({ entrypoint: 'claude-desktop', ms: 2000 });
    await fs.appendFile(f, half.slice(0, 40));
    expect(await scanForeign(f, T0, size)).toEqual({ foreign: false, end: size });
    await fs.appendFile(f, half.slice(40) + '\n');
    expect((await scanForeign(f, T0, size)).foreign).toBe(true);
  });

  it('a file that shrank below the cursor (rewritten) is read whole; lines longer than a chunk after the cursor are joined', async () => {
    const f = await transcript('rewritten.jsonl', [entry({ entrypoint: 'cli', ms: 1000 })]);
    expect((await scanForeign(f, T0, 1_000_000)).foreign).toBe(true);
    const big = 'y'.repeat(200_000);
    const head = [entry({ ms: 1000 })];
    const g = await transcript('longtail.jsonl', head);
    const from = (await fs.stat(g)).size;
    await fs.appendFile(g, entry({ entrypoint: 'cli', ms: 2000, text: big }) + '\n' + entry({ type: 'assistant', ms: 3000, text: big }) + '\n');
    expect((await scanForeign(g, T0, from)).foreign).toBe(true);
  });
});
