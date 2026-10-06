import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Account } from '../../shared/accounts';

export function defaultCooldownDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (env.CLAUDE_PICK_COOLDOWN_DIR) return env.CLAUDE_PICK_COOLDOWN_DIR;
  const cache = env.XDG_CACHE_HOME || path.join(home, '.cache');
  return path.join(cache, 'offload', 'cooldown');
}

export function readCooldownUntilMs(dir: string, account: Account, nowMs: number): number | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, account), 'utf8');
  } catch {
    return null;
  }
  // Same acceptance as claude-pick's Python float(): the whole stripped text must be a decimal number.
  const t = text.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const secs = Number(t);
  if (!Number.isFinite(secs)) return null;
  const untilMs = Math.round(secs * 1000);
  return untilMs > nowMs ? untilMs : null;
}

/** `accounts`: the registry's active ids; the file name is the account id. */
export function readAllCooldownsMs(dir: string, nowMs: number, accounts: readonly Account[]): Partial<Record<Account, number>> {
  const out: Partial<Record<Account, number>> = {};
  for (const a of accounts) {
    const v = readCooldownUntilMs(dir, a, nowMs);
    if (v !== null) out[a] = v;
  }
  return out;
}

export function writeCooldown(dir: string, account: Account, untilMs: number): void {
  fs.mkdirSync(dir, { recursive: true });
  // Atomic for concurrent readers (claude-pick/offload): tmp in the same dir, then rename.
  // ceil so a short cooldown never lands at or before now.
  const tmp = path.join(dir, `.${account}.deck-tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, `${Math.ceil(untilMs / 1000)}\n`);
  try {
    fs.renameSync(tmp, path.join(dir, account));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
