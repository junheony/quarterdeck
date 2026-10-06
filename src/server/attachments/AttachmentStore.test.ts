import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ATTACHMENT_MAX_AGE_MS, AttachmentStore, AttachmentTooLarge, MAX_ATTACHMENT_BYTES, promptWithFiles, safeName, sniffImage } from './AttachmentStore';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
let base = '';
let now = Date.parse('2026-09-30T12:00:00Z');

beforeEach(async () => { base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-att-')); });
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

describe('helpers', () => {
  it('safeName keeps letters/digits/._- (incl. Korean), drops paths and leading dots, caps at 80', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('.env')).toBe('env');
    expect(safeName('스크린샷 2026-09-30 at 1.png')).toBe('스크린샷 2026-09-30 at 1.png');
    expect(safeName('a;rm -rf $(x).png')).toBe('a_rm -rf __x_.png');
    expect(safeName('x'.repeat(100)).length).toBe(80);
    expect(safeName('')).toBe('file');
  });

  it('sniffImage recognises png/jpeg/gif/webp by magic bytes only', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    expect(sniffImage(Buffer.from('<svg xmlns=…'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });

  it('promptWithFiles appends a path line per non-image attachment', () => {
    const img = { id: '1', name: 'a.png', mediaType: 'image/png', size: 1, path: '/d/1-a.png', isImage: true, createdAtMs: 0 };
    const doc = { id: '2', name: 'notes.md', mediaType: 'application/octet-stream', size: 1, path: '/d/2-notes.md', isImage: false, createdAtMs: 0 };
    expect(promptWithFiles('hi', [img])).toBe('hi');
    expect(promptWithFiles('hi', [img, doc])).toBe('hi\n\n첨부 파일: /d/2-notes.md');
  });
});

describe('AttachmentStore (D7)', () => {
  it('saves under a 0700 dir as 0600 <uuid>-<safe name>, sniffs images, refuses oversize, resolves ids', async () => {
    const store = new AttachmentStore(path.join(base, 'att'), { now: () => now });
    await store.init();
    expect(((await fs.stat(path.join(base, 'att'))).mode & 0o777)).toBe(0o700);
    const a = await store.save('../shot.png', PNG);
    expect(a).toMatchObject({ name: 'shot.png', mediaType: 'image/png', size: PNG.length, isImage: true, createdAtMs: now });
    expect(a.path).toBe(path.join(base, 'att', `${a.id}-shot.png`));
    expect(((await fs.stat(a.path)).mode & 0o777)).toBe(0o600);
    const b = await store.save('fake.png', Buffer.from('not an image'));
    expect(b).toMatchObject({ mediaType: 'application/octet-stream', isImage: false });
    await expect(store.save('big.bin', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))).rejects.toBeInstanceOf(AttachmentTooLarge);
    expect(store.get(a.id)).toEqual(a);
    expect(store.resolve([a.id, 'missing'])).toEqual({ found: [a], missing: ['missing'] });
  });

  it('reload after restart re-sniffs files; purge removes files older than 7 days', async () => {
    const dir = path.join(base, 'att');
    const store = new AttachmentStore(dir, { now: () => now });
    await store.init();
    const a = await store.save('shot.png', PNG);
    const old = await store.save('old.txt', Buffer.from('x'));
    await fs.utimes(old.path, new Date(now - ATTACHMENT_MAX_AGE_MS - 1000), new Date(now - ATTACHMENT_MAX_AGE_MS - 1000));
    await fs.writeFile(path.join(dir, 'stray.txt'), 'ignored: no uuid prefix');
    const again = new AttachmentStore(dir, { now: () => now });
    await again.init(); // init re-indexes, then purges
    expect(again.get(a.id)).toMatchObject({ id: a.id, name: 'shot.png', mediaType: 'image/png', isImage: true });
    expect(again.get(old.id)).toBeNull();
    await expect(fs.access(old.path)).rejects.toThrow();
    now += ATTACHMENT_MAX_AGE_MS + 1;
    expect(await again.purge()).toBe(1);
    expect(again.get(a.id)).toBeNull();
  });

  // Fix round 1 finding 2: reload() must lstat (never follow symlinks) — a symlinked
  // attachment entry (e.g. pointing at a secret file outside the store) must never be
  // indexed, since its path is later handed to the model as a readable attachment.
  it('never indexes a symlinked entry, even one that resolves to a real file', async () => {
    const dir = path.join(base, 'att');
    const store = new AttachmentStore(dir, { now: () => now });
    await store.init();
    const secret = path.join(base, 'secret.txt');
    await fs.writeFile(secret, 'top secret');
    const fakeId = '11111111-2222-3333-4444-555555555555';
    await fs.symlink(secret, path.join(dir, `${fakeId}-secret.txt`));
    const again = new AttachmentStore(dir, { now: () => now });
    await again.init();
    expect(again.get(fakeId)).toBeNull();
    expect(again.resolve([fakeId])).toEqual({ found: [], missing: [fakeId] });
  });

  // Fix round 1 finding 3: one removal failing (EPERM/EACCES from the filesystem) must not
  // throw out of purge() — init() awaits purge(), so an unhandled rejection here would take
  // down deck's startup entirely.
  it('purge logs and continues when a removal fails, without throwing (init included)', async () => {
    const dir = path.join(base, 'att');
    const store = new AttachmentStore(dir, { now: () => now });
    await store.init();
    const stale = await store.save('old.txt', Buffer.from('x'));
    await fs.utimes(stale.path, new Date(now - ATTACHMENT_MAX_AGE_MS - 1000), new Date(now - ATTACHMENT_MAX_AGE_MS - 1000));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rmSpy = vi.spyOn(fs, 'rm').mockRejectedValue(new Error('EACCES: permission denied'));
    try {
      now += ATTACHMENT_MAX_AGE_MS + 1;
      await expect(store.purge()).resolves.toBe(0);
      expect(store.get(stale.id)).not.toBeNull();
      expect(errSpy).toHaveBeenCalled();

      const again = new AttachmentStore(dir, { now: () => now });
      await expect(again.init()).resolves.toBeUndefined();
      expect(again.get(stale.id)).not.toBeNull();
    } finally {
      rmSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
