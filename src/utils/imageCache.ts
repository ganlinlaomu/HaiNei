import { imageCacheRepository } from "@/repositories/imageCacheRepository";
import {
  isLocalVaultUnlocked,
  openLocalVaultBytes,
  sealLocalVaultBytes,
} from "@/services/localVault";
import { onBeforeAccountLock } from "@/services/accountLifecycle";
import { logger } from "@/utils/logger";

export const IMAGE_MEMORY_CACHE_MAX_BYTES = 48 * 1024 * 1024;
export const IMAGE_PERSISTENT_CACHE_MAX_BYTES = 256 * 1024 * 1024;

type MemoryImageEntry = {
  blob: Blob;
  mime: string;
  timestamp: number;
  lastAccess: number;
};

const memoryByAccount = new Map<string, Map<string, MemoryImageEntry>>();
const bytesByAccount = new Map<string, number>();
const persistentWriteFlights = new Map<string, Promise<void>>();

function accountKey(accountPubkey: string) {
  return accountPubkey.toLowerCase();
}

function accountCache(accountPubkey: string) {
  const account = accountKey(accountPubkey);
  let cache = memoryByAccount.get(account);
  if (!cache) {
    cache = new Map();
    memoryByAccount.set(account, cache);
    bytesByAccount.set(account, 0);
  }
  return { account, cache };
}

function evictToLimit(account: string, cache: Map<string, MemoryImageEntry>) {
  let total = bytesByAccount.get(account) || 0;
  while (total > IMAGE_MEMORY_CACHE_MAX_BYTES && cache.size) {
    let oldestKey = "";
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [key, entry] of cache) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = key;
      }
    }
    const evicted = cache.get(oldestKey);
    if (!evicted) break;
    cache.delete(oldestKey);
    total -= evicted.blob.size;
  }
  bytesByAccount.set(account, Math.max(0, total));
}

function storeMemoryImage(
  accountPubkey: string,
  url: string,
  blob: Blob,
  mime: string,
) {
  const { account, cache } = accountCache(accountPubkey);
  const previous = cache.get(url);
  let total = bytesByAccount.get(account) || 0;
  if (previous) total -= previous.blob.size;
  const now = Date.now();
  cache.set(url, { blob, mime, timestamp: now, lastAccess: now });
  bytesByAccount.set(account, total + blob.size);
  evictToLimit(account, cache);
}

async function cacheIdForReference(reference: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(reference),
  );
  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function persistentFlightKey(account: string, cacheId: string) {
  return `${account}:${cacheId}`;
}

async function persistEncryptedImage(
  accountPubkey: string,
  reference: string,
  blob: Blob,
  mime: string,
) {
  const account = accountKey(accountPubkey);
  if (
    !isLocalVaultUnlocked(account) ||
    !blob.size ||
    blob.size > IMAGE_PERSISTENT_CACHE_MAX_BYTES
  ) return;

  const cacheId = await cacheIdForReference(reference);
  const flightKey = persistentFlightKey(account, cacheId);
  const running = persistentWriteFlights.get(flightKey);
  if (running) return running;

  const write = (async () => {
    const plainBytes = await blob.arrayBuffer();
    const sealed = await sealLocalVaultBytes(
      account,
      "media-cache",
      cacheId,
      mime,
      plainBytes,
    );
    new Uint8Array(plainBytes).fill(0);
    const now = Date.now();
    await imageCacheRepository.put(account, {
      cacheId,
      sealedBytes: sealed.bytes,
      iv: sealed.iv,
      mime,
      size: blob.size,
      timestamp: now,
      lastAccess: now,
      version: 1,
    });
    await imageCacheRepository.trimToBytes(
      account,
      IMAGE_PERSISTENT_CACHE_MAX_BYTES,
    );
  })().catch(error => {
    if (isLocalVaultUnlocked(account)) {
      logger.warn("Failed to persist encrypted image cache", error);
    }
  }).finally(() => {
    if (persistentWriteFlights.get(flightKey) === write) {
      persistentWriteFlights.delete(flightKey);
    }
  });

  persistentWriteFlights.set(flightKey, write);
  return write;
}

