/* ======================================================
 * Clean & Stable Service Worker
 * ====================================================== */

const VERSION = "0.1.119"; // ⚠️ 更新代码时同步修改此版本号
const BUILD_ID = "source-08655ebf22d057a4"; // Replaced by scripts/update-sw-version.js on every production build
const CACHE_PREFIX = 'closed-community-pwa';
const ASSETS_CACHE = `${CACHE_PREFIX}-assets-${VERSION}-${BUILD_ID}`;
const HTML_CACHE = `${CACHE_PREFIX}-html-${VERSION}-${BUILD_ID}`;
const RUNTIME_STATE_CACHE = `${CACHE_PREFIX}-runtime-state`;
const BADGE_STATE_URL = new URL('/__hainei_badge_state__', self.location.origin).href;
const PUSH_INBOX_URL = new URL('/__hainei_push_inbox__', self.location.origin).href;
const PUSH_HINT_TTL_MS = 24 * 60 * 60 * 1000;
const PUSH_HINT_MAX_ITEMS = 32;
// One replaceable DM notification instead of one per message.
const DM_NOTIFICATION_TAG = 'hainei-dm';
const CALL_NOTIFICATION_TAG = 'hainei-call';
// Lie-fi (signal but no throughput) must not hold the app shell hostage.
// Every built JS/CSS chunk, so lazily loaded pages open offline too.
const PRECACHE_ASSETS = []; // filled in by build-plugins/swPrecache.ts

