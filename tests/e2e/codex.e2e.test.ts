import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import type { ServerMessage } from '../../src/shared/protocol';
import { resolveCodexBin } from '../../src/server/engine/CodexEngine';
import { collect, pngSolid, startDeck, upload, type Deck } from './harness';

type Result = Extract<ServerMessage, { type: 'turn_result' }>;
const codexPresent = resolveCodexBin(process.env, os.homedir()) !== null;
let deck: Deck;

beforeAll(async () => { deck = await startDeck(); });
afterAll(async () => { await deck?.stop(); });

// Each case is one short ChatGPT call. The Codex threads stay under ~/.codex/sessions (history; not deleted).
describe.skipIf(!codexPresent)('deck e2e: Codex (ChatGPT Pro) sessions', () => {
  let threadId = '';

  it('new GPT session on gpt-6-sol replies ok, badge says gpt, session is listed, GPT weekly becomes known (D1, D4, D5)', async () => {
    const ws = await deck.connect();
    const [hello] = await collect(ws, (m) => m.type === 'hello');
    expect(hello).toMatchObject({ type: 'hello', codex: { available: true } });
    const p = collect(ws, (m) => m.type === 'index');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: deck.workDir, text: 'Reply with exactly: ok', engine: 'codex', sandbox: 'read-only' }));
    const msgs = await p;
    expect(msgs.find((m) => m.type === 'turn_started')).toMatchObject({ account: 'gpt', engine: 'codex', model: 'gpt-6-sol', reason: 'GPT 지정' });
    const result = msgs.find((m) => m.type === 'turn_result') as Result;
    expect(result.ok).toBe(true);
    expect(result.text.trim().toLowerCase()).toBe('ok');
    expect(result.badge).toMatchObject({ account: 'gpt', model: 'gpt-6-sol' });
    expect(result.badge!.usage.outputTokens).toBeGreaterThan(0);
    threadId = result.sessionId ?? '';
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/);
    const index = msgs.at(-1) as Extract<ServerMessage, { type: 'index' }>;
    expect(index.projects.find((pj) => pj.cwd === deck.workDir)?.sessions.find((s) => s.sessionId === threadId)).toMatchObject({ account: 'gpt', engine: 'codex' });
    const usage = msgs.filter((m) => m.type === 'usage').at(-1);
    expect(usage && usage.type === 'usage' ? usage.usage.gpt?.weekly?.usedPct : undefined).toEqual(expect.any(Number));
    console.log(`e2e codex turn 1: thread ${threadId.slice(0, 8)} · ${result.badge!.reason}`);
    ws.close();
  });

  it('history comes from the rollout file; resume keeps the thread and engine and honours a per-turn Codex model', async () => {
    const ws = await deck.connect();
    await collect(ws, (m) => m.type === 'hello');
    const ph = collect(ws, (m) => m.type === 'history');
    ws.send(JSON.stringify({ type: 'open_session', sessionId: threadId }));
    const history = (await ph).at(-1) as Extract<ServerMessage, { type: 'history' }>;
    expect(history).toMatchObject({ engine: 'codex', account: 'gpt', sandbox: 'read-only', cwd: deck.workDir });
    expect(history.messages.some((m) => m.kind === 'user' && m.text.includes('Reply with exactly: ok'))).toBe(true);
    expect(history.messages.some((m) => m.kind === 'assistant' && m.text.trim().toLowerCase() === 'ok')).toBe(true);
    const pr = collect(ws, (m) => m.type === 'turn_result');
    // A Claude engine on the send must not move an existing GPT session; a Codex model picked for the turn is used.
    ws.send(JSON.stringify({ type: 'send', sessionId: threadId, cwd: deck.workDir, text: 'Reply with exactly: ok', model: 'gpt-6-astra', engine: 'claude' }));
    const result = (await pr).at(-1) as Result;
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe(threadId);
    expect(result.badge).toMatchObject({ account: 'gpt', model: 'gpt-6-astra', reason: 'GPT 세션' });
    console.log(`e2e codex resume: thread ${threadId.slice(0, 8)} · ${result.badge!.model} · ${result.badge!.reason}`);
    ws.close();
  });

  it('gpt-6-astra works for a new hard-task session', async () => {
    const ws = await deck.connect();
    await collect(ws, (m) => m.type === 'hello');
    const pr = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: deck.workDir, text: 'Reply with exactly: ok', engine: 'codex', model: 'gpt-6-astra' }));
    const result = (await pr).at(-1) as Result;
    expect(result.ok).toBe(true);
    expect(result.text.trim().toLowerCase()).toBe('ok');
    expect(result.badge).toMatchObject({ account: 'gpt', model: 'gpt-6-astra' });
    console.log(`e2e codex astra: ${result.badge!.model} · ${result.badge!.reason}`);
    ws.close();
  });

  let imageThread = '';

  it('an image attachment reaches GPT through `-i` on a new session', async () => {
    const img = await upload(deck, 'red.png', pngSolid(255, 0, 0));
    const ws = await deck.connect();
    await collect(ws, (m) => m.type === 'hello');
    const pr = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: deck.workDir, text: 'The attached image is a single solid color. Reply with exactly one lowercase English word naming that color.', engine: 'codex', attachments: [img.id] }));
    const result = (await pr).at(-1) as Result;
    console.log(`e2e codex -i (new): ok=${result.ok} text=${JSON.stringify(result.text.trim())} error=${JSON.stringify(result.errorText)}`);
    expect(result.ok).toBe(true);
    expect(result.badge).toMatchObject({ account: 'gpt' });
    expect(result.text.toLowerCase()).toContain('red');
    imageThread = result.sessionId ?? '';
    ws.close();
  });

  it('an image attachment reaches GPT through `-i` on a resumed session', async () => {
    const img = await upload(deck, 'blue.png', pngSolid(0, 0, 255));
    const ws = await deck.connect();
    await collect(ws, (m) => m.type === 'hello');
    const pr = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'send', sessionId: imageThread, cwd: deck.workDir, text: 'Here is another single solid-color image. Reply with exactly one lowercase English word naming its color.', attachments: [img.id] }));
    const result = (await pr).at(-1) as Result;
    console.log(`e2e codex -i (resume): ok=${result.ok} text=${JSON.stringify(result.text.trim())} error=${JSON.stringify(result.errorText)}`);
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe(imageThread);
    expect(result.text.toLowerCase()).toContain('blue');
    ws.close();
  });
});
