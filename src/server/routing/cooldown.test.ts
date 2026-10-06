import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultCooldownDir, readAllCooldownsMs, readCooldownUntilMs, writeCooldown } from './cooldown';

describe('cooldown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cd-'));
  const now = 1_790_000_000_000;

  it('resolves the directory the way claude-pick does', () => {
    expect(defaultCooldownDir({ CLAUDE_PICK_COOLDOWN_DIR: '/x/cd' }, '/h')).toBe('/x/cd');
    expect(defaultCooldownDir({ XDG_CACHE_HOME: '/xdg' }, '/h')).toBe('/xdg/offload/cooldown');
    expect(defaultCooldownDir({}, '/h')).toBe('/h/.cache/offload/cooldown');
  });

  it('writes epoch seconds and reads back milliseconds; expired or missing → null', () => {
    writeCooldown(dir, 'b', now + 3_600_000);
    expect(fs.readFileSync(path.join(dir, 'b'), 'utf8').trim()).toBe(String(Math.floor((now + 3_600_000) / 1000)));
    expect(readCooldownUntilMs(dir, 'b', now)).toBe(Math.floor((now + 3_600_000) / 1000) * 1000);
    expect(readCooldownUntilMs(dir, 'b', now + 3_600_001)).toBeNull();
    expect(readCooldownUntilMs(dir, 'a', now)).toBeNull();
  });

  it('reads floats like claude-pick (offload itself writes integer seconds) and ignores garbage', () => {
    fs.writeFileSync(path.join(dir, 'c'), `${(now + 5000) / 1000}\n`);
    expect(readCooldownUntilMs(dir, 'c', now)).toBe(now + 5000);
    fs.writeFileSync(path.join(dir, 'a'), 'soon\n');
    expect(readCooldownUntilMs(dir, 'a', now)).toBeNull();
    expect(readAllCooldownsMs(dir, now, ['a', 'b', 'c'])).toEqual({ b: Math.floor((now + 3_600_000) / 1000) * 1000, c: now + 5000 });
  });

  it('rejects what Python float() rejects', () => {
    for (const bad of ['123abc', '1790000000x', '', '0x10', '1,5']) {
      fs.writeFileSync(path.join(dir, 'a'), `${bad}\n`);
      expect(readCooldownUntilMs(dir, 'a', 0)).toBeNull();
    }
    for (const [good, ms] of [[' 1790000000 ', 1_790_000_000_000], ['1.79e9', 1_790_000_000_000], ['+1790000000.25', 1_790_000_000_250]] as const) {
      fs.writeFileSync(path.join(dir, 'a'), `${good}\n`);
      expect(readCooldownUntilMs(dir, 'a', 0)).toBe(ms);
    }
    fs.rmSync(path.join(dir, 'a'));
  });

  it('rounds up so a sub-second cooldown still lies in the future', () => {
    writeCooldown(dir, 'a', now + 1);
    expect(readCooldownUntilMs(dir, 'a', now)).toBe(now + 1000);
    fs.rmSync(path.join(dir, 'a'));
  });

  it('writes atomically (tmp file in the same dir, then rename)', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cd-atomic-'));
    const spy = vi.spyOn(fs, 'renameSync');
    let calls: unknown[][];
    try {
      writeCooldown(d, 'b', now + 5000);
    } finally {
      calls = [...spy.mock.calls];
      spy.mockRestore();
    }
    expect(calls).toHaveLength(1);
    const [from, to] = calls[0]!;
    expect(path.dirname(String(from))).toBe(d);
    expect(String(to)).toBe(path.join(d, 'b'));
    expect(fs.readdirSync(d)).toEqual(['b']);
  });

  it('creates the directory on write', () => {
    const fresh = path.join(dir, 'nested', 'cooldown');
    writeCooldown(fresh, 'a', now + 1000);
    expect(readCooldownUntilMs(fresh, 'a', now)).toBe(now + 1000);
  });
});
