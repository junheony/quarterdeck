import fs from 'node:fs';
import path from 'node:path';

import { ACCEPTED_REFS_MAX, ACCEPTED_REFS_TTL_MS } from '../../shared/protocol';

export { ACCEPTED_REFS_MAX, ACCEPTED_REFS_TTL_MS };

type Entry = { ref: string; at: number };

/**
 * The client refs (send clientRef / steer steerId) each session accepted — a turn started for it, or the steer went in —
 * so a device whose socket died before the answer can tell whether its message went in (`history.acceptedRefs`).
 * Bounded (last ACCEPTED_REFS_MAX per session, ACCEPTED_REFS_TTL_MS) and written synchronously: it must survive the
 * drain restart, which is exactly when such answers get lost. The server also refuses a send / steer whose ref is listed
 * (`already_accepted`), so a resent copy never runs twice.
 *
 * Trade-off: a send is recorded at its turn_started, before the CLI has written it to the transcript. If the process dies
 * right then, the message counts as gone in although the transcript lacks it — the device drops its copy instead of
 * sending it twice; the user sees it missing and sends it again. A double send was judged worse than that.
 */
export class AcceptedRefs {
  private map = new Map<string, Entry[]>();

  constructor(private readonly file: string | null, private readonly now = () => Date.now()) {
    if (!file) return;
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; /* missing or corrupt: start empty */ }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    for (const [sid, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list) || sid.length > 200) continue;
      const entries = list.filter((e): e is Entry => !!e && typeof e === 'object' && typeof (e as Entry).ref === 'string' && (e as Entry).ref.length <= 200 && typeof (e as Entry).at === 'number');
      if (entries.length) this.map.set(sid, entries.slice(-ACCEPTED_REFS_MAX));
    }
    this.prune();
  }

  add(sessionId: string, ref: string): void {
    const list = (this.map.get(sessionId) ?? []).filter((e) => e.ref !== ref);
    list.push({ ref, at: this.now() });
    this.map.set(sessionId, list.slice(-ACCEPTED_REFS_MAX));
    this.prune();
    this.save();
  }

  /** Taken back: the message was not delivered after all (e.g. a follow-up whose write failed after its turn_started). */
  remove(sessionId: string, ref: string): void {
    const list = this.map.get(sessionId);
    if (!list?.some((e) => e.ref === ref)) return;
    const kept = list.filter((e) => e.ref !== ref);
    if (kept.length) this.map.set(sessionId, kept);
    else this.map.delete(sessionId);
    this.save();
  }

  /**
   * The oldest kept ref's time, when the cap may have pushed older ones out (the list is full; not tracked further, so it
   * holds across a restart): a ref sent before it is not known either way. Undefined while nothing can have been evicted.
   */
  since(sessionId: string): number | undefined {
    const list = this.map.get(sessionId) ?? [];
    if (list.length < ACCEPTED_REFS_MAX) return undefined;
    const cut = this.now() - ACCEPTED_REFS_TTL_MS;
    return list.find((e) => e.at >= cut)?.at;
  }

  has(sessionId: string, ref: string): boolean {
    return this.list(sessionId).includes(ref);
  }

  list(sessionId: string): string[] {
    const cut = this.now() - ACCEPTED_REFS_TTL_MS;
    return (this.map.get(sessionId) ?? []).filter((e) => e.at >= cut).map((e) => e.ref);
  }

  private prune(): void {
    const cut = this.now() - ACCEPTED_REFS_TTL_MS;
    for (const [sid, list] of this.map) {
      const kept = list.filter((e) => e.at >= cut);
      if (kept.length) this.map.set(sid, kept);
      else this.map.delete(sid);
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('deck: accepted-refs 를 저장하지 못했습니다', err instanceof Error ? err.message : err);
    }
  }
}
