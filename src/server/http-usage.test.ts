import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cookieValueFor } from './auth';
import { createRequestHandler } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { UsageIndex } from './usage/UsageIndex';
import { UsageService } from './usage/UsageService';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'f'.repeat(64);
const cookie = `deck_session=${cookieValueFor(TOKEN)}`;
let base = '';
let server: http.Server;
let dir: string;
let refreshes = 0;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-http-usage-'));
  const roots = { a: path.join(dir, 'a'), b: path.join(dir, 'b'), c: path.join(dir, 'c') };
  await fs.mkdir(path.join(roots.a, '-p'), { recursive: true });
  const ts = new Date().toISOString();
  await fs.writeFile(path.join(roots.a, '-p', 's.jsonl'), JSON.stringify({ type: 'assistant', timestamp: ts, message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 3, output_tokens: 4 } } }) + '\n');
  const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(dir, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
  const idx = new UsageIndex({ projectsRoots: rootsOf(roots), codexSessionsRoot: path.join(dir, 'codex'), indexFile: path.join(dir, 'usage-index.json') });
  const usageHistory = { history: (d: number) => idx.history(d), refresh: () => { refreshes++; return idx.refresh(); } };
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: dir, usage, index, usageHistory }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });

describe('GET /api/usage/history', () => {
  it('requires auth', async () => {
    expect((await fetch(`${base}/api/usage/history`)).status).toBe(401);
  });

  it('refresh=1 scans, then returns rows for the clamped day window', async () => {
    const r = await fetch(`${base}/api/usage/history?days=7&refresh=1`, { headers: { cookie } });
    expect(r.status).toBe(200);
    const body = await r.json() as { days: number; sources?: string[]; rows: { source: string; input: number; output: number }[]; lastScanAt: string | null };
    expect(refreshes).toBe(1);
    expect(body.days).toBe(7);
    expect(body.lastScanAt).not.toBeNull();
    expect(body.rows.find((x) => x.source === 'a')).toMatchObject({ input: 3, output: 4 });
    expect(body.sources).toEqual(['a', 'b', 'c', 'codex']);
    const big = await (await fetch(`${base}/api/usage/history?days=99999`, { headers: { cookie } })).json() as { days: number };
    expect(big.days).toBe(400);
    const bad = await (await fetch(`${base}/api/usage/history?days=abc`, { headers: { cookie } })).json() as { days: number };
    expect(bad.days).toBe(30);
    expect(refreshes).toBe(1);
  });
});
