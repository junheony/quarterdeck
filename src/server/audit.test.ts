import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendAudit, hashInput, type AuditEntry } from './audit';

const entry = (i: number): AuditEntry => ({ ts: `t${i}`, turnId: 'tu', sessionId: 's', toolName: 'Bash', decision: 'allow', source: 'rule', inputSha256: hashInput({ i }) });

describe('appendAudit', () => {
  it('rotates to <file>.1 once the log reaches maxBytes, keeps every line exactly once, and never loses order under concurrency', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-audit-'));
    const file = path.join(dir, 'sub', 'audit.log');
    const one = JSON.stringify(entry(0)).length + 1;
    await Promise.all(Array.from({ length: 5 }, (_, i) => appendAudit(file, entry(i), one * 3)));
    const cur = (await fs.readFile(file, 'utf8')).trim().split('\n').map((l) => (JSON.parse(l) as AuditEntry).ts);
    const old = (await fs.readFile(`${file}.1`, 'utf8')).trim().split('\n').map((l) => (JSON.parse(l) as AuditEntry).ts);
    expect([...old, ...cur]).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(old).toHaveLength(3);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a failed write rejects for its caller but does not block the next one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-audit-'));
    const file = path.join(dir, 'audit.log');
    await fs.mkdir(file);
    await expect(appendAudit(file, entry(0))).rejects.toThrow();
    await fs.rm(file, { recursive: true });
    await appendAudit(file, entry(1));
    expect(await fs.readFile(file, 'utf8')).toContain('"ts":"t1"');
    await fs.rm(dir, { recursive: true, force: true });
  });
  it('a rotation that fails (the .1 slot is a non-empty directory) still appends every line', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-audit-'));
    const file = path.join(dir, 'audit.log');
    await fs.mkdir(`${file}.1`);
    await fs.writeFile(path.join(`${file}.1`, 'x'), 'x');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 4; i++) await appendAudit(file, entry(i), 10);
      const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as AuditEntry);
      expect(lines.map((l) => l.ts)).toEqual(['t0', 't1', 't2', 't3']);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
