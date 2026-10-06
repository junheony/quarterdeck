import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PermissionDecision } from '../shared/turn-types';

export type AuditEntry = {
  ts: string;
  turnId: string;
  sessionId: string | null;
  toolName: string;
  /**
   * 'answered' = an AskUserQuestion the user answered (answers themselves are never logged); 'auto' = allowed by 자동 승인
   * without a card; 'allow' = run without a prompt (see `source`).
   */
  decision: PermissionDecision | 'answered' | 'auto' | 'allow';
  /**
   * Who decided: 'user' = a card the user answered, 'auto' = 모두 자동 승인, 'cli' = the CLI without asking (an allow
   * rule, the permission mode, or a tool that needs no permission), 'rule' = a deny rule (older lines: any no-prompt
   * call), 'deck' = deck refused it itself (malformed question, handoff note turn).
   */
  source?: 'user' | 'auto' | 'cli' | 'rule' | 'deck';
  /** sha256 of the JSON input — lets you correlate without storing secrets (spec §6). */
  inputSha256: string;
};

/** Past this size the log is moved to `<file>.1` (replacing the previous one) before the next line: at most ~2× this on disk. */
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

export function hashInput(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex');
}

/** Per file: appends (and the size check before each) run one at a time, so two lines never race a rotation. */
const queues = new Map<string, Promise<void>>();

export function appendAudit(file: string, e: AuditEntry, maxBytes = AUDIT_MAX_BYTES): Promise<void> {
  const run = (queues.get(file) ?? Promise.resolve()).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const size = await fs.stat(file).then((st) => st.size, () => 0);
    // A failed rotation (e.g. `.1` is a directory, or not writable) never costs a line: the log just grows past the cap.
    if (size >= maxBytes) await fs.rename(file, `${file}.1`).catch((err: unknown) => console.warn('deck: audit log rotation failed', err instanceof Error ? err.message : err));
    await fs.appendFile(file, JSON.stringify(e) + '\n', { mode: 0o600 });
  });
  const done = run.catch(() => undefined);
  queues.set(file, done);
  void done.then(() => { if (queues.get(file) === done) queues.delete(file); });
  return run;
}
