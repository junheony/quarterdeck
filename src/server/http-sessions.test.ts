import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cookieValueFor } from './auth';
import { SlashCommandCache } from './engine/slashCommands';
import { FileLister } from './files';
import { PREVIEW_FRAME_PATH, createRequestHandler } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionMetaStore } from './sessions/SessionMetaStore';
import { TranscriptSearch } from './sessions/search';
import { UsageService } from './usage/UsageService';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'f'.repeat(64);
const ID1 = '11111111-1111-4111-8111-111111111111';
const cookie = { cookie: `deck_session=${cookieValueFor(TOKEN)}` };
let base = '';
let server: http.Server;
let dir: string;
let home: string;
let index: SessionIndex;
let changed = 0;
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const openCalls: string[] = [];
const forkCalls: [string, string][] = [];

beforeAll(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-hs-')));
  home = path.join(dir, 'home');
  await fs.mkdir(path.join(home, 'proj', 'src'), { recursive: true });
  await fs.writeFile(path.join(home, 'proj', 'src', 'main.ts'), '');
  await fs.writeFile(path.join(home, 'proj', 'note.md'), '# hi');
  const root = path.join(dir, 'b');
  await fs.mkdir(path.join(root, '-w-p'), { recursive: true });
  await fs.writeFile(path.join(root, '-w-p', `${ID1}.jsonl`), JSON.stringify({ type: 'user', cwd: '/w/p', message: { role: 'user', content: 'how do I rotate the token' } }) + '\n');
  const meta = new SessionMetaStore(path.join(dir, 'session-meta.json'));
  index = new SessionIndex({ roots: rootsOf({ a: path.join(dir, 'a'), b: root, c: path.join(dir, 'c') }), pinnedFile: path.join(dir, 'p.json'), meta });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
  const commands = new SlashCommandCache();
  commands.record(ID1, '/w/p', ['compact', 'mine']);
  server = http.createServer(createRequestHandler({
    token: TOKEN, uiDir: dir, usage, index, home, onIndexChanged: () => { changed++; }, meta,
    search: new TranscriptSearch({ sessions: () => index.projects().flatMap((p) => p.sessions) }),
    files: new FileLister({ home, roots: [home] }),
    commands,
    forks: {
      forkStatus: async (id) => (id === ID1 ? { diverged: true, deckAccount: 'b', homeAccount: 'a' } : null),
      openInDesktop: async (id) => { openCalls.push(id); return id === ID1 ? { ok: true, busy: true } : id === ID2 ? { ok: false, reason: 'diverged' } : id === ID3 ? { ok: false, reason: 'unsupported' } : { ok: true, busy: false }; },
      resolveFork: async (id, keep) => { forkCalls.push([id, keep]); return keep === 'deck' ? { ok: true, backup: '/x.deck-fork-1' } : { ok: false, error: '실행 중' }; },
    },
  }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

const post = (p: string, body: unknown, headers: Record<string, string> = cookie) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });

describe('session endpoints', () => {
  it('all require the login cookie', async () => {
    for (const p of ['/api/search?q=token', `/api/files?cwd=${encodeURIComponent(home)}`, '/api/commands']) expect((await fetch(`${base}${p}`)).status).toBe(401);
    expect((await post('/api/session-meta', { sessionId: ID1, title: 'x' }, {})).status).toBe(401);
  });

  it('session-meta renames and archives, broadcasts the index, and rejects bad input', async () => {
    const before = changed;
    const r = await post('/api/session-meta', { sessionId: ID1, title: 'Token rotation' });
    expect(r.status).toBe(200);
    expect(index.projects()[0]!.sessions[0]!.title).toBe('Token rotation');
    expect((await post('/api/session-meta', { sessionId: ID1, archived: true })).status).toBe(200);
    expect(index.projects()[0]!.sessions[0]!.archived).toBe(true);
    expect(changed).toBe(before + 2);
    for (const bad of [{ sessionId: '../etc', title: 'x' }, { sessionId: ID1 }, { sessionId: ID1, archived: 'yes' }, { sessionId: ID1, title: 'x'.repeat(201) }]) {
      expect((await post('/api/session-meta', bad)).status).toBe(400);
    }
    // Missing origin on a state change: refused like every other POST.
    const noOrigin = await fetch(`${base}/api/session-meta`, { method: 'POST', headers: { 'content-type': 'application/json', ...cookie }, body: JSON.stringify({ sessionId: ID1, title: 'y' }) });
    expect(noOrigin.status).toBe(403);
  });

  it('search returns hits with the deck title', async () => {
    const r = await fetch(`${base}/api/search?q=${encodeURIComponent('rotate the')}`, { headers: cookie });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { hits: { sessionId: string; title: string }[] };
    expect(body.hits.map((h) => h.sessionId)).toEqual([ID1]);
    expect(body.hits[0]!.title).toBe('Token rotation');
    expect((await fetch(`${base}/api/search?q=${'q'.repeat(201)}`, { headers: cookie })).status).toBe(400);
  });

  it('files lists inside home only', async () => {
    const ok = await fetch(`${base}/api/files?cwd=${encodeURIComponent(path.join(home, 'proj'))}`, { headers: cookie });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { files: string[] }).files).toEqual(['note.md', 'src/main.ts']);
    for (const cwd of [dir, '/etc', 'proj', '']) {
      expect((await fetch(`${base}/api/files?cwd=${encodeURIComponent(cwd)}`, { headers: cookie })).status).toBe(400);
    }
  });

  it('/api/file: authed, contained in the cwd, errors mapped', async () => {
    const q = (cwd: string, p: string) => `${base}/api/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(p)}`;
    expect((await fetch(q(path.join(home, 'proj'), 'note.md'))).status).toBe(401);
    const ok = await fetch(q(path.join(home, 'proj'), 'note.md'), { headers: cookie });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ kind: 'text', text: '# hi' });
    expect((await fetch(q(path.join(home, 'proj'), '../../b/x'), { headers: cookie })).status).toBe(403);
    expect((await fetch(q(path.join(home, 'proj'), 'nope.md'), { headers: cookie })).status).toBe(404);
    expect((await fetch(q('/etc', 'hosts'), { headers: cookie })).status).toBe(400);
  });

  it('preview frame: static shell with its own sandboxing CSP', async () => {
    const r = await fetch(`${base}${PREVIEW_FRAME_PATH}`);
    expect(r.status).toBe(200);
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it('commands per session, defaults otherwise', async () => {
    const r = (await (await fetch(`${base}/api/commands?sessionId=${ID1}`, { headers: cookie })).json()) as { commands: { name: string }[] };
    expect(r.commands.map((c) => c.name)).toEqual(['compact', 'mine']);
  });

  it('/api/session-fork: status, resolution (409 on refusal), input checks, auth', async () => {
    expect((await fetch(`${base}/api/session-fork?sessionId=${ID1}`)).status).toBe(401);
    expect(await (await fetch(`${base}/api/session-fork?sessionId=${ID1}`, { headers: cookie })).json()).toEqual({ diverged: true, deckAccount: 'b', homeAccount: 'a' });
    expect(await (await fetch(`${base}/api/session-fork?sessionId=22222222-2222-4222-8222-222222222222`, { headers: cookie })).json()).toEqual({ diverged: false });
    expect((await fetch(`${base}/api/session-fork?sessionId=../x`, { headers: cookie })).status).toBe(400);
    const before = changed;
    const ok = await post('/api/session-fork', { sessionId: ID1, keep: 'deck' });
    expect(ok.status).toBe(200);
    expect(changed).toBe(before + 1);
    expect((await post('/api/session-fork', { sessionId: ID1, keep: 'home' })).status).toBe(409);
    expect((await post('/api/session-fork', { sessionId: ID1, keep: 'both' })).status).toBe(400);
    expect((await post('/api/session-fork', { sessionId: ID1, keep: 'deck' }, {})).status).toBe(401);
    expect(forkCalls).toEqual([[ID1, 'deck'], [ID1, 'home']]);
  });

  it('/api/sessions/:id/open-in-desktop: url + busy, diverged, non-Claude 400, bad id 400, auth', async () => {
    const url = (id: string) => `/api/sessions/${id}/open-in-desktop`;
    expect((await post(url(ID1), {}, {})).status).toBe(401);
    expect(await (await post(url(ID1), {})).json()).toEqual({ ok: true, url: `claude://resume?session=${ID1}`, busy: true });
    expect(await (await post(url(ID2), {})).json()).toEqual({ ok: false, reason: 'diverged' });
    expect((await post(url(ID3), {})).status).toBe(400);
    expect((await post(url('..%2Fx'), {})).status).toBe(400);
    expect((await post(url('not-a-uuid'), {})).status).toBe(400);
    expect(openCalls).toEqual([ID1, ID2, ID3]);
  });
});