export async function flushImageCacheWrites(accountPubkey?: string) {
  const prefix = accountPubkey ? `${accountKey(accountPubkey)}:` : "";
  const pending = [...persistentWriteFlights.entries()]
    .filter(([key]) => !prefix || key.startsWith(prefix))
    .map(([, promise]) => promise);
  await Promise.allSettled(pending);
}

export async function storeImageInCache(
  accountPubkey: string,
  url: string,
  blob: Blob,
  mime: string
): Promise<void> {
  if (!accountPubkey || !url || !blob?.size) return;
  storeMemoryImage(accountPubkey, url, blob, mime);
  void persistEncryptedImage(accountPubkey, url, blob, mime);
}

export async function getImageFromCache(
  accountPubkey: string,
  url: string
): Promise<{ blob: Blob; mime: string } | null> {
  const account = accountKey(accountPubkey);
  const cache = memoryByAccount.get(account);
  const entry = cache?.get(url);
  if (entry) {
    entry.lastAccess = Date.now();
    cache!.delete(url);
    cache!.set(url, entry);
    return { blob: entry.blob, mime: entry.mime };
  }

  if (!account || !url || !isLocalVaultUnlocked(account)) return null;

  const cacheId = await cacheIdForReference(url);
  const persisted = await imageCacheRepository.get(account, cacheId);
  if (!persisted || persisted.version !== 1) return null;

  try {
    const plainBytes = await openLocalVaultBytes(
      account,
      "media-cache",
      cacheId,
      persisted.mime,
      persisted.size,
      persisted.iv,
      persisted.sealedBytes,
    );
    if (plainBytes.byteLength !== persisted.size) {
      new Uint8Array(plainBytes).fill(0);
      throw new Error("media_cache_size_mismatch");
    }
    const blob = new Blob([plainBytes], { type: persisted.mime });
    new Uint8Array(plainBytes).fill(0);
    storeMemoryImage(account, url, blob, persisted.mime);
    void imageCacheRepository.touch(account, cacheId).catch(() => undefined);
    return { blob, mime: persisted.mime };
  } catch (error) {
    if (isLocalVaultUnlocked(account)) {
      void imageCacheRepository.delete(account, cacheId).catch(() => undefined);
      logger.warn("Discarded unreadable encrypted image cache entry", error);
    }
    return null;
  }
}

export function clearMemoryImageCache(accountPubkey?: string) {
  if (!accountPubkey) {
    memoryByAccount.clear();
    bytesByAccount.clear();
    return;
  }
  const account = accountKey(accountPubkey);
  memoryByAccount.delete(account);
  bytesByAccount.delete(account);
}

export async function clearExpiredCache(accountPubkey: string): Promise<number> {
  // L2 is size-bounded rather than age-expiring. This startup maintenance only
  // enforces the configured disk limit and never removes a healthy cache by age.
  try {
    return await imageCacheRepository.trimToBytes(
      accountPubkey,
      IMAGE_PERSISTENT_CACHE_MAX_BYTES,
    );
  } catch (e) {
    logger.warn("Failed to trim encrypted image cache", e);
    return 0;
  }
}

export async function clearAllCache(accountPubkey: string): Promise<void> {
  await flushImageCacheWrites(accountPubkey);
  clearMemoryImageCache(accountPubkey);
  try {
    await imageCacheRepository.clear(accountPubkey);
    logger.info(`Cleared image cache for account=${accountPubkey.slice(0, 8)}`);
  } catch (e) {
    logger.warn("Failed to clear encrypted image cache", e);
  }
}

export async function getCacheStats(accountPubkey: string): Promise<{
  count: number;
  size: number;
  oldestTimestamp: number;
  persistentCount: number;
  persistentSize: number;
  persistentOldestTimestamp: number;
}> {
  const cache = memoryByAccount.get(accountKey(accountPubkey));
  let size = 0;
  let oldestTimestamp = 0;
  if (cache?.size) {
    for (const entry of cache.values()) {
      size += entry.blob.size;
      if (!oldestTimestamp || entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
      }
    }
  }
  const persistent = await imageCacheRepository.getStats(accountPubkey);
  return {
    count: cache?.size || 0,
    size,
    oldestTimestamp,
    persistentCount: persistent.count,
    persistentSize: persistent.size,
    persistentOldestTimestamp: persistent.oldestTimestamp,
  };
}

onBeforeAccountLock(async account => {
  await flushImageCacheWrites(account);
});
