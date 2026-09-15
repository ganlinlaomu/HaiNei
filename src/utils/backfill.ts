/**
 * Nostr Backfill and Batch Fetching Utility
 * 
 * Implements a generic backfill strategy for Nostr events with:
 * - Time-based pagination (backward from newest to oldest)
 * - Author batching (to avoid overwhelming relays)
 * - Breakpoint tracking (for incremental fetches)
 * - Configurable limits and time windows
 */

import { subscribe } from "@/nostr/relays";
import { logger } from "@/utils/logger";
import { closeSubscription } from "@/utils/closeSubscription";

export const SYNC_OVERLAP_SECONDS = 300;

export type BackfillFilter = {
  kinds: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  [key: string]: any; // Allow additional filter properties like '#g', '#p', etc.
};

export type BackfillOptions = {
  relays: string[];
  filters: BackfillFilter;
  onEvent: (event: any) => Promise<void> | void;
  onProgress?: (stats: BackfillStats) => void;
  onComplete?: (stats: BackfillStats) => void;
  maxBatches?: number; // Maximum number of batches to fetch (default: unlimited)
  batchSize?: number; // Number of events per batch (limit)
  authorBatchSize?: number; // Number of authors per batch (default: 50)
  timeoutMs?: number; // Timeout per batch in milliseconds (default: 10000)
};

export type BackfillStats = {
  totalEvents: number;
  batchesFetched: number;
  oldestTimestamp: number;
  latestTimestamp: number;
  completed: boolean;
};

/**
 * Batch authors into smaller groups to avoid overloading relays
 */
