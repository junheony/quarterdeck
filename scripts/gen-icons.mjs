// Generates the PWA icons and the notification badge as PNGs — no dependencies, the outputs are committed.
// Run: node scripts/gen-icons.mjs   (writes src/ui/public/icons/*.png)
//
// The app icon is cut from scripts/assets/deck-icon-1024.png (the deck mark: a glossy terracotta chip with a cream `>_`
// on the dark theme background). Each size is a crop around the chip, box-filtered down. The badge (Android shows it
// as a monochrome silhouette next to the notification — a colour icon with a background turns into a white square)
// is the `>_` alone, white on transparent, drawn here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, 'assets', 'deck-icon-1024.png');
const OUT = path.resolve(here, '..', 'src', 'ui', 'public', 'icons');

// ---- PNG ----

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
/** 8-bit truecolor PNG: `channels` 3 = RGB, 4 = RGBA. */
function encodePng(w, h, channels, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colour type
  const stride = w * channels;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** 8-bit RGB/RGBA, non-interlaced only (what the source is). */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const idat = [];
  let w = 0, h = 0, channels = 0;
  for (let off = 8; off < buf.length;) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      channels = { 2: 3, 6: 4 }[data[9]];
      if (data[8] !== 8 || !channels || data[12] !== 0) throw new Error('source must be 8-bit RGB/RGBA, non-interlaced');
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? px[dst + i - channels] : 0;
      const b = y > 0 ? px[dst - stride + i] : 0;
      const c = y > 0 && i >= channels ? px[dst - stride + i - channels] : 0;
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[dst + i] = v & 0xff;
    }
  }
  return { w, h, channels, px };
}

// ---- The app icon: crops of the source ----

/** Where the chip sits in the source (measured: its bounding box is x 217..805, y 184..770). */
const CHIP = { cx: 511.5, cy: 477.5, size: 589 };

/** Box-filtered crop: the source window `win` px wide, centred on the chip, scaled to `size`. RGB out. */
function cropResize(src, win, size) {
  const out = Buffer.alloc(size * size * 3);
  const scale = win / size;
  const x0 = CHIP.cx - win / 2, y0 = CHIP.cy - win / 2;
  if (x0 < 0 || y0 < 0 || x0 + win > src.w || y0 + win > src.h) throw new Error(`window ${win} leaves the source`);
  const overlap = (a0, a1, i) => Math.max(0, Math.min(a1, i + 1) - Math.max(a0, i));
  for (let y = 0; y < size; y++) {
    const sy0 = y0 + y * scale, sy1 = sy0 + scale;
    for (let x = 0; x < size; x++) {
      const sx0 = x0 + x * scale, sx1 = sx0 + scale;
      const acc = [0, 0, 0];
      let wsum = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        const wy = overlap(sy0, sy1, sy);
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          const wgt = wy * overlap(sx0, sx1, sx);
          const i = (sy * src.w + sx) * src.channels;
          for (let c = 0; c < 3; c++) acc[c] += src.px[i + c] * wgt;
          wsum += wgt;
        }
      }
      for (let c = 0; c < 3; c++) out[(y * size + x) * 3 + c] = Math.round(acc[c] / wsum);
    }
  }
  return out;
}

// ---- The badge: the `>_` alone ----

/** The glyph's centre lines in chip units (0..1 of the chip's side), measured off the source; stroke = 0.124 of the chip. */
const GLYPH = {
  strokes: [
    [[0.272, 0.315], [0.47, 0.505]],
    [[0.47, 0.505], [0.272, 0.695]],
    [[0.58, 0.695], [0.757, 0.695]],
  ],
  width: 0.124,
  bounds: { x0: 0.21, x1: 0.82, y0: 0.25, y1: 0.76 }, // outer extent, caps included
};

function segDist(px, py, [[ax, ay], [bx, by]]) {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** White `>_` on transparent, the glyph `fill` wide (fraction of the frame), centred. RGBA out. */
function renderBadge(size, fill) {
  const out = Buffer.alloc(size * size * 4);
  const k = (fill * size) / (GLYPH.bounds.x1 - GLYPH.bounds.x0); // chip side in px
  const gx = (GLYPH.bounds.x0 + GLYPH.bounds.x1) / 2, gy = (GLYPH.bounds.y0 + GLYPH.bounds.y1) / 2;
  const half = (GLYPH.width * k) / 2;
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS - size / 2 + gx * k;
          const py = y + (sy + 0.5) / SS - size / 2 + gy * k;
          const u = px / k, v = py / k;
          let d = Infinity;
          for (const s of GLYPH.strokes) d = Math.min(d, segDist(u, v, s) * k);
          if (d <= half) hit++;
        }
      }
      const i = (y * size + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = 0xff;
      out[i + 3] = Math.round((255 * hit) / (SS * SS));
    }
  }
  return out;
}

// ---- Outputs ----

const src = decodePng(fs.readFileSync(SOURCE));
fs.mkdirSync(OUT, { recursive: true });
const chipWindow = (fraction) => CHIP.size / fraction;
const icons = [
  // The chip at 74% of the frame, the dark background around it (favicon, Android notification, iOS home screen).
  ['icon-192.png', 192, chipWindow(0.74)],
  ['icon-512.png', 512, chipWindow(0.74)],
  ['apple-touch-icon.png', 180, chipWindow(0.74)],
  // Maskable: the platform may crop to a circle of 80% — the chip (corners included) stays inside it at 62%.
  ['icon-maskable-512.png', 512, chipWindow(0.62)],
];
for (const [name, size, win] of icons) {
  fs.writeFileSync(path.join(OUT, name), encodePng(size, size, 3, cropResize(src, win, size)));
  console.log(`wrote ${name} (${size}x${size})`);
}
fs.writeFileSync(path.join(OUT, 'badge-96.png'), encodePng(96, 96, 4, renderBadge(96, 0.8)));
console.log('wrote badge-96.png (96x96, alpha)');
