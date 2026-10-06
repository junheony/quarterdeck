import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cookieValueFor } from './auth';
import { AttachmentStore } from './attachments/AttachmentStore';
import { createRequestHandler } from './http';
import { PushNotifier, type PushSender } from './push/PushNotifier';
import { SubscriptionStore } from './push/SubscriptionStore';
import { PinStore } from './sessions/PinStore';
import { SessionIndex } from './sessions/SessionIndex';
import { UsageService } from './usage/UsageService';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'e'.repeat(64);
let base = '';
let server: http.Server;
let uiDir: string;
let build: string | null = null;

beforeAll(async () => {
  uiDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-ui-'));
  const roots = { a: path.join(uiDir, 'a'), b: path.join(uiDir, 'b'), c: path.join(uiDir, 'c') };
  const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(uiDir, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
  const attachments = new AttachmentStore(path.join(uiDir, 'att'));
  await attachments.init();
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir, usage, index, devOrigins: ['http://dev.local'], attachments, build: () => build }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server.close());

describe('http', () => {
  it('GET /api/build needs the session cookie and answers the live build id (null without a build)', async () => {
    expect((await fetch(`${base}/api/build`)).status).toBe(401);
    const headers = { cookie: `deck_session=${cookieValueFor(TOKEN)}` };
    expect(await (await fetch(`${base}/api/build`, { headers })).json()).toEqual({ build: null });
    build = 'abc123';
    const res = await fetch(`${base}/api/build`, { headers });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ build: 'abc123' });
    build = null;
  });

  it('POST /api/diag logs one line of device numbers for a logged-in same-origin page, and refuses anything that is not an object', async () => {
    const headers = { cookie: `deck_session=${cookieValueFor(TOKEN)}`, origin: base, 'content-type': 'application/json' };
    expect((await fetch(`${base}/api/diag`, { method: 'POST', headers: { origin: base }, body: '{}' })).status).toBe(401);
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      expect((await fetch(`${base}/api/diag`, { method: 'POST', headers, body: JSON.stringify({ inner: [1408, 938] }) })).status).toBe(200);
      expect((await fetch(`${base}/api/diag`, { method: 'POST', headers, body: '[1]' })).status).toBe(400);
      expect((await fetch(`${base}/api/diag`, { method: 'POST', headers, body: 'nope' })).status).toBe(400);
    } finally { console.log = log; }
    expect(lines).toEqual(['deck: diag {"inner":[1408,938]}']);
  });

  it('refuses API without a cookie', async () => {
    expect((await fetch(`${base}/api/me`)).status).toBe(401);
    expect((await fetch(`${base}/api/bootstrap`)).status).toBe(401);
  });

  // Deviation (added per review I5): SameSite=Strict doesn't separate ports, so every
  // state-changing /api/* request must also carry a same-origin Origin (or Sec-Fetch-Site).
  it('rejects state-changing requests with a missing or foreign-port Origin', async () => {
    const missing = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    expect(missing.status).toBe(403);
    const foreignPort = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:1' }, body: JSON.stringify({ token: TOKEN }) });
    expect(foreignPort.status).toBe(403);
    const foreignHost = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify({ token: TOKEN }) });
    expect(foreignHost.status).toBe(403);
  });

  // Deviation (added per review I5): DNS-rebinding defence — a Host deck doesn't bind to is
  // rejected outright, even for a plain GET, even though the request's own Origin would match it.
  // fetch() treats Host as a forbidden header and silently drops an override, so this uses
  // node:http directly (setHost: false) to actually send a foreign Host.
  it('rejects a foreign Host outright', async () => {
    const addr = server.address() as { port: number };
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: addr.port, path: '/api/me', method: 'GET', setHost: false, headers: { host: 'evil.example', cookie: `deck_session=${cookieValueFor(TOKEN)}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it('login with a wrong token → 401, right token → cookie, then API works', async () => {
    const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token: 'nope' }) });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();
    const good = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token: TOKEN }) });
    expect(good.status).toBe(200);
    const cookie = good.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`deck_session=${cookieValueFor(TOKEN)}`);
    expect(cookie).toContain('HttpOnly');
    const me = await fetch(`${base}/api/me`, { headers: { cookie: `deck_session=${cookieValueFor(TOKEN)}` } });
    expect(me.status).toBe(200);
    const boot = await fetch(`${base}/api/bootstrap`, { headers: { cookie: `deck_session=${cookieValueFor(TOKEN)}` } });
    expect(boot.status).toBe(200);
    const body = (await boot.json()) as { usage: { accounts: object }; projects: unknown[] };
    expect(Object.keys(body.usage.accounts)).toEqual(['a', 'b', 'c']);
    expect(body.projects).toEqual([]);
    // A dev origin (Vite) must also be accepted for a state-changing request.
    const devLogin = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://dev.local' }, body: JSON.stringify({ token: TOKEN }) });
    expect(devLogin.status).toBe(200);
    const out = await fetch(`${base}/api/logout`, { method: 'POST', headers: { origin: base } });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('serves the UI when built, 503 when not, never outside uiDir', async () => {
    expect((await fetch(`${base}/`)).status).toBe(503);
    await fs.writeFile(path.join(uiDir, 'index.html'), '<html>deck</html>');
    await fs.mkdir(path.join(uiDir, 'assets'));
    await fs.writeFile(path.join(uiDir, 'assets', 'app.js'), 'console.log(1)');
    expect(await (await fetch(`${base}/`)).text()).toBe('<html>deck</html>');
    expect(await (await fetch(`${base}/some/spa/route`)).text()).toBe('<html>deck</html>');
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    // fetch() normalizes '..' itself; the encoded form reaches the server as-is. Either way only index.html comes back, never package.json.
    expect(await (await fetch(`${base}/assets/../../package.json`)).text()).toBe('<html>deck</html>');
    expect(await (await fetch(`${base}/assets/%2e%2e/%2e%2e/package.json`)).text()).toBe('<html>deck</html>');
  });

  it('every response carries CSP, nosniff and no-referrer — static, API, and error responses', async () => {
    const CSP = "default-src 'self'; script-src 'self'; worker-src 'self'; manifest-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
    await fs.writeFile(path.join(uiDir, 'index.html'), '<html>deck</html>');
    const cookie = `deck_session=${cookieValueFor(TOKEN)}`;
    for (const r of [await fetch(`${base}/`), await fetch(`${base}/api/me`), await fetch(`${base}/api/bootstrap`, { headers: { cookie } }), await fetch(`${base}/api/nope`, { headers: { cookie } })]) {
      expect(r.headers.get('content-security-policy')).toBe(CSP);
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  it('a 500 returns a generic body and keeps the detail in the server log', async () => {
    const roots = { a: path.join(uiDir, 'a'), b: path.join(uiDir, 'b'), c: path.join(uiDir, 'c') };
    const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(uiDir, 'p.json') });
    const usage = { snapshot: () => { throw new Error('SECRET-DETAIL /Users/alice/.claude-b'); } } as unknown as UsageService;
    const s2 = http.createServer(createRequestHandler({ token: TOKEN, uiDir, usage, index }));
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
    const logged: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logged.push(a); };
    try {
      const r = await fetch(`http://127.0.0.1:${(s2.address() as { port: number }).port}/api/bootstrap`, { headers: { cookie: `deck_session=${cookieValueFor(TOKEN)}` } });
      expect(r.status).toBe(500);
      const body = await r.text();
      expect(body).not.toContain('SECRET-DETAIL');
      expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(JSON.stringify(logged.map(String))).toContain('SECRET-DETAIL');
    } finally {
      console.error = orig;
      s2.close();
    }
  });
});