function batchAuthors(authors: string[], batchSize: number): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < authors.length; i += batchSize) {
    batches.push(authors.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * Fetch events with time-based pagination (backward)
 * 
 * This function implements backward time pagination:
 * - Starts from `until` (or current time if not provided)
 * - Fetches events in batches with `limit`
 * - Keeps the oldest timestamp inclusive and de-duplicates by event ID
 * - Continues until `since` is reached or no more events
 */
export async function backfillEvents(options: BackfillOptions): Promise<BackfillStats> {
  const {
    relays,
    filters,
    onEvent,
    onProgress,
    onComplete,
    maxBatches = Infinity,
    batchSize = 500,
    authorBatchSize = 50,
    timeoutMs = 10000
  } = options;

  const stats: BackfillStats = {
    totalEvents: 0,
    batchesFetched: 0,
    oldestTimestamp: 0, // Changed from Infinity to 0
    latestTimestamp: 0,
    completed: false
  };

  // Check if authors field exists and has values
  const hasAuthors = Array.isArray(filters.authors) && filters.authors.length > 0;
  
  // If authors are provided, batch them; otherwise, use a single batch with no authors
  const authorBatches = hasAuthors 
    ? batchAuthors(filters.authors!, authorBatchSize)
    : [undefined];

  const targetSince = filters.since || 0;
  const initialUntil = filters.until || Math.floor(Date.now() / 1000);
  const seenEventIds = new Set<string>();
  
  // Log differently based on whether we have authors or not
  if (hasAuthors) {
    logger.info(`开始回填: kinds=[${filters.kinds.join(',')}], 作者批次数=${authorBatches.length}, 每批作者数=${authorBatches[0]!.length}`);
  } else {
    // For non-author filters (e.g., #p, #e, #g), log the actual filter keys
    const filterKeys = Object.keys(filters).filter(k => k.startsWith('#')).join(', ');
    logger.info(`开始回填: kinds=[${filters.kinds.join(',')}], 过滤条件=${filterKeys || '无标签过滤'}`);
  }
  logger.info(`时间范围: since=${new Date(targetSince * 1000).toLocaleString()} (${targetSince}), until=${new Date(initialUntil * 1000).toLocaleString()} (${initialUntil})`);

  // Process each author batch (or single batch for non-author filters)
  for (let authorBatchIdx = 0; authorBatchIdx < authorBatches.length; authorBatchIdx++) {
    const authorBatch = authorBatches[authorBatchIdx];
    
    // Log batch processing - differentiate between author and non-author filters
    if (hasAuthors && authorBatch) {
      logger.info(`处理作者批次 ${authorBatchIdx + 1}/${authorBatches.length} (${authorBatch.length}个作者)`);
    } else if (authorBatches.length === 1) {
      // Single batch for non-author filters (e.g., #p)
      logger.info(`处理回填批次 (非作者过滤)`);
    }
    
    // Each author batch starts from the initial until time and pages backward
    let currentUntil = initialUntil;
    let batchCount = 0;

    // Continue fetching batches for this author group
    while (batchCount < maxBatches) {
      if (currentUntil < targetSince) {
        logger.info(`已到达时间边界，停止回填`);
        break;
      }

      // Build filter for this batch
      const batchFilter: BackfillFilter = {
        ...filters,
        limit: batchSize,
        until: currentUntil,
        since: targetSince
      };

      // Add authors for this batch if present
      if (authorBatch) {
        batchFilter.authors = authorBatch;
      }

      // Log the actual filter being sent for debugging
      const filterSummary: Record<string, any> = {
        kinds: batchFilter.kinds,
        since: new Date(targetSince * 1000).toISOString(),
        until: new Date(currentUntil * 1000).toISOString(),
        limit: batchSize
      };
      
      // Add author count or tag filters to summary
      if (batchFilter.authors) {
        filterSummary.authors = `${batchFilter.authors.length} authors`;
      }
      Object.keys(batchFilter).forEach(key => {
        if (key.startsWith('#')) {
          const tagValues = batchFilter[key];
          filterSummary[key] = Array.isArray(tagValues) ? `${tagValues.length} values` : tagValues;
        }
      });
      
      logger.debug(`发送批次 #${batchCount + 1} REQ:`, JSON.stringify(filterSummary));

      // Fetch events for this batch
      const batchEvents: any[] = [];
      let oldestInBatch = currentUntil;

      try {
        await new Promise<void>((resolve) => {
          const sub = subscribe(relays, [batchFilter]);
          const expectedRelays = new Set(relays);
          const completedRelays = new Set<string>();
          let resolved = false;

          const finish = (reason: "eose" | "timeout" | "no-relays") => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeoutId);
            closeSubscription(sub);
            logger.info(
              `[backfill] batch complete reason=${reason} eose=${completedRelays.size}/${expectedRelays.size} since=${targetSince} until=${currentUntil}`
            );
            resolve();
          };
          
          const timeoutId = setTimeout(() => {
            finish("timeout");
          }, timeoutMs);

          sub.on("event", (evt: any) => {
            batchEvents.push(evt);
            if (evt.created_at < oldestInBatch) {
              oldestInBatch = evt.created_at;
            }
          });

          sub.on("eose", (relayUrl: string) => {
            completedRelays.add(relayUrl);
            logger.debug(`[backfill] EOSE relay=${relayUrl} count=${completedRelays.size}/${expectedRelays.size}`);
            if (completedRelays.size >= expectedRelays.size) finish("eose");
          });

          if (expectedRelays.size === 0) finish("no-relays");
        });

        // Process events in this batch
        let newUniqueEventsThisBatch = 0;
        for (const evt of batchEvents) {
          if (!evt?.id || seenEventIds.has(evt.id)) continue;
          seenEventIds.add(evt.id);
          newUniqueEventsThisBatch++;
          try {
            await onEvent(evt);
            stats.totalEvents++;
            
            // Track timestamp range (only update if we have valid events)
            if (evt.created_at && typeof evt.created_at === 'number') {
              if (stats.oldestTimestamp === 0 || evt.created_at < stats.oldestTimestamp) {
                stats.oldestTimestamp = evt.created_at;
              }
              if (evt.created_at > stats.latestTimestamp) {
                stats.latestTimestamp = evt.created_at;
              }
            }
          } catch (e) {
            logger.warn(`[backfill] event processing failed event=${evt.id?.slice(0, 8)}`, e);
          }
        }

        stats.batchesFetched++;
        batchCount++;

        // Report progress
        if (onProgress) {
          onProgress({ ...stats, completed: false });
        }

        logger.info(`[backfill] batch=${batchCount} received=${batchEvents.length} unique=${newUniqueEventsThisBatch} until=${currentUntil}`);

        // Check if we should continue
        if (batchEvents.length === 0) {
          logger.info(`没有更多事件，停止回填`);
          break;
        }

        if (batchEvents.length < batchSize) {
          logger.info(`获取到的事件少于限制，可能已到末尾`);
          break;
        }

        // Keep the boundary second inclusive: relays may have more events sharing it.
        if (oldestInBatch === currentUntil && newUniqueEventsThisBatch === 0) {
          logger.warn(`[backfill] stop stalled pagination until=${currentUntil}`);
          break;
        }
        currentUntil = oldestInBatch;

      } catch (e) {
        logger.error(`批次 #${batchCount + 1} 失败`, e);
        break;
      }
    }
  }

  stats.completed = true;
  
  logger.info(`回填完成: ${stats.totalEvents} 个事件, ${stats.batchesFetched} 个批次`);
  
  if (onComplete) {
    onComplete(stats);
  }

  return stats;
}

