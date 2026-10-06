import fs from 'node:fs/promises';
import path from 'node:path';

export type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } };

export const MAX_SUBSCRIPTIONS = 20;

/**
 * Only the browsers' own push services: deck POSTs to the endpoint, so an arbitrary URL would turn
 * the subscribe call into a request-anywhere primitive.
 */
const PUSH_HOST_SUFFIXES = ['.googleapis.com', '.mozilla.com', '.mozaws.net', '.push.apple.com', '.notify.windows.com'];

export function isPushEndpoint(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 2048) return false;
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

const B64URL = /^[A-Za-z0-9_-]+=*$/;

/** A browser PushSubscription.toJSON() reduced to what sending needs; anything else → null. */
export function parseSubscription(v: unknown): PushSub | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const p256dh = r.keys?.p256dh;
  const auth = r.keys?.auth;
  if (!isPushEndpoint(r.endpoint)) return null;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 64 || !B64URL.test(p256dh) || !B64URL.test(auth)) return null;
  return { endpoint: r.endpoint, keys: { p256dh, auth } };
}

/** Web Push subscriptions (`push-subscriptions.json`, 0600), one per browser/device, newest last. */
export class SubscriptionStore {
  private subs: PushSub[] = [];
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly max = MAX_SUBSCRIPTIONS) {}

  async load(): Promise<void> {
    let parsed: unknown;
    try { parsed = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { parsed = []; }
    this.subs = (Array.isArray(parsed) ? parsed : []).map(parseSubscription).filter((s): s is PushSub => s !== null).slice(-this.max);
  }

  list(): PushSub[] {
    return this.subs;
  }

  has(endpoint: string): boolean {
    return this.subs.some((s) => s.endpoint === endpoint);
  }

  /** Same endpoint = same device: its keys are replaced. Over the cap the oldest goes. */
  async add(sub: PushSub): Promise<void> {
    this.subs = [...this.subs.filter((s) => s.endpoint !== sub.endpoint), sub].slice(-this.max);
    await this.save();
  }

  async remove(endpoint: string): Promise<boolean> {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length === before) return false;
    await this.save();
    return true;
  }

  private async save(): Promise<void> {
    const snapshot = this.subs;
    this.writing = this.writing.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
      await fs.rename(tmp, this.file);
      await fs.chmod(this.file, 0o600);
    });
    await this.writing;
  }
}