self.addEventListener('install', (event) => {
  console.log('[SW] install', VERSION, BUILD_ID);
  event.waitUntil(
    caches.open(ASSETS_CACHE).then(async (cache) => {
      await cache.addAll([
        '/manifest.json',
        '/icon-192.png',
        '/icon-512.png'
      ]);
      // /assets/ names carry a content hash: a file with the same name in an
      // earlier build's cache is byte-identical, so reuse it instead of
      // downloading the whole app again on every update.
      const precache = async (url) => {
        const previous = await caches.match(url).catch(() => undefined);
        if (previous) return cache.put(url, previous);
        return cache.add(url);
      };
      // One unreachable chunk must not abort the install; it is fetched on demand.
      const results = await Promise.allSettled(PRECACHE_ASSETS.map(precache));
      const failed = results.filter((result) => result.status === 'rejected').length;
      console.log('[SW] precached', PRECACHE_ASSETS.length - failed, '/', PRECACHE_ASSETS.length);
    })
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

async function closeDmNotifications() {
  try {
    const notifications = await self.registration?.getNotifications?.({ tag: DM_NOTIFICATION_TAG }) || [];
    for (const notification of notifications) notification.close();
  } catch {}
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
async function loadEncryptedPushInbox() {
  const cache = await caches.open(RUNTIME_STATE_CACHE);
  let stored = {};
  try { stored = await (await cache.match(PUSH_INBOX_URL))?.json() || {}; } catch {}
  return { cache, scope: stored.scope || "", entries: Array.isArray(stored.entries) ? stored.entries : [] };
}
function keepFreshHints(entries) {
  return entries.filter(item =>
    item && typeof item.id === "string" && /^[a-f0-9]{64}$/i.test(item.id)
    && item.hint && typeof item.hint.eventId === "string"
    && /^[a-f0-9]{64}$/i.test(item.hint.eventId)
    && Number.isFinite(item.at) && Date.now() - item.at < PUSH_HINT_TTL_MS
    && item.at <= Date.now() + 60_000
  ).slice(-PUSH_HINT_MAX_ITEMS);
}
async function saveEncryptedPushInbox(cache, scope, entries) {
  await cache.put(PUSH_INBOX_URL, new Response(JSON.stringify({ scope, entries: keepFreshHints(entries) })));
}
async function cacheEncryptedPushHint(payload) {
  if (!payload?.hint || !/^[a-f0-9]{64}$/i.test(payload?.accountScope || "")
    || !/^[a-f0-9]{64}$/i.test(payload?.notificationId || "")
    || !/^[a-f0-9]{64}$/i.test(payload.hint.eventId || "")) return;
  const hint = payload.hint;
  const relays = Array.isArray(hint.relays) ? hint.relays
    .filter(url => typeof url === "string" && /^wss:\/\/[^/@]+/i.test(url) && url.length <= 250).slice(0, 2) : [];
  // Only opaque ciphertext is retained. Never decode NIP-17 in the worker.
  const encrypted = hint.event && typeof hint.event === "object"
    && hint.event.id === hint.eventId && hint.event.kind === 1059
    && JSON.stringify(hint.event).length <= 8_000 ? hint.event : undefined;
  if (!encrypted && !relays.length) return;
  const { cache, scope, entries } = await loadEncryptedPushInbox();
  const sameScope = scope === payload.accountScope;
  const current = sameScope ? keepFreshHints(entries) : [];
  const updated = current.filter(item => item.id !== payload.notificationId);
  updated.push({ id: payload.notificationId, hint: { eventId: hint.eventId, relays, ...(encrypted ? { event: encrypted } : {}) }, at: Date.now() });
  await saveEncryptedPushInbox(cache, payload.accountScope, updated);
}
async function handleEncryptedPushInboxMessage(data, port) {
  const accountScope = typeof data?.accountScope === "string" ? data.accountScope : "";
  if (!/^[a-f0-9]{64}$/i.test(accountScope)) {
    port?.postMessage({ entries: [] });
    return;
  }
  const { cache, scope, entries } = await loadEncryptedPushInbox();
  if (scope !== accountScope) {
    port?.postMessage({ entries: [] });
    return;
  }
  const fresh = keepFreshHints(entries);
  if (data.type === "ACK_ENCRYPTED_PUSH_HINTS") {
    const accepted = new Set((Array.isArray(data.ids) ? data.ids : []).filter(id => typeof id === "string").slice(0, PUSH_HINT_MAX_ITEMS));
    await saveEncryptedPushInbox(cache, scope, fresh.filter(item => !accepted.has(item.id)));
    port?.postMessage({ ok: true });
  } else {
    await saveEncryptedPushInbox(cache, scope, fresh);
    port?.postMessage({ entries: fresh });
  }
}

async function setBadgeScope(scope) {
  const cache = await caches.open(RUNTIME_STATE_CACHE);
  const url = new URL('/__hainei_push_state__', self.location.origin).href;
  let state = {};
  try { state = await (await cache.match(url))?.json() || {}; } catch {}
  if (state.scope !== scope) {
    await cache.put(url,new Response(JSON.stringify({scope,seen:[]})));
    // Do not keep another account's encrypted hints after logout/switch.
    const inbox = await loadEncryptedPushInbox();
    await saveEncryptedPushInbox(inbox.cache, scope, []);
  }
}

// Call notification fallback belongs to a single verified incoming call.
// The push itself contains encrypted NIP-17 data, not a plaintext callId;
// this state comes exclusively from the visible call engine. A short TTL
// prevents a stale fallback from affecting an unrelated subsequent push.
let visibleIncomingCallId = null;
let blockedIncomingCallId = null;
let blockedIncomingUntil = 0;
let callAlertRevision = 0;
const BLOCKED_RING_TTL_MS = 45_000;
function validCallId(id) {
  return typeof id === 'string' && /^[a-f0-9]{32}$/i.test(id);
}
function hasBlockedVisibleRing() {
  return !!visibleIncomingCallId
    && blockedIncomingCallId === visibleIncomingCallId
    && Date.now() < blockedIncomingUntil;
}
async function closeCallAlertsIfCurrent(revision, callId, includeOldCalls = false) {
  try {
    const alerts = await self.registration.getNotifications({ tag: CALL_NOTIFICATION_TAG });
    if (revision !== callAlertRevision || hasBlockedVisibleRing()) return;
    for (const notification of alerts) {
      // Leave an alert from a different/current call alone.
      if (!includeOldCalls && notification.data?.callId && notification.data.callId !== callId) continue;
      notification.close();
    }
  } catch { /* notifications unavailable */ }
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
  const type = event.data?.type;
  if (type === 'INCOMING_RINGTONE_START') {
    const id = event.data?.callId;
    if (!validCallId(id)) return;
    visibleIncomingCallId = id;
    blockedIncomingCallId = null;
    blockedIncomingUntil = 0;
    const revision = ++callAlertRevision;
    // This is the new visible call; clear any leftover alert from an older call.
    event.waitUntil(closeCallAlertsIfCurrent(revision, id, true));
    return;
  }
  if (type === 'INCOMING_RINGTONE_BLOCKED') {
    const id = event.data?.callId;
    if (!validCallId(id) || (visibleIncomingCallId && visibleIncomingCallId !== id)) return;
    visibleIncomingCallId = id; // Recover after service-worker restart.
    blockedIncomingCallId = id;
    blockedIncomingUntil = Date.now() + BLOCKED_RING_TTL_MS;
    const revision = ++callAlertRevision;
    // iOS may deny both the ringtone and the OS notification depending on
    // permission/focus settings. This is best-effort, not a VoIP entitlement.
    event.waitUntil((async () => {
      try {
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (!clients.some(client => client.visibilityState === 'visible')) return;
        if (self.Notification && self.Notification.permission !== 'granted') return;
        if (revision !== callAlertRevision || !hasBlockedVisibleRing()) return;
        await self.registration.showNotification('HaiNei', {
          body: '你有一个语音来电', icon: '/icon-192.png', badge: '/icon-192.png',
          tag: CALL_NOTIFICATION_TAG, data: { type: 'call', callId: id },
          requireInteraction: true, renotify: true
        });
        // A late async notification creation must not revive a finished call.
        if (revision !== callAlertRevision) {
          try {
            const alerts = await self.registration.getNotifications({ tag: CALL_NOTIFICATION_TAG });
            for (const alert of alerts) if (alert.data?.callId === id) alert.close();
          } catch {}
        }
      } catch { /* notification permission or platform policy denied */ }
    })());
    return;
  }
  if (type === 'INCOMING_RINGTONE_PLAYING' || type === 'CLOSE_CALL_NOTIFICATION') {
    const id = event.data?.callId;
    if (!validCallId(id) || (visibleIncomingCallId && visibleIncomingCallId !== id)) return;
    // A stale END for an old call must not cancel a newer blocked ringtone.
    blockedIncomingCallId = null;
    blockedIncomingUntil = 0;
    if (type === 'CLOSE_CALL_NOTIFICATION') visibleIncomingCallId = null;
    const revision = ++callAlertRevision;
    event.waitUntil(closeCallAlertsIfCurrent(revision, id));
    return;
  }
  if (event.data?.type === 'SYNC_APP_BADGE') {
    // Close inside the same queue so a push queued right after this sync
    // cannot have its fresh notification closed.
    badgeUpdateQueue = queueBadgeSync(event.data.count, event.data.accountScope || "").then(async count => {
      // The foreground app read everything: the DM notification is stale.
      if (count === 0) await closeDmNotifications();
      return count;
    });
    event.waitUntil(badgeUpdateQueue);
    return;
  }
  if (event.data?.type === 'SYNC_APP_BADGE_SCOPE') {
    badgeUpdateQueue = badgeUpdateQueue.catch(() => undefined)
      .then(() => setBadgeScope(event.data.accountScope || ""));
    event.waitUntil(badgeUpdateQueue);
    return;
  }
  if (event.data?.type === 'GET_ENCRYPTED_PUSH_HINTS' || event.data?.type === 'ACK_ENCRYPTED_PUSH_HINTS') {
    const port = event.ports?.[0];
    if (!port) return;
    badgeUpdateQueue = badgeUpdateQueue.catch(() => undefined)
      .then(() => handleEncryptedPushInboxMessage(event.data, port))
      .catch(() => port.postMessage({ entries: [] }));
    event.waitUntil(badgeUpdateQueue);
    return;
  }
});

// Cache first for pages: a cached shell opens instantly even on a slow
// network, while the network copy refreshes the cache for the next launch.
// HTML_CACHE is versioned with this build, so a cached page always matches
// the assets this worker precached; new builds arrive via the update flow.
async function navigationResponse(event, request) {
  let storeCopy = Promise.resolve();
  const network = fetch(request).then((response) => {
    // Only a real page may replace the cached shell, never a 404/500.
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      storeCopy = caches.open(HTML_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return response;
  });
  // Registered now, while the event is active; it may outlive respondWith.
  event.waitUntil(network.then(() => storeCopy, () => {}));

  const cached = await caches.open(HTML_CACHE).then((cache) => cache.match(request)).catch(() => undefined);
  return cached || network;
}

// Fetch 拦截：确保不缓存 API 请求
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 如果是 API 请求或非 GET 请求，直接跳过缓存
  if (url.pathname.includes('/api/') || request.method !== 'GET') {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(event, request));
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
      let acknowledge;
      try {
        acknowledge = await scopedPushHint(payload);
      } catch {
        // Unreadable push state (CacheStorage failure) must not drop the push
        // silently: WebKit revokes subscriptions whose pushes show nothing.
        acknowledge = async () => {};
      }
      if (!acknowledge) return;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const appVisible = windows.some(client => client.visibilityState === 'visible');
      // Every push must still display a notification: WebKit revokes the
      // subscription for silent pushes. While the app is on screen it shows
      // its own unread state, so stay quiet; otherwise re-alert on replace.
      // A call keeps its own notification and stays until acted on; the
      // encrypted invite in the hint tells the app who is calling.
      const isCall = payload.type === 'call';
      const tag = isCall ? CALL_NOTIFICATION_TAG : DM_NOTIFICATION_TAG;
      const blockedCallAlert = isCall && appVisible && hasBlockedVisibleRing();
      await self.registration.showNotification('HaiNei', {
        body: isCall ? '你有一个语音来电' : '你有新的私信消息', icon:'/icon-192.png', badge:'/icon-192.png',
        tag, data:{type: isCall ? 'call' : 'message', ...(blockedCallAlert ? { callId: blockedIncomingCallId } : {})},
        ...(appVisible && !blockedCallAlert ? { silent: true } : isCall ? { requireInteraction: true, renotify: true } : { renotify: true })
      });
      // WebKit requires every push to show a notification, but while the app
      // is on screen it shows its own call banner / unread state: withdraw the
      // system one at once instead of covering the app with it.
      if (appVisible && !(isCall && hasBlockedVisibleRing())) {
        try {
          for (const notification of await self.registration.getNotifications({ tag })) notification.close();
        } catch {}
      }
      // Notification delivery must survive CacheStorage quota failures.
      try { await cacheEncryptedPushHint(payload); } catch {}
      await acknowledge();
      if (payload.hint) {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of windows) {
          if (client.visibilityState === 'visible') client.postMessage({ type: 'ENCRYPTED_PUSH_HINT_AVAILABLE' });
        }
      }
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
    const client = windows.find(item => item.focused)
      || windows.find(item => item.visibilityState === 'visible')
      || windows[0];
    if (client) {
      try {
        const navigated = await client.navigate(target);
        return (navigated || client).focus();
      } catch {
        // navigate() rejects for clients this worker does not control.
      }
    }
    return self.clients.openWindow(target);
  })());
});