/**
 * Fetch friend lists (kind 3 or kind 30000) with batching
 * 
 * This is optimized for fetching contact/friend lists from multiple authors.
 * Since these are replaceable events, we only need the latest one per author.
 */
export async function backfillFriendLists(options: {
  relays: string[];
  authors: string[];
  kind?: number; // Default: 30000 (NIP-51 People List)
  dTag?: string; // For kind 30000, specify d tag (e.g., "close-friends")
  onEvent: (event: any) => Promise<void> | void;
  onProgress?: (fetched: number, total: number) => void;
  authorBatchSize?: number;
  timeoutMs?: number;
}): Promise<number> {
  const {
    relays,
    authors,
    kind = 30000,
    dTag,
    onEvent,
    onProgress,
    authorBatchSize = 50,
    timeoutMs = 10000
  } = options;

  const authorBatches = batchAuthors(authors, authorBatchSize);
  let totalFetched = 0;

  logger.info(`获取好友列表: ${authors.length} 个作者, ${authorBatches.length} 个批次`);

  for (let i = 0; i < authorBatches.length; i++) {
    const batch = authorBatches[i];
    
    const filter: any = {
      kinds: [kind],
      authors: batch,
      limit: batch.length // One per author max
    };

    // Add d tag for parameterized replaceable events (kind 30000-39999)
    if (kind >= 30000 && kind <= 39999 && dTag) {
      filter["#d"] = [dTag];
    }

    try {
      const batchEvents: any[] = [];
      
      await new Promise<void>((resolve) => {
        const sub = subscribe(relays, [filter]);
        const expectedRelays = new Set(relays);
        const completedRelays = new Set<string>();
        let resolved = false;
        const finish = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeoutId);
          closeSubscription(sub);
          resolve();
        };
        const timeoutId = setTimeout(() => {
          finish();
        }, timeoutMs);

        sub.on("event", (evt: any) => {
          batchEvents.push(evt);
        });

        sub.on("eose", (relayUrl: string) => {
          completedRelays.add(relayUrl);
          if (completedRelays.size >= expectedRelays.size) finish();
        });

        if (expectedRelays.size === 0) finish();
      });

      // Process events
      for (const evt of batchEvents) {
        try {
          await onEvent(evt);
          totalFetched++;
        } catch (e) {
          logger.warn(`[backfill] friend event processing failed event=${evt.id?.slice(0, 8)}`, e);
        }
      }

      if (onProgress) {
        onProgress(totalFetched, authors.length);
      }

      logger.info(`好友列表批次 ${i + 1}/${authorBatches.length}: ${batchEvents.length} 个事件`);

    } catch (e) {
      logger.error(`好友列表批次 ${i + 1} 失败`, e);
    }
  }

  logger.info(`好友列表获取完成: ${totalFetched} 个列表`);
  return totalFetched;
}

/**
 * Save breakpoint for incremental backfill
 */
export function saveBackfillBreakpoint(key: string, timestamp: number) {
  try {
    localStorage.setItem(`backfill_breakpoint_${key}`, String(timestamp));
  } catch (e) {
    logger.warn("保存回填断点失败", e);
  }
}

/**
 * Load breakpoint for incremental backfill
 */
export function loadBackfillBreakpoint(key: string): number | null {
  try {
    const raw = localStorage.getItem(`backfill_breakpoint_${key}`);
    if (raw) {
      const ts = parseInt(raw, 10);
      return isNaN(ts) ? null : ts;
    }
  } catch (e) {
    logger.warn("加载回填断点失败", e);
  }
  return null;
}
