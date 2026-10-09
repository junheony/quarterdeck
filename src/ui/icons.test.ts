import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** The committed outputs of scripts/gen-icons.mjs, as the manifest, index.html and the service worker refer to them. */
const dir = path.resolve(__dirname, 'public', 'icons');
const header = (name: string) => {
  const b = fs.readFileSync(path.join(dir, name));
  expect(b.readUInt32BE(0)).toBe(0x89504e47); // PNG
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colour: b[25] };
};

describe('PWA icons', () => {
  it.each([
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['icon-maskable-512.png', 512],
    ['apple-touch-icon.png', 180],
  ])('%s is an opaque RGB PNG of %ipx', (name, size) => {
    expect(header(name)).toEqual({ w: size, h: size, colour: 2 });
  });

  it('the notification badge is the mark alone on transparency (Android draws it as a silhouette)', () => {
    expect(header('badge-96.png')).toEqual({ w: 96, h: 96, colour: 6 });
    const sw = fs.readFileSync(path.resolve(__dirname, 'public', 'sw.js'), 'utf8');
    expect(sw).toMatch(/badge: '\/icons\/badge-96\.png'/);
    expect(sw).toMatch(/icon: '\/icons\/icon-192\.png'/);
  });

  it('every icon the manifest and index.html name exists', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'public', 'manifest.webmanifest'), 'utf8')) as { icons: { src: string; sizes: string }[] };
    const html = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf8');
    const refs = [...manifest.icons.map((i) => i.src), ...[...html.matchAll(/href="(\/icons\/[^"]+)"/g)].map((m) => m[1]!)];
    expect(refs.length).toBeGreaterThanOrEqual(4);
    for (const ref of refs) expect(fs.existsSync(path.join(dir, path.basename(ref))), ref).toBe(true);
    for (const i of manifest.icons) expect(`${header(path.basename(i.src)).w}x${header(path.basename(i.src)).h}`).toBe(i.sizes);
  });
});