describe('POST /api/attachments (D7)', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const headers = (extra: Record<string, string> = {}) => ({ cookie: `deck_session=${cookieValueFor(TOKEN)}`, origin: base, 'content-type': 'application/octet-stream', ...extra });

  it('needs a cookie and a same-origin Origin', async () => {
    expect((await fetch(`${base}/api/attachments`, { method: 'POST', headers: { origin: base }, body: PNG })).status).toBe(401);
    expect((await fetch(`${base}/api/attachments`, { method: 'POST', headers: { cookie: `deck_session=${cookieValueFor(TOKEN)}` }, body: PNG })).status).toBe(403);
  });

  it('stores an upload and returns its id; the name is sanitized; oversize is 413', async () => {
    const res = await fetch(`${base}/api/attachments`, { method: 'POST', headers: headers({ 'x-deck-filename': encodeURIComponent('../스크린샷.png') }), body: PNG });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; mediaType: string; size: number; isImage: boolean };
    expect(body).toMatchObject({ name: '스크린샷.png', mediaType: 'image/png', size: PNG.length, isImage: true });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    const big = await fetch(`${base}/api/attachments`, { method: 'POST', headers: headers({ 'x-deck-filename': 'big.bin' }), body: Buffer.alloc(10 * 1024 * 1024 + 1) });
    expect(big.status).toBe(413);
  });

  /**
   * Fix round 1 finding 1 regression: a *realistic* oversized upload — tens of MiB, written to
   * the socket in chunks like a real client, rather than fetch()'s single in-memory Buffer body
   * — used to get ECONNRESET/EPIPE instead of ever seeing the 413 (a `connection: close`
   * header made Node auto-destroy the socket on `res` 'finish' while the body was still
   * arriving, RSTing the still-unread bytes). Drives node:http directly so both a declared
   * Content-Length and a chunked (no Content-Length) transfer can be exercised, and streams
   * the body progressively rather than handing it to fetch() as one Buffer.
   */
  function uploadRaw(size: number, opts: { declareLength?: boolean } = {}): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const addr = server.address() as { port: number };
      const reqHeaders: Record<string, string> = {
        cookie: `deck_session=${cookieValueFor(TOKEN)}`,
        origin: base,
        'content-type': 'application/octet-stream',
        'x-deck-filename': 'big.bin',
      };
      if (opts.declareLength !== false) reqHeaders['content-length'] = String(size);
      const req = http.request({ host: '127.0.0.1', port: addr.port, path: '/api/attachments', method: 'POST', headers: reqHeaders }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('error', reject);
      const chunkSize = 1024 * 1024;
      let remaining = size;
      const writeNext = () => {
        if (remaining <= 0) { req.end(); return; }
        const n = Math.min(chunkSize, remaining);
        remaining -= n;
        const ok = req.write(Buffer.alloc(n));
        if (ok) setImmediate(writeNext);
        else req.once('drain', writeNext);
      };
      writeNext();
    });
  }

  const OVERSIZE = 21 * 1024 * 1024; // > MAX_ATTACHMENT_BYTES (10 MiB), well above the brief's 20 MiB floor

  it('a realistic oversized upload with a declared Content-Length gets a clean 413, not ECONNRESET', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await uploadRaw(OVERSIZE, { declareLength: true });
      expect(res.status).toBe(413);
      expect(JSON.parse(res.text)).toMatchObject({ error: expect.stringContaining('MiB') });
    }
  }, 30000);

  it('a realistic oversized upload sent chunked (no Content-Length) also gets a clean 413, not ECONNRESET', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await uploadRaw(OVERSIZE, { declareLength: false });
      expect(res.status).toBe(413);
      expect(JSON.parse(res.text)).toMatchObject({ error: expect.stringContaining('MiB') });
    }
  }, 30000);
});

