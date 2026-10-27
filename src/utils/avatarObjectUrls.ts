import { onBeforeAccountLock } from "@/services/accountLifecycle";

// A remounted ProfileAvatar (e.g. the Calls tab, which is not kept alive)
// used to show its initial for a few frames while the decrypted image was
// read back from IndexedDB, then fade in: a visible flash on every visit.
// Keep the object URLs of avatars already shown so a new instance can paint
// the image on its first frame. Shared by all instances; revoked on lock.
const MAX_AVATAR_OBJECT_URLS = 300;
const urls = new Map<string, string>();
const urlKey = (account: string, reference: string) => `${account.toLowerCase()}:${reference}`;

export function cachedAvatarObjectUrl(account: string, reference: string) {
  const key = urlKey(account, reference);
  const url = urls.get(key);
  if (!url) return "";
  // Refresh recency so frequently shown avatars are not evicted.
  urls.delete(key);
  urls.set(key, url);
  return url;
}

export function rememberAvatarObjectUrl(account: string, reference: string, blob: Blob) {
  const key = urlKey(account, reference);
  const existing = urls.get(key);
  if (existing) return existing;
  const url = URL.createObjectURL(blob);
  urls.set(key, url);
  while (urls.size > MAX_AVATAR_OBJECT_URLS) {
    const [oldestKey, oldestUrl] = urls.entries().next().value as [string, string];
    urls.delete(oldestKey);
    URL.revokeObjectURL(oldestUrl);
  }
  return url;
}

/** Drop an entry whose image failed to render, so the next mount reloads it. */
export function forgetAvatarObjectUrl(account: string, reference: string, url: string) {
  const key = urlKey(account, reference);
  if (urls.get(key) !== url) return;
  urls.delete(key);
  URL.revokeObjectURL(url);
}

export function clearAvatarObjectUrls() {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
}

const stopLockClear = onBeforeAccountLock(() => { clearAvatarObjectUrls(); });
if (import.meta.hot) import.meta.hot.dispose(stopLockClear);
