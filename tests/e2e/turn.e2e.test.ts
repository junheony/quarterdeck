import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerMessage } from '../../src/shared/protocol';
import { collect, startDeck, type Deck } from './harness';

// Server, temp dirs, login, B pinning (D13) and the buffered collector live in harness.ts (PF16).
let deck: Deck;

beforeAll(async () => { deck = await startDeck(); });
afterAll(async () => { await deck?.stop(); });

describe('deck e2e (real accounts)', () => {
  let sessionId = '';

  it('new session: "Reply with exactly: ok" → reply ok, badge names the account, session appears in the index', async () => {
    const ws = await deck.connect();
    await collect(ws, (m) => m.type === 'hello');
    const p = collect(ws, (m) => m.type === 'index');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: deck.workDir, text: 'Reply with exactly: ok', model: 'sonnet' }));
    const msgs = await p;
    const result = msgs.find((m) => m.type === 'turn_result') as Extract<ServerMessage, { type: 'turn_result' }>;
    expect(result.ok).toBe(true);
    expect(result.text.trim().toLowerCase()).toBe('ok');
    expect(['a', 'b', 'c']).toContain(result.badge!.account);
    expect(result.badge!.model).toBe('sonnet');
    expect(result.badge!.usage.outputTokens).toBeGreaterThan(0);
    expect(result.badge!.reason.length).toBeGreaterThan(0);
    console.log(`e2e turn 1 ran on ${result.badge!.account.toUpperCase()} — ${result.badge!.reason}`);
    sessionId = result.sessionId ?? '';
    const index = msgs.at(-1) as Extract<ServerMessage, { type: 'index' }>;
    const project = index.projects.find((pj) => pj.cwd === deck.workDir);
    expect(project?.sessions.map((s) => s.sessionId)).toContain(sessionId);
    ws.close();
  });

  it('open the imported session, then resume it with another turn', async () => {
    const ws = await deck.connect();
    await collect(ws, (m) => m.type === 'hello');
    const ph = collect(ws, (m) => m.type === 'history');
    ws.send(JSON.stringify({ type: 'open_session', sessionId }));
    const history = (await ph).at(-1) as Extract<ServerMessage, { type: 'history' }>;
    expect(history.messages.some((m) => m.kind === 'user' && m.text.includes('Reply with exactly: ok'))).toBe(true);
    expect(history.messages.some((m) => m.kind === 'assistant' && m.text.trim().toLowerCase() === 'ok')).toBe(true);
    const pr = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'send', sessionId, cwd: deck.workDir, text: 'Reply with exactly: ok', model: 'sonnet' }));
    const result = (await pr).at(-1) as Extract<ServerMessage, { type: 'turn_result' }>;
    expect(result.ok).toBe(true);
    expect(result.text.trim().toLowerCase()).toBe('ok');
    expect(result.sessionId).toBe(sessionId);
    console.log(`e2e turn 2 ran on ${result.badge!.account.toUpperCase()} — ${result.badge!.reason}`);
    ws.close();
  });
});