describe('folder picker routes (F1)', () => {
  let home: string;
  let outside: string;
  let b2 = '';
  let s3: http.Server;
  let idx: SessionIndex;
  let changed = 0;
  const cookie = () => `deck_session=${cookieValueFor(TOKEN)}`;

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-fhome-')));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-fout-')));
    await fs.mkdir(path.join(home, 'Documents', '작업', 'deck'), { recursive: true });
    await fs.writeFile(path.join(home, 'Documents', 'secret.txt'), 'x');
    await fs.symlink(outside, path.join(home, 'out-link'));
    const roots = { a: path.join(home, 'na'), b: path.join(home, 'nb'), c: path.join(home, 'nc') };
    idx = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(home, 'p.json'), recentFile: path.join(home, 'cfg', 'recent-folders.json') });
    await idx.refresh();
    const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
    s3 = http.createServer(createRequestHandler({ token: TOKEN, uiDir: home, usage, index: idx, home, onIndexChanged: () => { changed++; } }));
    await new Promise<void>((r) => s3.listen(0, '127.0.0.1', r));
    b2 = `http://127.0.0.1:${(s3.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    s3.close();
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('GET /api/dirs needs auth', async () => {
    expect((await fetch(`${b2}/api/dirs?path=~`)).status).toBe(401);
  });

  it('GET /api/dirs lists subdirectories of a ~ path (dirs only)', async () => {
    const r = await fetch(`${b2}/api/dirs?path=${encodeURIComponent('~/Documents/')}`, { headers: { cookie: cookie() } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ path: path.join(home, 'Documents'), parent: home, dirs: [{ name: '작업', path: path.join(home, 'Documents', '작업') }] });
    const none = await fetch(`${b2}/api/dirs`, { headers: { cookie: cookie() } });
    expect(((await none.json()) as { path: string }).path).toBe(home);
  });

  it('GET /api/dirs refuses outside home and symlink escapes with a Korean 400', async () => {
    for (const p of [outside, '/etc', '~/out-link', '~/../', '~/Documents/secret.txt']) {
      const r = await fetch(`${b2}/api/dirs?path=${encodeURIComponent(p)}`, { headers: { cookie: cookie() } });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toMatch(/[가-힣]/);
    }
  });

  it('POST /api/recent-folders needs auth + Origin, validates, records the real path and notifies', async () => {
    const body = JSON.stringify({ path: '~/Documents/작업/deck' });
    expect((await fetch(`${b2}/api/recent-folders`, { method: 'POST', headers: { origin: b2 }, body })).status).toBe(401);
    expect((await fetch(`${b2}/api/recent-folders`, { method: 'POST', headers: { cookie: cookie() }, body })).status).toBe(403);
    const bad = await fetch(`${b2}/api/recent-folders`, { method: 'POST', headers: { cookie: cookie(), origin: b2 }, body: JSON.stringify({ path: outside }) });
    expect(bad.status).toBe(400);
    const before = changed;
    const ok = await fetch(`${b2}/api/recent-folders`, { method: 'POST', headers: { cookie: cookie(), origin: b2 }, body });
    expect(ok.status).toBe(200);
    const real = path.join(home, 'Documents', '작업', 'deck');
    expect(await ok.json()).toEqual({ path: real, recent: [real] });
    expect(changed).toBe(before + 1);
    expect(idx.projects().map((p) => p.cwd)).toContain(real);
    const list = await fetch(`${b2}/api/recent-folders`, { headers: { cookie: cookie() } });
    expect(await list.json()).toEqual({ recent: [real] });
    expect(JSON.parse(await fs.readFile(path.join(home, 'cfg', 'recent-folders.json'), 'utf8'))).toEqual([real]);
  });
});

describe('POST /api/pins (F2)', () => {
  let b3 = '';
  let s4: http.Server;
  let pins: PinStore;
  let dir: string;
  let changed = 0;
  const ID = '11111111-1111-4111-8111-111111111111';
  const cookie = () => `deck_session=${cookieValueFor(TOKEN)}`;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-pinhttp-'));
    const roots = { a: path.join(dir, 'a'), b: path.join(dir, 'b'), c: path.join(dir, 'c') };
    const idx = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(dir, 'p.json') });
    await idx.refresh();
    pins = new PinStore(path.join(dir, 'pins.json'));
    await pins.load();
    const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
    s4 = http.createServer(createRequestHandler({ token: TOKEN, uiDir: dir, usage, index: idx, pins, onIndexChanged: () => { changed++; } }));
    await new Promise<void>((r) => s4.listen(0, '127.0.0.1', r));
    b3 = `http://127.0.0.1:${(s4.address() as { port: number }).port}`;
  });
  afterAll(async () => { s4.close(); await fs.rm(dir, { recursive: true, force: true }); });

  it('needs auth and a same-origin Origin', async () => {
    const body = JSON.stringify({ sessionId: ID, pinned: true });
    expect((await fetch(`${b3}/api/pins`, { method: 'POST', headers: { origin: b3 }, body })).status).toBe(401);
    expect((await fetch(`${b3}/api/pins`, { method: 'POST', headers: { cookie: cookie() }, body })).status).toBe(403);
    expect(pins.list()).toEqual([]);
  });

  it('validates the body', async () => {
    for (const body of ['{bad', JSON.stringify({ sessionId: '../x', pinned: true }), JSON.stringify({ sessionId: ID, pinned: 'yes' })]) {
      expect((await fetch(`${b3}/api/pins`, { method: 'POST', headers: { cookie: cookie(), origin: b3 }, body })).status).toBe(400);
    }
  });

  it('pins and unpins, persists, notifies, and bootstrap carries the pins', async () => {
    const before = changed;
    const r = await fetch(`${b3}/api/pins`, { method: 'POST', headers: { cookie: cookie(), origin: b3 }, body: JSON.stringify({ sessionId: ID, pinned: true }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ pins: [ID] });
    expect(changed).toBe(before + 1);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'pins.json'), 'utf8'))).toEqual([ID]);
    const boot = (await (await fetch(`${b3}/api/bootstrap`, { headers: { cookie: cookie() } })).json()) as { pins: string[] };
    expect(boot.pins).toEqual([ID]);
    const off = await fetch(`${b3}/api/pins`, { method: 'POST', headers: { cookie: cookie(), origin: b3 }, body: JSON.stringify({ sessionId: ID, pinned: false }) });
    expect(await off.json()).toEqual({ pins: [] });
  });

  it('POST /api/pins/order: auth, validation, reorder (unknown ids ignored, missing ones kept), persists and notifies', async () => {
    const ID2 = '22222222-2222-4222-8222-222222222222';
    const ID3 = '33333333-3333-4333-8333-333333333333';
    const UNKNOWN = '99999999-9999-4999-8999-999999999999';
    const post = (body: string, headers: Record<string, string> = { cookie: cookie(), origin: b3 }) => fetch(`${b3}/api/pins/order`, { method: 'POST', headers, body });
    for (const id of [ID, ID2, ID3]) await pins.set(id, true);
    expect(pins.list()).toEqual([ID3, ID2, ID]); // newest pin on top
    const ok = JSON.stringify({ order: [ID, ID2, ID3] });
    expect((await post(ok, { origin: b3 })).status).toBe(401);
    expect((await post(ok, { cookie: cookie() })).status).toBe(403);
    for (const body of ['{bad', JSON.stringify({}), JSON.stringify({ order: 'x' }), JSON.stringify({ order: [ID, 5] }), JSON.stringify({ order: ['../x'] }), JSON.stringify({ order: Array(401).fill(ID) })]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(pins.list()).toEqual([ID3, ID2, ID]);
    const before = changed;
    const r = await post(JSON.stringify({ order: [ID, UNKNOWN, ID3, ID] }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ pins: [ID, ID3, ID2] });
    expect(changed).toBe(before + 1);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'pins.json'), 'utf8'))).toEqual([ID, ID3, ID2]);
    const same = await post(JSON.stringify({ order: [ID, ID3, ID2] }));
    expect(await same.json()).toEqual({ pins: [ID, ID3, ID2] });
    expect(changed).toBe(before + 1); // nothing changed: no broadcast
    for (const id of [ID, ID2, ID3]) await pins.set(id, false);
  });
});

