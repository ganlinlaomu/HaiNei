import { imageCacheRepository } from "@/repositories/imageCacheRepository";
import { onBeforeAccountLock } from "@/services/accountLifecycle";
import { logger } from "@/utils/logger";

export const MEMORY_IMAGE_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const CACHE_EXPIRATION_MS = 30 * 60 * 1000;

type MemoryImageEntry = {
  blob: Blob;
  mime: string;
  timestamp: number;
  lastAccessedAt: number;
};

const memoryByAccount = new Map<string, Map<string, MemoryImageEntry>>();

function normalizeAccount(accountPubkey: string) {
  return accountPubkey.trim().toLowerCase();
}

function accountCache(accountPubkey: string, create = false) {
  const account = normalizeAccount(accountPubkey);
  let cache = memoryByAccount.get(account);
  if (!cache && create) {
    cache = new Map();
    memoryByAccount.set(account, cache);
  }
  return cache;
}

function cacheBytes(cache: Map<string, MemoryImageEntry>) {
  let size = 0;
  for (const entry of cache.values()) size += entry.blob.size;
  return size;
}

function touch(cache: Map<string, MemoryImageEntry>, key: string, entry: MemoryImageEntry) {
  entry.lastAccessedAt = Date.now();
  cache.delete(key);
  cache.set(key, entry);
}

function evictToLimit(cache: Map<string, MemoryImageEntry>) {
  let size = cacheBytes(cache);
  while (size > MEMORY_IMAGE_CACHE_MAX_BYTES && cache.size) {
    const oldest = cache.entries().next().value as [string, MemoryImageEntry] | undefined;
    if (!oldest) break;
    cache.delete(oldest[0]);
    size -= oldest[1].blob.size;
  }
}

export async function storeImageInCache(
  accountPubkey: string,
  url: string,
  blob: Blob,
  mime: string
): Promise<void> {
  if (!accountPubkey || !url || !blob.size || blob.size > MEMORY_IMAGE_CACHE_MAX_BYTES) return;
  const cache = accountCache(accountPubkey, true)!;
  const now = Date.now();
  cache.delete(url);
  cache.set(url, { blob, mime, timestamp: now, lastAccessedAt: now });
  evictToLimit(cache);
}

export async function getImageFromCache(
  accountPubkey: string,
  url: string
): Promise<{ blob: Blob; mime: string } | null> {
  const cache = accountCache(accountPubkey);
  const entry = cache?.get(url);
  if (!cache || !entry) return null;
  if (Date.now() - entry.lastAccessedAt > CACHE_EXPIRATION_MS) {
    cache.delete(url);
    if (cache.size === 0) memoryByAccount.delete(normalizeAccount(accountPubkey));
    return null;
  }
  touch(cache, url, entry);
  return { blob: entry.blob, mime: entry.mime };
}

export async function clearExpiredCache(accountPubkey: string): Promise<number> {
  const cache = accountCache(accountPubkey);
  let deleted = 0;
  if (cache) {
    const cutoff = Date.now() - CACHE_EXPIRATION_MS;
    for (const [key, entry] of cache) {
      if (entry.lastAccessedAt >= cutoff) continue;
      cache.delete(key);
      deleted += 1;
    }
    if (cache.size === 0) memoryByAccount.delete(normalizeAccount(accountPubkey));
  }

  // Remove legacy plaintext disk cache left by older HaiNei builds. New
  // decrypted media is never persisted here.
  try {
    deleted += await imageCacheRepository.deleteExpired(accountPubkey, Date.now());
  } catch (error) {
    logger.warn("Failed to clear legacy image cache", error);
  }
  return deleted;
}

export function clearMemoryImageCache(accountPubkey: string): void {
  if (!accountPubkey) return;
  memoryByAccount.delete(normalizeAccount(accountPubkey));
}

export async function clearAllCache(accountPubkey: string): Promise<void> {
  clearMemoryImageCache(accountPubkey);
  try {
    await imageCacheRepository.clear(accountPubkey);
    logger.info(`Cleared memory and legacy image cache for account=${accountPubkey.slice(0, 8)}`);
  } catch (e) {
    logger.warn("Failed to clear legacy image cache", e);
  }
}

export async function getCacheStats(accountPubkey: string): Promise<{
  count: number;
  size: number;
  oldestTimestamp: number;
  maxSize: number;
}> {
  const cache = accountCache(accountPubkey);
  if (!cache) return { count: 0, size: 0, oldestTimestamp: 0, maxSize: MEMORY_IMAGE_CACHE_MAX_BYTES };

  let size = 0;
  let oldestTimestamp = 0;
  for (const entry of cache.values()) {
    size += entry.blob.size;
    if (oldestTimestamp === 0 || entry.timestamp < oldestTimestamp) oldestTimestamp = entry.timestamp;
  }
  return { count: cache.size, size, oldestTimestamp, maxSize: MEMORY_IMAGE_CACHE_MAX_BYTES };
}

onBeforeAccountLock(account => {
  clearMemoryImageCache(account);
});
