import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerMessage } from '../../src/shared/protocol';
import { collect, collectAllowing, pngNoise, pngSolid, startDeck, upload, type Deck } from './harness';

type Result = Extract<ServerMessage, { type: 'turn_result' }>;
let deck: Deck;

beforeAll(async () => { deck = await startDeck(); });
afterAll(async () => { await deck?.stop(); });

describe('deck e2e: attachments on Claude B (D7, D14)', () => {
  it('a pasted image reaches the model as an image block', async () => {
    const img = await upload(deck, 'red.png', pngSolid(255, 0, 0));
    expect(img.isImage).toBe(true);
    const ws = await deck.connect();
    await collect(ws, (m) => m.type === 'hello');
    const pr = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: deck.workDir, text: 'The attached image is a single solid color. Reply with exactly one lowercase English word naming that color.', model: 'sonnet', attachments: [img.id] }));
    const result = (await pr).at(-1) as Result;
    expect(result.ok).toBe(true);
    expect(result.badge!.account).toBe('b');
    expect(result.text.toLowerCase()).toContain('red');
    console.log(`e2e image turn on ${result.badge!.account.toUpperCase()}: "${result.text.trim()}"`);
    ws.close();
  });

  it('a large (~6 MB) noise PNG is accepted and described on Claude B', async () => {
    const data = pngNoise(1400);
    const img = await upload(deck, 'noise.png', data);
    expect(img.isImage).toBe(true);
    const ws = await deck.connect();
    await collect(ws, (m) => m.type === 'hello');
    const pr = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: deck.workDir, text: 'Describe the attached image in at most ten words.', model: 'sonnet', attachments: [img.id] }));
    const result = (await pr).at(-1) as Result;
    console.log(`e2e large image (${(data.length / 1e6).toFixed(2)} MB): ok=${result.ok} account=${result.badge ? result.badge.account.toUpperCase() : '?'} text=${JSON.stringify(result.text.trim().slice(0, 200))} error=${JSON.stringify(result.errorText)}`);
    expect(result.ok).toBe(true);
    expect(result.badge!.account).toBe('b');
    ws.close();
  });

  it('a dropped text file is referenced by path and readable by the model (permission answered once)', async () => {
    const doc = await upload(deck, 'notes.txt', Buffer.from('SECRET-WORD: pomegranate\n'));
    expect(doc.isImage).toBe(false);
    const ws = await deck.connect();
    await collect(ws, (m) => m.type === 'hello');
    const pr = collectAllowing(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: deck.workDir, text: 'Read the attached file with the Read tool and reply with exactly the word that follows "SECRET-WORD:" and nothing else.', model: 'sonnet', attachments: [doc.id] }));
    const result = (await pr).at(-1) as Result;
    expect(result.ok).toBe(true);
    expect(result.badge!.account).toBe('b');
    expect(result.text.toLowerCase()).toContain('pomegranate');
    ws.close();
  });
});