describe('GET /api/attachments/:id (ux-state thumbnails)', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const cookie = () => ({ cookie: `deck_session=${cookieValueFor(TOKEN)}` });
  const upload = async (name: string, body: typeof PNG) => {
    const res = await fetch(`${base}/api/attachments`, { method: 'POST', headers: { ...cookie(), origin: base, 'x-deck-filename': name }, body });
    return ((await res.json()) as { id: string }).id;
  };

  it('needs the login cookie', async () => {
    const id = await upload('a.png', PNG);
    const res = await fetch(`${base}/api/attachments/${id}`);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).not.toMatch(/^image\//);
  });

  it('serves an uploaded image with its sniffed type, nosniff and a private cache', async () => {
    const id = await upload('shot.png', PNG);
    const res = await fetch(`${base}/api/attachments/${id}`, { headers: cookie() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toMatch(/^private/);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    const head = await fetch(`${base}/api/attachments/${id}`, { method: 'HEAD', headers: cookie() });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(PNG.length));
  });

  it('refuses non-images, unknown ids and anything that is not a bare UUID', async () => {
    const txt = await upload('notes.png', Buffer.from('<script>alert(1)</script>'));
    expect((await fetch(`${base}/api/attachments/${txt}`, { headers: cookie() })).status).toBe(404);
    for (const bad of ['11111111-2222-3333-4444-555555555555', 'not-a-uuid', '..%2F..%2Fetc%2Fpasswd', `${txt}-notes.png`, `${txt.toUpperCase()}`, '%2e%2e', '']) {
      const res = await fetch(`${base}/api/attachments/${bad}`, { headers: cookie() });
      expect(res.status, bad).toBe(404);
    }
  });

  it('refuses an indexed file that was swapped for a symlink (O_NOFOLLOW)', async () => {
    const id = await upload('swap.png', PNG);
    const file = path.join(uiDir, 'att', `${id}-swap.png`);
    const secret = path.join(uiDir, 'secret.png');
    await fs.writeFile(secret, PNG);
    await fs.rm(file);
    await fs.symlink(secret, file);
    expect((await fetch(`${base}/api/attachments/${id}`, { headers: cookie() })).status).toBe(404);
  });

  it('POST to an id path is not an upload', async () => {
    const id = await upload('x.png', PNG);
    expect((await fetch(`${base}/api/attachments/${id}`, { method: 'POST', headers: { ...cookie(), origin: base }, body: PNG })).status).toBe(404);
  });
});

