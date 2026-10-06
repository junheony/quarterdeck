import fs from 'node:fs/promises';
import path from 'node:path';
import webpush from 'web-push';

export type VapidKeys = { publicKey: string; privateKey: string };

const B64URL = /^[A-Za-z0-9_-]+$/;

/** Web Push: one VAPID keypair per deck install (`vapid.json`, 0600). Generated once; the private key is never logged or sent. */
export async function loadOrCreateVapid(file: string, generate: () => VapidKeys = () => webpush.generateVAPIDKeys()): Promise<VapidKeys> {
  try {
    const r = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<VapidKeys>;
    if (typeof r.publicKey === 'string' && typeof r.privateKey === 'string' && B64URL.test(r.publicKey) && B64URL.test(r.privateKey)) {
      await fs.chmod(file, 0o600).catch(() => {});
      return { publicKey: r.publicKey, privateKey: r.privateKey };
    }
  } catch {
    // missing or corrupt: create below
  }
  const keys = generate();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ publicKey: keys.publicKey, privateKey: keys.privateKey }), { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600);
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
}
