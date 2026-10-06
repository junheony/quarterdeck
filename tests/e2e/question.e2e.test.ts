import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerMessage } from '../../src/shared/protocol';
import { collect, startDeck, type Deck } from './harness';

type Result = Extract<ServerMessage, { type: 'turn_result' }>;
let deck: Deck;

beforeAll(async () => { deck = await startDeck(); });
afterAll(async () => { await deck?.stop(); });

describe('deck e2e: AskUserQuestion on Claude B (D8)', () => {
  it('the question card is delivered, the answer goes back through canUseTool, the model uses it', async () => {
    const ws = await deck.connect();
    await collect(ws, (m) => m.type === 'hello');
    const q = collect(ws, (m) => m.type === 'question_request');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: deck.workDir, text: 'Use the AskUserQuestion tool to ask me exactly one question, "Which color do you prefer?", with exactly two options labeled "red" and "blue". After I answer, reply with exactly the label I chose in lowercase and nothing else.', model: 'sonnet' }));
    const req = (await q).at(-1);
    expect(req).toMatchObject({ type: 'question_request', cwd: deck.workDir });
    const question = req && req.type === 'question_request' ? req.questions[0]! : null;
    expect(question?.options.map((o) => o.label.toLowerCase())).toEqual(expect.arrayContaining(['red', 'blue']));
    const pr = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'question_response', requestId: req && req.type === 'question_request' ? req.requestId : '', answers: { [question!.question]: 'blue' } }));
    const result = (await pr).at(-1) as Result;
    expect(result.ok).toBe(true);
    expect(result.badge!.account).toBe('b');
    expect(result.text.trim().toLowerCase()).toContain('blue');
    console.log(`e2e question turn on ${result.badge!.account.toUpperCase()}: "${result.text.trim()}"`);
    ws.close();
  });
});
