import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Identifies the served UI build (hash of dist/ui/index.html, which names the hashed assets); null when there is no build (dev). */
export function computeBuildId(uiDir: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(uiDir, 'index.html'))).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/** A rebuild rewrites dist/ui file by file: index.html is trusted only once it has sat unchanged this long. */
const SETTLE_MS = 3000;
const live = new Map<string, { sig: string; id: string | null }>();

/** computeBuildId as of now: a UI rebuild without a server restart is noticed. Re-hashed only when index.html's mtime or size changes, and not while a build is still writing (the previous id is served until it settles). */
export function liveBuildId(uiDir: string, now: number = Date.now()): string | null {
  const hit = live.get(uiDir);
  let sig: string;
  let fresh: boolean;
  try {
    const st = fs.statSync(path.join(uiDir, 'index.html'));
    sig = `${st.mtimeMs}:${st.size}`;
    fresh = Math.abs(now - st.mtimeMs) < SETTLE_MS;
  } catch {
    // Missing mid-build (vite empties the folder first): the last known id stands.
    return hit?.id ?? null;
  }
  if (hit && (hit.sig === sig || fresh)) return hit.id;
  const id = computeBuildId(uiDir);
  // A failed read is not remembered: the next call tries again.
  if (id === null) return hit?.id ?? null;
  live.set(uiDir, { sig, id });
  return id;
}
