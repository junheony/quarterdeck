import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionStore, isPushEndpoint, parseSubscription } from './SubscriptionStore';
import { loadOrCreateVapid } from './vapid';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'deck-push-'));
const sub = (id: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, keys: { p256dh: 'BKey_-1', auth: 'Auth_-1' } });

describe('isPushEndpoint / parseSubscription', () => {
  it('accepts the browsers’ push services over https only', () => {
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(isPushEndpoint('https://web.push.apple.com/QAbc')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isPushEndpoint('https://wns2-by3p.notify.windows.com/w/?token=x')).toBe(true);
    expect(isPushEndpoint('http://fcm.googleapis.com/fcm/send/x')).toBe(false);
    expect(isPushEndpoint('https://127.0.0.1/x')).toBe(false);
    expect(isPushEndpoint('https://evil.example/fcm.googleapis.com')).toBe(false);
    expect(isPushEndpoint('https://googleapis.com.evil.example/x')).toBe(false);
    expect(isPushEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
    expect(isPushEndpoint('https://u:p@fcm.googleapis.com/x')).toBe(false);
    expect(isPushEndpoint(42)).toBe(false);
  });

  it('keeps only endpoint + keys and rejects malformed keys', () => {
    expect(parseSubscription({ ...sub('a'), expirationTime: null, extra: 1 })).toEqual(sub('a'));
    expect(parseSubscription({ endpoint: sub('a').endpoint })).toBeNull();
    expect(parseSubscription({ ...sub('a'), keys: { p256dh: 'has space', auth: 'x' } })).toBeNull();
    expect(parseSubscription(null)).toBeNull();
  });
});

describe('SubscriptionStore', () => {
  it('adds (same endpoint replaces), removes, persists 0600 and reloads', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'cfg', 'subs.json');
    const s = new SubscriptionStore(file);
    await s.load();
    expect(s.list()).toEqual([]);
    await s.add(sub('a'));
    await s.add(sub('b'));
    await s.add({ ...sub('a'), keys: { p256dh: 'New', auth: 'New' } });
    expect(s.list().map((x) => x.endpoint)).toEqual([sub('b').endpoint, sub('a').endpoint]);
    expect(s.list()[1]!.keys.p256dh).toBe('New');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await s.remove(sub('b').endpoint)).toBe(true);
    expect(await s.remove(sub('b').endpoint)).toBe(false);
    const again = new SubscriptionStore(file);
    await again.load();
    expect(again.list()).toEqual([{ ...sub('a'), keys: { p256dh: 'New', auth: 'New' } }]);
    expect(again.has(sub('a').endpoint)).toBe(true);
  });

  it('caps the list (oldest dropped) and drops invalid entries on load', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'subs.json');
    const s = new SubscriptionStore(file, 2);
    for (const id of ['a', 'b', 'c']) await s.add(sub(id));
    expect(s.list().map((x) => x.endpoint.split('/').pop())).toEqual(['b', 'c']);
    await fs.writeFile(file, JSON.stringify([sub('z'), { endpoint: 'https://evil.example/x', keys: { p256dh: 'a', auth: 'b' } }, 'junk']));
    await s.load();
    expect(s.list()).toEqual([sub('z')]);
    await fs.writeFile(file, 'not json');
    await s.load();
    expect(s.list()).toEqual([]);
  });
});

describe('loadOrCreateVapid', () => {
  it('generates once (0600) and reuses the stored pair', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'vapid.json');
    let calls = 0;
    const gen = () => { calls++; return { publicKey: 'PUB_key-1', privateKey: 'PRIV_key-1' }; };
    expect(await loadOrCreateVapid(file, gen)).toEqual({ publicKey: 'PUB_key-1', privateKey: 'PRIV_key-1' });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await loadOrCreateVapid(file, gen)).toEqual({ publicKey: 'PUB_key-1', privateKey: 'PRIV_key-1' });
    expect(calls).toBe(1);
  });

  it('the default generator makes a real P-256 pair', async () => {
    const dir = await tmp();
    const k = await loadOrCreateVapid(path.join(dir, 'v.json'));
    expect(Buffer.from(k.publicKey, 'base64url')).toHaveLength(65);
    expect(Buffer.from(k.privateKey, 'base64url')).toHaveLength(32);
  });
});
