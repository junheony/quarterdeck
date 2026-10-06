import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isUnderRoots, resolveUnderRoots } from './dirs';

/** Files listed for the composer's @ picker, at most. */
export const MAX_FILES = 5000;
const WALK_SKIP = new Set(['node_modules', 'dist', 'build', 'target', '__pycache__', 'venv']);
const CACHE_MS = 10_000;

export type FileListing = { cwd: string; files: string[]; truncated: boolean; git: boolean };

function gitLsFiles(cwd: string, max: number): Promise<string[] | null> {
  return new Promise((resolve) => {
    // Tracked + untracked-but-not-ignored, relative to cwd (a subfolder of a repo lists only itself).
    execFile('git', ['-C', cwd, 'ls-files', '-co', '--exclude-standard', '-z'], { maxBuffer: 32 * 1024 * 1024, timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const files = stdout.split('\0').filter(Boolean);
      resolve(files.slice(0, max + 1));
    });
  });
}

/** No git: breadth-first walk, hidden entries and the usual build/dependency dirs skipped, symlinks not followed. */
async function walk(root: string, max: number): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  while (queue.length && out.length <= max) {
    const rel = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!WALK_SKIP.has(e.name)) queue.push(p); }
      else if (e.isFile()) { out.push(p); if (out.length > max) break; }
    }
  }
  return out;
}

/**
 * The composer's `@` picker: files under a session's cwd, relative to it. The cwd must resolve (symlinks
 * included) inside one of `roots` like `/api/dirs`; inside a git repo `git ls-files` decides (.gitignore
 * respected), otherwise a bounded walk. Listings are cached briefly per folder. Read-only.
 */
export class FileLister {
  private cache = new Map<string, { at: number; listing: FileListing }>();

  /** `denyRoots`: folders never previewed wherever the cwd is (deck's own config dir: token, VAPID key…). */
  constructor(private readonly opts: { home: string; roots: string[]; denyRoots?: string[]; max?: number; now?: () => number }) {}

  async list(input: string): Promise<FileListing> {
    const cwd = await resolveUnderRoots(input, this.opts.home, this.opts.roots);
    const now = (this.opts.now ?? Date.now)();
    const hit = this.cache.get(cwd);
    if (hit && now - hit.at < CACHE_MS) return hit.listing;
    const max = this.opts.max ?? MAX_FILES;
    const fromGit = await gitLsFiles(cwd, max);
    const all = fromGit ?? (await walk(cwd, max));
    // git paths are already relative and inside cwd; anything odd (absolute, ..) is dropped anyway.
    const files = all.filter((f) => !f.startsWith('/') && !f.split('/').includes('..'));
    const listing: FileListing = { cwd, files: files.slice(0, max), truncated: files.length > max, git: fromGit !== null };
    this.cache.set(cwd, { at: now, listing });
    if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value!);
    return listing;
  }

  /** Side panel: one file of the session folder `cwd` (see readSessionFile). */
  read(cwd: string, file: string): Promise<FilePreview> {
    return readSessionFile({ home: this.opts.home, roots: this.opts.roots, cwd, file, ...(this.opts.denyRoots ? { denyRoots: this.opts.denyRoots } : {}) });
  }
}

/** /api/file: bigger files are refused (the panel is a preview, not an editor). */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

export type FilePreview =
  | { path: string; size: number; kind: 'text'; text: string }
  | { path: string; size: number; kind: 'image'; mediaType: string; base64: string };

/** A file /api/file refuses; `status` is the HTTP status, the message is shown to the user. */
export class FileReadError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 413 | 415) { super(message); }
}

/**
 * Directly under home, every dotfile / dotdir (.claude*, .ssh, .config, .zsh_history…) and ~/Library hold credentials,
 * shell history or other apps' state: never previewed, wherever the cwd is (a cwd of ~ included). Project dotdirs
 * (`~/code/x/.github`) are not at home level and stay readable.
 */
const DENY_HOME_FIRST = (seg: string) => seg.startsWith('.') || seg === 'Library';
/** Directories (any depth) that are credential stores. */
const DENY_DIR_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.codex']);
/** Credential-looking file names (any depth). `.env.example`-style templates stay readable. */
const DENY_FILE = /^(\.env(\.(?!example$|sample$|template$)[\w.-]+)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.pgpass|auth\.json|credentials(\.json)?|\.credentials\.json|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keystore|jks|kdbx)|\..*_history|\.vault-token|.*\.tfrc\.json|service-account.*\.json|logins\.json|key4\.db)$/i;

