/* ======================================================
 * Clean & Stable Service Worker
 * ====================================================== */

const VERSION = "0.1.5"; // ⚠️ 更新代码时同步修改此版本号
const BUILD_ID = "2026-09-24T05:06:03.314Z"; // Replaced by scripts/update-sw-version.js on every production build
const CACHE_PREFIX = 'closed-community-pwa';
const ASSETS_CACHE = `${CACHE_PREFIX}-assets-${VERSION}-${BUILD_ID}`;
const HTML_CACHE = `${CACHE_PREFIX}-html-${VERSION}-${BUILD_ID}`;
const RUNTIME_STATE_CACHE = `${CACHE_PREFIX}-runtime-state`;
const BADGE_STATE_URL = new URL('/__hainei_badge_state__', self.location.origin).href;

self.addEventListener('install', (event) => {
  console.log('[SW] install', VERSION, BUILD_ID);
  event.waitUntil(
    caches.open(ASSETS_CACHE).then((cache) =>
      cache.addAll([
        '/manifest.json',
        '/icon-192.png',
        '/icon-512.png'
      ])
    )
  );
});

self.addEventListener('activate', (event) => {
  console.log('[SW] activate', VERSION, BUILD_ID);
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) =>
            key.startsWith(CACHE_PREFIX) && 
            key !== ASSETS_CACHE &&
            key !== HTML_CACHE &&
            key !== RUNTIME_STATE_CACHE
          )
          .map((key) => {
            console.log('[SW] Deleting old static cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

async function readStoredBadgeCount() {
  try {
    const cache = await caches.open(RUNTIME_STATE_CACHE);
    const response = await cache.match(BADGE_STATE_URL);
    if (!response) return 0;
    const count = Number(await response.text());
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  } catch {
    return 0;
  }
}

async function writeStoredBadgeCount(count) {
  const normalized = Math.max(0, Math.floor(Number(count) || 0));
  try {
    const cache = await caches.open(RUNTIME_STATE_CACHE);
    await cache.put(BADGE_STATE_URL, new Response(String(normalized), {
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }
    }));
  } catch {}
  return normalized;
}

async function applyAppBadge(count) {
  const normalized = await writeStoredBadgeCount(count);
  try {
    if (normalized > 0) await self.navigator?.setAppBadge?.(normalized);
    else await self.navigator?.clearAppBadge?.();
  } catch {}
  return normalized;
}

let badgeUpdateQueue = Promise.resolve();

function queueBadgeSync(count) {
  badgeUpdateQueue = badgeUpdateQueue
    .catch(() => undefined)
    .then(() => applyAppBadge(count));
  return badgeUpdateQueue;
}

function queueBadgeIncrement() {
  badgeUpdateQueue = badgeUpdateQueue
    .catch(() => undefined)
    .then(async () => {
      const current = await readStoredBadgeCount();
      return applyAppBadge(current + 1);
    });
  return badgeUpdateQueue;
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (event.data?.type === 'SYNC_APP_BADGE') {
    event.waitUntil(queueBadgeSync(event.data.count));
  }
});

// Fetch 拦截：确保不缓存 API 请求
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 如果是 API 请求或非 GET 请求，直接跳过缓存
  if (url.pathname.includes('/api/') || request.method !== 'GET') {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(HTML_CACHE).then((cache) => {
            cache.put(request, copy);
          });
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Same-origin build assets use stale-while-revalidate: return cached bytes
  // immediately, then refresh in the background for the next navigation.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(ASSETS_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request).then((response) => {
          if (response?.ok && response.type === 'basic') {
            event.waitUntil(cache.put(request, response.clone()));
          }
          return response;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Do not persist third-party/media responses in the app-shell cache.
  event.respondWith(fetch(request));
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = JSON.parse(event.data?.text() || '{}'); } catch {}
  event.waitUntil(Promise.all([
    self.registration.showNotification('HaiNei', {
      body: '你有新的私信消息',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { type: 'message' }
    }),
    payload?.type === 'message' ? queueBadgeIncrement() : Promise.resolve()
  ]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = '/#/conversations';
  const target = new URL(path, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows[0]) {
      await windows[0].navigate(target);
      return windows[0].focus();
    }
    return self.clients.openWindow(target);
  })());
});
