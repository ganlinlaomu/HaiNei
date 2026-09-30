/* ======================================================
 * Clean & Stable Service Worker
 * ====================================================== */

const VERSION = "0.1.5"; // ⚠️ 更新代码时同步修改此版本号
const BUILD_ID = "2026-09-30T14:03:38.501Z"; // Replaced by scripts/update-sw-version.js on every production build
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

function queueBadgeSync(count, scope) {
  badgeUpdateQueue = badgeUpdateQueue
    .catch(() => undefined)
    .then(async () => {
      await setBadgeScope(scope);
      return applyAppBadge(count);
    });
  return badgeUpdateQueue;
}

async function scopedPushHint(payload) {
  const cache = await caches.open(RUNTIME_STATE_CACHE);
  const stateUrl = new URL('/__hainei_push_state__', self.location.origin).href;
  let state = {};
  try { state = await (await cache.match(stateUrl))?.json() || {}; } catch {}
  if (!payload.notificationId || !payload.accountScope) return false;

  // A fresh/recreated service worker can receive a valid push before the app has
  // had a chance to post SYNC_APP_BADGE. Bootstrap that missing scope from the
  // recipient-bound push itself. Once a scope has been explicitly stored
  // (including the empty logged-out scope), mismatched accounts stay suppressed.
  const hasStoredScope = Object.prototype.hasOwnProperty.call(state, 'scope');
  if (hasStoredScope && state.scope !== payload.accountScope) return false;

  const seen = Array.isArray(state.seen) ? state.seen : [];
  if (seen.includes(payload.notificationId)) return false;
  state = {
    ...state,
    scope: hasStoredScope ? state.scope : payload.accountScope,
    seen: [...seen, payload.notificationId].slice(-256)
  };
  return async () => {
    // Only acknowledge notifications that the browser actually displayed.
    await cache.put(stateUrl, new Response(JSON.stringify(state)));
    const windows = await self.clients.matchAll({type:'window',includeUncontrolled:true});
    if (!windows.some(client => client.visibilityState === 'visible')) {
      // Push runs before Relay/IndexedDB catch-up, so this is only a provisional
      // numeric hint. The foreground app later replaces it with durable unread.
      const current = await readStoredBadgeCount();
      await applyAppBadge(current + 1);
    }
  };
}
async function setBadgeScope(scope) {
  const cache = await caches.open(RUNTIME_STATE_CACHE);
  const url = new URL('/__hainei_push_state__', self.location.origin).href;
  let state = {};
  try { state = await (await cache.match(url))?.json() || {}; } catch {}
  if (state.scope !== scope) await cache.put(url,new Response(JSON.stringify({scope,seen:[]})));
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'GET_BUILD_INFO') {
    event.ports?.[0]?.postMessage({
      type: 'BUILD_INFO',
      version: VERSION,
      buildId: BUILD_ID
    });
    return;
  }
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (event.data?.type === 'SYNC_APP_BADGE') {
    event.waitUntil(queueBadgeSync(event.data.count, event.data.accountScope || ""));
    return;
  }
  if (event.data?.type === 'SYNC_APP_BADGE_SCOPE') {
    event.waitUntil(setBadgeScope(event.data.accountScope || ""));
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
  event.waitUntil((async () => {
    badgeUpdateQueue = badgeUpdateQueue.catch(() => undefined).then(async () => {
      const acknowledge = await scopedPushHint(payload);
      if (!acknowledge) return;
      await self.registration.showNotification('HaiNei', {
        body:'你有新的私信消息', icon:'/icon-192.png', badge:'/icon-192.png',
        tag: payload.notificationId, data:{type:'message'}
      });
      await acknowledge();
    });
    await badgeUpdateQueue;
  })());
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