describe('PWA + Web Push over http', () => {
  const HOST = 'deck-host.example.ts.net';
  const cookie = `deck_session=${cookieValueFor(TOKEN)}`;
  const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: 'BPk3x_-y', auth: 'AuTh_-0' } };
  let s3: http.Server;
  let port = 0;
  let dir = '';
  const sent: { endpoint: string; payload: string }[] = [];
  const send: PushSender = async (sub, payload) => { sent.push({ endpoint: sub.endpoint, payload }); };

  /** node:http directly: fetch() can't set Host (needed for the MagicDNS name behind tailscale serve). */
  const raw = (method: string, p: string, headers: Record<string, string>, body?: string) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, setHost: false, headers }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => { text += c.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-pwa-'));
    await fs.writeFile(path.join(dir, 'index.html'), '<html>deck</html>');
    await fs.writeFile(path.join(dir, 'sw.js'), 'self.addEventListener("push", () => {});');
    await fs.writeFile(path.join(dir, 'manifest.webmanifest'), '{"name":"deck"}');
    const roots = { a: path.join(dir, 'a'), b: path.join(dir, 'b'), c: path.join(dir, 'c') };
    const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(dir, 'p.json') });
    await index.refresh();
    const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
    const store = new SubscriptionStore(path.join(dir, 'subs.json'));
    const notifier = new PushNotifier({ store, vapid: { publicKey: 'PUBKEY_b64url', privateKey: 'never-sent' }, subject: `https://${HOST}`, titleOf: () => 't', send });
    s3 = http.createServer(createRequestHandler({ token: TOKEN, uiDir: dir, usage, index, extraHosts: [HOST], push: { notifier, store } }));
    await new Promise<void>((r) => s3.listen(0, '127.0.0.1', r));
    port = (s3.address() as { port: number }).port;
  });
  afterAll(() => s3.close());

  it('serves sw.js revalidated with a root scope and the manifest as application/manifest+json', async () => {
    const sw = await raw('GET', '/sw.js', { host: `127.0.0.1:${port}` });
    expect(sw.status).toBe(200);
    expect(sw.headers['content-type']).toContain('text/javascript');
    expect(sw.headers['cache-control']).toBe('no-cache');
    expect(sw.headers['service-worker-allowed']).toBe('/');
    expect(sw.headers['content-security-policy']).toContain("worker-src 'self'");
    const mf = await raw('GET', '/manifest.webmanifest', { host: `127.0.0.1:${port}` });
    expect(mf.headers['content-type']).toContain('application/manifest+json');
    expect(mf.headers['cache-control']).toBe('no-cache');
    expect(mf.text).toBe('{"name":"deck"}');
  });

  it('accepts the https MagicDNS origin (no port) behind tailscale serve and marks the cookie Secure', async () => {
    const login = await raw('POST', '/api/login', { host: HOST, origin: `https://${HOST}`, 'x-forwarded-proto': 'https', 'content-type': 'application/json' }, JSON.stringify({ token: TOKEN }));
    expect(login.status).toBe(200);
    expect(String(login.headers['set-cookie'])).toMatch(/; Secure$/);
    const plain = await raw('POST', '/api/login', { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, JSON.stringify({ token: TOKEN }));
    expect(plain.status).toBe(200);
    expect(String(plain.headers['set-cookie'])).not.toContain('Secure');
    // Foreign https origin with the same Host, or the name with a port, is still refused.
    expect((await raw('POST', '/api/login', { host: HOST, origin: 'https://evil.example', 'content-type': 'application/json' }, JSON.stringify({ token: TOKEN }))).status).toBe(403);
    expect((await raw('POST', '/api/login', { host: HOST, origin: `https://${HOST}:444`, 'content-type': 'application/json' }, JSON.stringify({ token: TOKEN }))).status).toBe(403);
  });

  it('push endpoints need the cookie and a same-origin request', async () => {
    const h = { host: HOST, origin: `https://${HOST}`, 'content-type': 'application/json' };
    expect((await raw('GET', '/api/push/key', { host: HOST })).status).toBe(401);
    expect((await raw('POST', '/api/push/subscribe', h, JSON.stringify({ subscription: SUB }))).status).toBe(401);
    expect((await raw('POST', '/api/push/subscribe', { ...h, cookie, origin: 'https://evil.example' }, JSON.stringify({ subscription: SUB }))).status).toBe(403);
  });

  it('key → subscribe → status → test (only this device) → unsubscribe', async () => {
    const h = { host: HOST, origin: `https://${HOST}`, 'content-type': 'application/json', cookie };
    const key = await raw('GET', '/api/push/key', { host: HOST, cookie });
    expect(JSON.parse(key.text)).toEqual({ publicKey: 'PUBKEY_b64url' });
    expect(key.text).not.toContain('never-sent');
    expect((await raw('POST', '/api/push/subscribe', h, JSON.stringify({ subscription: { ...SUB, endpoint: 'https://evil.example/x' } }))).status).toBe(400);
    expect((await raw('POST', '/api/push/subscribe', h, JSON.stringify({ subscription: SUB }))).status).toBe(200);
    const other = { ...SUB, endpoint: 'https://web.push.apple.com/QOther' };
    expect((await raw('POST', '/api/push/subscribe', h, JSON.stringify({ subscription: other }))).status).toBe(200);
    expect(JSON.parse((await raw('POST', '/api/push/status', h, JSON.stringify({ endpoint: SUB.endpoint }))).text)).toEqual({ subscribed: true });
    sent.length = 0;
    expect((await raw('POST', '/api/push/test', h, JSON.stringify({ endpoint: SUB.endpoint }))).status).toBe(200);
    expect(sent.map((s) => s.endpoint)).toEqual([SUB.endpoint]);
    expect(JSON.parse(sent[0]!.payload)).toMatchObject({ kind: 'test', title: 'deck' });
    expect((await raw('POST', '/api/push/unsubscribe', h, JSON.stringify({ endpoint: SUB.endpoint }))).status).toBe(200);
    expect(JSON.parse((await raw('POST', '/api/push/status', h, JSON.stringify({ endpoint: SUB.endpoint }))).text)).toEqual({ subscribed: false });
    expect((await raw('POST', '/api/push/test', h, JSON.stringify({ endpoint: SUB.endpoint }))).status).toBe(502);
  });
});