/** True when `real` (an absolute real path) must never be previewed. */
export function isDeniedPath(real: string, home: string): boolean {
  const parts = real.split(path.sep).filter(Boolean);
  if (DENY_FILE.test(parts.at(-1) ?? '')) return true;
  if (parts.slice(0, -1).some((p) => DENY_DIR_SEGMENTS.has(p))) return true;
  const rel = path.relative(home, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return DENY_HOME_FIRST(rel.split(path.sep)[0]!);
}

const IMAGE_MAGIC: { type: string; test: (b: Buffer) => boolean }[] = [
  { type: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { type: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/**
 * Side panel preview (`GET /api/file`): one file inside a session's folder. The cwd must resolve inside `roots`
 * (like /api/files), the file's REAL path (symlinks resolved) must lie inside that cwd, the deny list above applies
 * to both the requested and the real path, and the file is opened O_NOFOLLOW so a symlink swapped in after the
 * check is refused. Text (no NUL in the first 8 KiB, valid UTF-8) or a sniffed raster image; anything else 415.
 */
export async function readSessionFile(opts: { home: string; roots: string[]; cwd: string; file: string; max?: number; denyRoots?: string[] }): Promise<FilePreview> {
  const cwd = await resolveUnderRoots(opts.cwd, opts.home, opts.roots);
  const raw = opts.file.trim();
  if (!raw || raw.includes('\0')) throw new FileReadError('파일 경로가 필요합니다', 400);
  const abs = raw.startsWith('~/') ? path.join(opts.home, raw.slice(2)) : path.resolve(cwd, raw);
  const realHome = await fs.realpath(opts.home).catch(() => opts.home);
  const denyRoots = (await Promise.all((opts.denyRoots ?? []).map(async (d) => [d, await fs.realpath(d).catch(() => d)]))).flat();
  const denied = (p: string, h: string) => isDeniedPath(p, h) || isUnderRoots(p, denyRoots);
  if (denied(abs, opts.home) || denied(abs, realHome)) throw new FileReadError('보안상 열 수 없는 파일입니다', 403);
  let real: string;
  try { real = await fs.realpath(abs); } catch {
    // Don't confirm whether paths outside the folder exist.
    throw isUnderRoots(abs, [cwd]) ? new FileReadError('파일을 찾을 수 없습니다', 404) : new FileReadError('세션 폴더 안의 파일만 열 수 있습니다', 403);
  }
  if (!isUnderRoots(real, [cwd])) throw new FileReadError('세션 폴더 안의 파일만 열 수 있습니다', 403);
  if (denied(real, realHome)) throw new FileReadError('보안상 열 수 없는 파일입니다', 403);
  let fh: import('node:fs/promises').FileHandle;
  try { fh = await fs.open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch { throw new FileReadError('파일을 열 수 없습니다', 404); }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new FileReadError('파일이 아닙니다', 400);
    // The opened file must still be the one checked (no swap of a parent dir in between), and a hard link to a file
    // elsewhere (another name for a denied file) is refused.
    const again = await fs.realpath(abs).then((r) => (r === real ? fs.stat(r) : null), () => null);
    if (!again || again.ino !== st.ino || again.dev !== st.dev || st.nlink > 1) throw new FileReadError('파일을 열 수 없습니다', 403);
    if (st.size > (opts.max ?? MAX_PREVIEW_BYTES)) throw new FileReadError('파일이 너무 커서 미리 볼 수 없습니다 (2MB 초과)', 413);
    const buf = await fh.readFile();
    const image = IMAGE_MAGIC.find((m) => m.test(buf));
    if (image) return { path: real, size: st.size, kind: 'image', mediaType: image.type, base64: buf.toString('base64') };
    if (buf.subarray(0, 8192).includes(0)) throw new FileReadError('바이너리 파일은 미리 볼 수 없습니다', 415);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { throw new FileReadError('텍스트 파일이 아닙니다', 415); }
    return { path: real, size: st.size, kind: 'text', text };
  } finally {
    await fh.close();
  }
}
