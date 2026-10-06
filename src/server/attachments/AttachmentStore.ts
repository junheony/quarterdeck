import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MAX_ATTACHMENT_BYTES } from '../../shared/protocol';

/** D7 limits: per file and per turn (the per-turn cap lives in shared/protocol MAX_ATTACHMENTS_PER_TURN).
 *  MAX_ATTACHMENT_BYTES now lives in shared/protocol (Task 11) so the UI can pre-flight-check size
 *  without duplicating the magic number; re-exported here so existing server imports keep working. */
export { MAX_ATTACHMENT_BYTES };
export const ATTACHMENT_MAX_AGE_MS = 7 * 24 * 3_600_000;
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A store id is exactly a lowercase UUID — never a path or anything path-like. */
export function isAttachmentId(x: unknown): x is string {
  return typeof x === 'string' && ID_RE.test(x);
}

export type Attachment = {
  id: string;
  /** Sanitized original name (display + file suffix). */
  name: string;
  /** Sniffed from magic bytes: an image type, else application/octet-stream. Never taken from the client. */
  mediaType: string;
  size: number;
  /** Absolute path in the private dir. */
  path: string;
  isImage: boolean;
  createdAtMs: number;
};

export class AttachmentTooLarge extends Error {
  constructor() { super(`첨부가 너무 큽니다(최대 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB)`); }
}

/** Basename only, letters/digits/space/._- (any script), no leading dots, ≤ 80 chars, never empty. */
export function safeName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).normalize('NFC');
  const cleaned = base.replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/^\.+/, '').trim();
  return (cleaned || 'file').slice(0, 80);
}

export function sniffImage(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Non-image attachments are handed to the model as absolute paths it can read (D7). */
export function promptWithFiles(text: string, attachments: Attachment[]): string {
  const files = attachments.filter((a) => !a.isImage);
  return files.length ? `${text}\n\n${files.map((f) => `첨부 파일: ${f.path}`).join('\n')}` : text;
}

export class AttachmentStore {
  private byId = new Map<string, Attachment>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(private readonly dir: string, opts: { maxAgeMs?: number; now?: () => number } = {}) {
    this.maxAgeMs = opts.maxAgeMs ?? ATTACHMENT_MAX_AGE_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Creates the private dir, purges stale files, and re-indexes what is left (names carry the id). */
  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dir, 0o700);
    await this.reload();
    await this.purge();
  }

  private async reload(): Promise<void> {
    this.byId = new Map();
    for (const name of await fs.readdir(this.dir)) {
      const id = name.slice(0, 36);
      if (!ID_RE.test(id) || name[36] !== '-') continue;
      const file = path.join(this.dir, name);
      try {
        // Fix round 1 finding 2: lstat (never follow symlinks) — a symlink planted in the
        // attachments dir (e.g. `<uuid>-x` -> ~/.ssh/id_ed25519) must never be indexed and
        // handed to the model as an attachment path. lstat().isFile() is false for a symlink
        // (isSymbolicLink() would be true instead), so this also naturally skips them.
        const st = await fs.lstat(file);
        if (!st.isFile()) continue;
        const fh = await fs.open(file, 'r');
        let head: Buffer;
        try { const buf = Buffer.alloc(12); const { bytesRead } = await fh.read(buf, 0, 12, 0); head = buf.subarray(0, bytesRead); } finally { await fh.close(); }
        const mediaType = sniffImage(head) ?? 'application/octet-stream';
        this.byId.set(id, { id, name: name.slice(37), mediaType, size: st.size, path: file, isImage: IMAGE_TYPES.has(mediaType), createdAtMs: st.mtimeMs });
      } catch {
        // unreadable: skip
      }
    }
  }

  async save(name: string, data: Buffer): Promise<Attachment> {
    if (data.length > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLarge();
    const id = randomUUID();
    const clean = safeName(name);
    const mediaType = sniffImage(data) ?? 'application/octet-stream';
    const file = path.join(this.dir, `${id}-${clean}`);
    await fs.writeFile(file, data, { mode: 0o600, flag: 'wx' });
    const now = this.now();
    await fs.utimes(file, new Date(now), new Date(now));
    const a: Attachment = { id, name: clean, mediaType, size: data.length, path: file, isImage: IMAGE_TYPES.has(mediaType), createdAtMs: now };
    this.byId.set(id, a);
    return a;
  }

  get(id: string): Attachment | null {
    return this.byId.get(id) ?? null;
  }

  resolve(ids: string[]): { found: Attachment[]; missing: string[] } {
    const found: Attachment[] = [];
    const missing: string[] = [];
    for (const id of ids) { const a = this.byId.get(id); if (a) found.push(a); else missing.push(id); }
    return { found, missing };
  }

  /**
   * Deletes files older than maxAgeMs (by mtime). Returns how many were removed.
   * Fix round 1 finding 3: a single failed removal (EPERM/EACCES) must not throw out of
   * purge() — init() awaits this, so an unhandled rejection here would fail deck startup.
   * Each removal gets its own try/catch: log and continue, leaving that entry indexed so a
   * later purge can retry it.
   */
  async purge(): Promise<number> {
    let n = 0;
    const cutoff = this.now() - this.maxAgeMs;
    for (const a of [...this.byId.values()]) {
      if (a.createdAtMs > cutoff) continue;
      try {
        await fs.rm(a.path, { force: true });
        this.byId.delete(a.id);
        n++;
      } catch (err) {
        console.error('deck attachments: 삭제 실패', a.path, err);
      }
    }
    return n;
  }

  startPurgeTimer(intervalMs = 6 * 3_600_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.purge().catch(() => {}), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
