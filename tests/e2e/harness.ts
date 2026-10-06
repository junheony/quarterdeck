import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import WebSocket from 'ws';
import type { ServerMessage } from '../../src/shared/protocol';
import { cookieValueFor } from '../../src/server/auth';
import { writeCooldown } from '../../src/server/routing/cooldown';
import { projectSlug } from '../../src/server/sessions/slug';

// Shared by every e2e file: one real deck server per file on a free loopback port, temp config /
// work / cooldown dirs, cookie login, and a WS message collector.

export type Deck = {
  base: string;
  cfgDir: string;
  workDir: string;
  cookie: string;
  connect(): Promise<WebSocket>;
  stop(): Promise<void>;
};

export async function waitFor(fn: () => Promise<boolean>, ms: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('timeout');
}

const buffers = new WeakMap<WebSocket, unknown[]>();

/**
 * Buffered from connection time: the server's first WS frame can arrive in the same read as the
 * upgrade response, so 'open' and 'message' may fire in one synchronous turn (Plan 1 e2e note).
 */
export function collect(ws: WebSocket, until: (m: ServerMessage) => boolean, timeoutMs = 180_000): Promise<ServerMessage[]> {
  if (!buffers.has(ws)) {
    const buf: unknown[] = [];
    buffers.set(ws, buf);
    ws.on('message', (d) => buf.push(d));
  }
  return new Promise((resolve, reject) => {
    const out: ServerMessage[] = [];
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; reject(new Error(`timeout after ${out.length} msgs: ${JSON.stringify(out.slice(-3)).slice(0, 500)}`)); } }, timeoutMs);
    const consume = (d: unknown) => {
      if (done) return;
      const m = JSON.parse(String(d)) as ServerMessage;
      out.push(m);
      if (until(m)) { done = true; clearTimeout(t); resolve(out); }
    };
    const buf = buffers.get(ws)!;
    for (const d of buf.splice(0, buf.length)) consume(d);
    if (!done) ws.on('message', consume);
  });
}

/** Answers every permission prompt with `once` while `until` has not matched (for tools that read outside cwd). */
export function collectAllowing(ws: WebSocket, until: (m: ServerMessage) => boolean, timeoutMs = 180_000): Promise<ServerMessage[]> {
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as ServerMessage;
    if (m.type === 'permission_request') ws.send(JSON.stringify({ type: 'permission_response', requestId: m.requestId, decision: 'once' }));
  });
  return collect(ws, until, timeoutMs);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Starts `src/server/main.ts` with temp dirs. D13: unless `pinB: false`, accounts a and c get a
 * 6 h cooldown in the server's own temp cooldown dir (never ~/.cache/offload/cooldown), so the
 * router can only pick B (keeps the suite on one account, away from the protected one).
 */
export async function startDeck(opts: { pinB?: boolean } = {}): Promise<Deck> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-e2e-cfg-'));
  // macOS: tmpdir is under the /var → /private/var symlink and the CLI records the real path.
  const workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-e2e-work-')));
  const cooldownDir = path.join(cfgDir, 'cooldown');
  if (opts.pinB !== false) for (const a of ['a', 'c'] as const) writeCooldown(cooldownDir, a, Date.now() + 6 * 3_600_000);
  const child: ChildProcess = spawn('npx', ['tsx', 'src/server/main.ts'], {
    cwd: process.cwd(), // npm run test:e2e runs from the repo root
    env: { ...process.env, DECK_CONFIG_DIR: cfgDir, DECK_PORT: String(port), DECK_LOOPBACK_ONLY: '1', DECK_UI_DIR: cfgDir, DECK_EXTRA_CWD_ROOTS: path.dirname(workDir), CLAUDE_PICK_COOLDOWN_DIR: cooldownDir },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  // Review M15: wait for the server to exit before removing the dirs it may still write to.
  // SIGTERM first: `npx` forwards it to tsx/node, while a SIGKILL on npx would orphan them.
  const killServer = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10_000))]);
  };
  let cookie: string;
  try {
    await waitFor(async () => (await fetch(`${base}/api/me`)).status === 401, 30_000);
    const token = (await fs.readFile(path.join(cfgDir, 'token'), 'utf8')).trim();
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token }) });
    if (res.status !== 200) throw new Error(`login ${res.status}`);
    cookie = `deck_session=${cookieValueFor(token)}`;
  } catch (err) {
    // Setup failed after spawn: leave no server process or temp dirs behind.
    await killServer();
    await fs.rm(cfgDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
    throw err;
  }
  const home = os.homedir();
  const roots = [path.join(home, '.claude/projects'), path.join(home, '.claude-b/projects'), path.join(home, '.claude-c/projects')];
  return {
    base, cfgDir, workDir, cookie,
    connect: () => new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie, Origin: base } });
      buffers.set(ws, []);
      ws.on('message', (d) => buffers.get(ws)!.push(d));
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    }),
    stop: async () => {
      await killServer();
      // Only this file's unique temp workDir slug — never other projects' session files.
      for (const r of roots) await fs.rm(path.join(r, projectSlug(workDir)), { recursive: true, force: true });
      await fs.rm(cfgDir, { recursive: true, force: true });
      await fs.rm(workDir, { recursive: true, force: true });
    },
  };
}

export async function upload(deck: Deck, name: string, data: Buffer): Promise<{ id: string; name: string; isImage: boolean }> {
  // PF10: Buffer is not BodyInit under TS; a Uint8Array view is.
  const res = await fetch(`${deck.base}/api/attachments`, { method: 'POST', headers: { cookie: deck.cookie, origin: deck.base, 'content-type': 'application/octet-stream', 'x-deck-filename': encodeURIComponent(name) }, body: new Uint8Array(data) });
  if (res.status !== 201) throw new Error(`upload ${res.status}`);
  return (await res.json()) as { id: string; name: string; isImage: boolean };
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(width: number, height: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A valid 1×1 truecolor PNG of one solid color (for the vision e2e). */
export function pngSolid(r: number, g: number, b: number): Buffer {
  return png(1, 1, Buffer.from([0, r, g, b])); // filter byte + RGB
}

/** A valid size×size truecolor PNG of random noise (incompressible: ≈ 3·size² bytes). */
export function pngNoise(size: number): Buffer {
  const row = 1 + 3 * size;
  const raw = crypto.randomBytes(row * size);
  for (let y = 0; y < size; y++) raw[y * row] = 0; // filter byte "none" on every row
  return png(size, size, raw);
}
