import { imageCacheRepository } from "@/repositories/imageCacheRepository";
import { logger } from "@/utils/logger";

export const IMAGE_MEMORY_CACHE_MAX_BYTES = 48 * 1024 * 1024;

type MemoryImageEntry = {
  blob: Blob;
  mime: string;
  timestamp: number;
  lastAccess: number;
};

const memoryByAccount = new Map<string, Map<string, MemoryImageEntry>>();
const bytesByAccount = new Map<string, number>();

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

export async function storeImageInCache(
  accountPubkey: string,
  url: string,
  blob: Blob,
  mime: string
): Promise<void> {
  if (!accountPubkey || !url || !blob?.size) return;
  const { account, cache } = accountCache(accountPubkey);
  const previous = cache.get(url);
  let total = bytesByAccount.get(account) || 0;
  if (previous) total -= previous.blob.size;
  const now = Date.now();
  cache.set(url, { blob, mime, timestamp: now, lastAccess: now });
  bytesByAccount.set(account, total + blob.size);
  evictToLimit(account, cache);
}

export async function getImageFromCache(
  accountPubkey: string,
  url: string
): Promise<{ blob: Blob; mime: string } | null> {
  const cache = memoryByAccount.get(accountKey(accountPubkey));
  const entry = cache?.get(url);
  if (!entry) return null;
  entry.lastAccess = Date.now();
  cache!.delete(url);
  cache!.set(url, entry);
  return { blob: entry.blob, mime: entry.mime };
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
  // Session memory cache is LRU-bounded and cleared at lock/logout. The old
  // persistent decrypted-image table is only retained for one-way cleanup.
  try {
    return await imageCacheRepository.clear(accountPubkey);
  } catch (e) {
    logger.warn("Failed to clear legacy persistent image cache", e);
    return 0;
  }
}

export async function clearAllCache(accountPubkey: string): Promise<void> {
  clearMemoryImageCache(accountPubkey);
  try {
    await imageCacheRepository.clear(accountPubkey);
    logger.info(`Cleared image cache for account=${accountPubkey.slice(0, 8)}`);
  } catch (e) {
    logger.warn("Failed to clear legacy image cache", e);
  }
}

export async function getCacheStats(accountPubkey: string): Promise<{
  count: number;
  size: number;
  oldestTimestamp: number;
}> {
  const cache = memoryByAccount.get(accountKey(accountPubkey));
  if (!cache?.size) return { count: 0, size: 0, oldestTimestamp: 0 };
  let size = 0;
  let oldestTimestamp = 0;
  for (const entry of cache.values()) {
    size += entry.blob.size;
    if (!oldestTimestamp || entry.timestamp < oldestTimestamp) oldestTimestamp = entry.timestamp;
  }
  return { count: cache.size, size, oldestTimestamp };
}
