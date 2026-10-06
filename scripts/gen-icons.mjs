// Generates the PWA icons (✳ mark on the dark theme background) as PNGs — no external assets.
// Run: node scripts/gen-icons.mjs   (writes src/ui/public/icons/*.png; the outputs are committed)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const BG = [0x1b, 0x1b, 0x1a];
const MARK = [0xd9, 0x77, 0x57];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Distance from (px,py) to the segment through the centre at `angle`, half-length `r`. */
function segDist(px, py, angle, r) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const t = Math.max(-r, Math.min(r, px * dx + py * dy));
  return Math.hypot(px - t * dx, py - t * dy);
}

/** ✳: four rounded strokes (0°, 45°, 90°, 135°). `scale` = mark radius as a fraction of the icon. */
function render(size, scale) {
  const out = Buffer.alloc(size * size * 3);
  const r = size * scale;
  const half = size * scale * 0.13; // stroke half-width
  const SS = 4; // supersampling per axis
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS - size / 2;
          const py = y + (sy + 0.5) / SS - size / 2;
          let d = Infinity;
          for (let k = 0; k < 4; k++) d = Math.min(d, segDist(px, py, (k * Math.PI) / 4, r - half));
          if (d <= half) hit++;
        }
      }
      const a = hit / (SS * SS);
      for (let c = 0; c < 3; c++) out[(y * size + x) * 3 + c] = Math.round(BG[c] * (1 - a) + MARK[c] * a);
    }
  }
  return out;
}

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'public', 'icons');
fs.mkdirSync(dir, { recursive: true });
const icons = [
  ['icon-192.png', 192, 0.34],
  ['icon-512.png', 512, 0.34],
  // Maskable: the platform may crop to a circle of 80% — keep the mark well inside it.
  ['icon-maskable-512.png', 512, 0.26],
  ['apple-touch-icon.png', 180, 0.32],
];
for (const [name, size, scale] of icons) {
  fs.writeFileSync(path.join(dir, name), png(size, render(size, scale)));
  console.log(`wrote ${name} (${size}x${size})`);
}
