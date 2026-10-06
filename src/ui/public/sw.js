/* deck service worker: offline shell for the built assets + Web Push notifications.
 * Never caches /api/* or /ws — only same-origin GETs of the app shell, hashed assets, icons, manifest. */
const CACHE = 'deck-shell-v1';
const MAX_ASSETS = 80;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

function isShellAsset(url) {
  return url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest';
}

async function trim(cache) {
  const keys = await cache.keys();
  for (const req of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(req);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/sw.js') return;

  if (req.mode === 'navigate') {
    // Network first; offline → the last shell we saw (index.html is the same document for every path).
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
          const cache = await caches.open(CACHE);
          await cache.put('/', res.clone());
        }
        return res;
      } catch {
        const cached = await caches.match('/');
        return cached || new Response('deck: 오프라인입니다', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  if (isShellAsset(url)) {
    // Hashed build assets never change under the same name: cache first.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) {
        await cache.put(req, res.clone());
        await trim(cache);
      }
      return res;
    })());
  }
});

// ---- Web Push ----

self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch { p = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Someone is looking at deck right now: the card/result is already on screen. iOS revokes push
    // permission for pushes that show nothing, so there it is always shown.
    const ios = /iPhone|iPad|iPod/.test(self.navigator.userAgent);
    if (!ios && p.kind !== 'test' && wins.some((w) => w.focused && w.visibilityState === 'visible')) return;
    await self.registration.showNotification(p.title || 'deck', {
      body: p.body || '',
      tag: p.tag || undefined,
      renotify: !!p.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { sessionId: p.sessionId || null },
      requireInteraction: p.kind === 'permission' || p.kind === 'question',
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = (event.notification.data && event.notification.data.sessionId) || null;
  const target = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      if (sessionId) win.postMessage({ type: 'deck-open-session', sessionId });
      await win.focus();
      return;
    }
    await self.clients.openWindow(target);
  })());
});
