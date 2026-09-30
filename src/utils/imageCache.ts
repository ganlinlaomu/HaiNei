import { imageCacheRepository } from "@/repositories/imageCacheRepository";
import { logger } from "@/utils/logger";

// Cache expiration time: 7 days in milliseconds
const CACHE_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Store decrypted image in cache
 */
export async function storeImageInCache(
  accountPubkey: string,
  url: string,
  blob: Blob,
  mime: string
): Promise<void> {
  // Decrypted images are kept only in component memory and revoked on unmount.
  void accountPubkey; void url; void blob; void mime;
}

/**
 * Get decrypted image from cache if available and not expired
 */
export async function getImageFromCache(
  accountPubkey: string,
  url: string
): Promise<{ blob: Blob; mime: string } | null> {
  void accountPubkey; void url;
  return null;
}

/**
 * Clear all expired cache entries
 */
export async function clearExpiredCache(accountPubkey: string): Promise<number> {
  try {
    const deleted = await imageCacheRepository.deleteExpired(
      accountPubkey,
      Date.now() - CACHE_EXPIRATION_MS
    );
    if (deleted > 0) logger.info(`Cleared ${deleted} expired cache entries`);
    return deleted;
  } catch (e) {
    logger.warn("Failed to clear expired cache", e);
    return 0;
  }
}

/**
 * Clear all image cache
 */
export async function clearAllCache(accountPubkey: string): Promise<void> {
  try {
    await imageCacheRepository.clear(accountPubkey);
    logger.info(`Cleared image cache for account=${accountPubkey.slice(0, 8)}`);
  } catch (e) {
    logger.warn("Failed to clear all cache", e);
  }
}

/**
 * Get cache statistics
 */
export async function getCacheStats(accountPubkey: string): Promise<{
  count: number;
  size: number;
  oldestTimestamp: number;
}> {
  try {
    const entries = await imageCacheRepository.list(accountPubkey);
    const count = entries.length;
    let size = 0;
    let oldestTimestamp = 0;

    for (const entry of entries) {
      size += entry.blob.size;
      if (oldestTimestamp === 0 || entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
      }
    }

    return { count, size, oldestTimestamp };
  } catch (e) {
    logger.warn("Failed to get cache stats", e);
    return { count: 0, size: 0, oldestTimestamp: 0 };
  }
}
