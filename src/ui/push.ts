import type { DesktopSession, ProjectEntry } from '../shared/session-types';

/**
 * Why notifications can't be turned on here (null = they can):
 * - 'insecure': plain http over the tailnet — service workers need https (or localhost).
 * - 'ios-install': iPhone/iPad Safari tab — Web Push only exists in a home-screen app (iOS 16.4+).
 * - 'unsupported': no service worker / Push API at all.
 */
export type PushBlocker = 'insecure' | 'ios-install' | 'unsupported' | null;

export function isIos(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> = navigator): boolean {
  // iPadOS reports a Mac user agent; touch points give it away.
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1);
}

export function isStandalone(win: Window = window): boolean {
  return win.matchMedia?.('(display-mode: standalone)').matches === true || (win.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function pushBlocker(win: Window = window): PushBlocker {
  if (!win.isSecureContext) return 'insecure';
  const supported = 'serviceWorker' in win.navigator && 'PushManager' in win && 'Notification' in win;
  if (isIos(win.navigator) && !isStandalone(win)) return 'ios-install';
  return supported ? null : 'unsupported';
}

/** VAPID public key (base64url) → the bytes PushManager.subscribe wants. */
export function urlB64ToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A notification click names a session; this finds what opening it needs (listed sessions first, then Desktop ones). */
export function findSession(projects: ProjectEntry[], desktop: DesktopSession[], sessionId: string): { cwd: string; title: string } | null {
  for (const p of projects) {
    const s = p.sessions.find((x) => x.sessionId === sessionId);
    if (s) return { cwd: s.cwd, title: s.title };
  }
  const d = desktop.find((x) => x.sessionId === sessionId);
  return d ? { cwd: d.cwd, title: d.title } : null;
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function errorOf(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `${fallback} (${res.status})`);
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready);
}

/** This browser's subscription, if it has one the server also knows. */
export async function pushEnabled(): Promise<boolean> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub || Notification.permission !== 'granted') return false;
  const res = await post('/api/push/status', { endpoint: sub.endpoint });
  return res.ok && ((await res.json()) as { subscribed?: boolean }).subscribed === true;
}

export async function enablePush(): Promise<void> {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? '알림이 차단돼 있습니다 — 브라우저/시스템 설정에서 허용하세요' : '알림 권한을 받지 못했습니다');
  const keyRes = await fetch('/api/push/key', { credentials: 'same-origin' });
  if (!keyRes.ok) throw await errorOf(keyRes, '알림 키를 받지 못했습니다');
  const { publicKey } = (await keyRes.json()) as { publicKey: string };
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key can't be reused.
  const key = sub?.options.applicationServerKey;
  if (sub && key && btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== publicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(publicKey) });
  const res = await post('/api/push/subscribe', { subscription: sub.toJSON() });
  if (!res.ok) throw await errorOf(res, '알림 구독 실패');
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe();
}

export async function testPush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) throw new Error('이 기기는 알림이 꺼져 있습니다');
  const res = await post('/api/push/test', { endpoint: sub.endpoint });
  if (!res.ok) throw await errorOf(res, '테스트 알림 실패');
}
